import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { realCertHolderCondition } from "../utils/certificateDataQuality.js"
import { logger } from "../utils/logger.js"
import { errorResult, groupByKey, textResult } from "../utils/mcpHelpers.js"

const INCLUDE_OPTIONS = [
  "contacts",
  "dependents",
  "loss_history",
  "attributes",
  "relationships",
  "xrefs",
  "expiring_business",
  "service_team",
  "certificates",
  "policies"
] as const

type Include = typeof INCLUDE_OPTIONS[number]

const INCLUDE_QUERIES: Record<Include, string> = {
  contacts: `
    SELECT custid, ccntid, contactname, title, isofficer, isdirector,
      email, busareacode, busphone, resareacode, resphone, mobileareacode, mobilephone,
      contactmethod, notes
    FROM afw_custcontact
    WHERE custid = ANY($1::uuid[])
    ORDER BY contactname
  `,
  dependents: `
    SELECT custid, depdid, firstname, midname, lastname, dob, relationship,
      occupation, married, educationlevel, email
    FROM afw_dependent
    WHERE custid = ANY($1::uuid[])
    ORDER BY lastname, firstname
  `,
  loss_history: `
    SELECT custid, closshistid, claimid, company, polno, kindofloss, lineofbus,
      poleffdate, polexpdate, amountpaid, dateofloss, claimstatus, claimno, closeddate,
      lossdescclhis
    FROM afw_custlosshist
    WHERE custid = ANY($1::uuid[])
    ORDER BY dateofloss DESC
  `,
  attributes: `
    SELECT a.custid, t.customerattributetypename AS attribute_name,
      a.customerattributevalue AS attribute_value, t.customerattributetypedatatype AS data_type
    FROM afw_customerattribute a
    JOIN afw_customerattributetype t ON a.customerattributetypeid = t.customerattributetypeid
    WHERE a.custid = ANY($1::uuid[])
    ORDER BY t.customerattributetypename
  `,
  relationships: `
    SELECT cr.custid, r.relationshipdescription, cr.role,
      rt.category, rt.relationshiptypedescription, rt.primary AS primary_label, rt.secondary AS secondary_label
    FROM afw_customerrelationship cr
    JOIN afw_relationship r ON cr.relationshipid = r.relationshipid
    LEFT JOIN afw_relationshiptype rt ON r.relationshiptypeid = rt.relationshiptypeid
    WHERE cr.custid = ANY($1::uuid[])
  `,
  xrefs: `
    SELECT x.custid, x.xreference, t.description AS xref_type_description
    FROM afw_custxref x
    JOIN afw_agencyxreftype t ON x.axrefid = t.axrefid
    WHERE x.custid = ANY($1::uuid[])
  `,
  expiring_business: `
    SELECT custid, xdatid, lineofbus, policyno, expdate, coname, agent,
      premium, acctsize, interestlevel, remarks
    FROM afw_xdate
    WHERE custid = ANY($1::uuid[])
    ORDER BY expdate
  `,
  service_team: `
    SELECT p.custid, e.empcode, e.lastname AS employee_lastname, e.firstname AS employee_firstname,
      p.typeofemp, p.typeofbus, p.isprimary
    FROM afw_custaddpersonnel p
    LEFT JOIN afw_employee e ON p.empcode = e.empcode
    WHERE p.custid = ANY($1::uuid[])
  `,
  // Lightweight per-customer view of certificate_lookup's core result — current holder only (via
  // the same LATERAL "latest afw_certholderinfo row" pattern), not the full reissue history. Use
  // certificate_lookup directly (with include: ["holder_history"]) for that or for the up-to-9
  // covered-policies detail this include intentionally omits to stay a quick related-record list.
  certificates: `
    SELECT clp.custid, clp.crtid, clp.crtno, clp.certformtype, clp.descofopslocs,
      ch.name1crth AS current_holder_name, ch.citycrth AS current_holder_city, ch.statecrth AS current_holder_state,
      ch.certissuedatecrth AS current_holder_cert_issue_date,
      clp.entereddate
    FROM afw_certliabprop clp
    LEFT JOIN LATERAL (
      SELECT * FROM afw_certholderinfo chi
      WHERE chi.crtid = clp.crtid AND ${ realCertHolderCondition("chi") }
      ORDER BY chi.certissuedatecrth DESC NULLS LAST, chi.entereddate DESC
      LIMIT 1
    ) ch ON true
    WHERE clp.custid = ANY($1::uuid[])
    ORDER BY clp.entereddate DESC
  `,
  // Lightweight view of the customer's current book — same "in force today" definition as
  // policy_query's renewalrptflag='A' filter and book_summary's current_policies (excludes
  // submission shells, status='D' rows, and bound-but-not-yet-started/already-expired terms).
  // `premium` mirrors book_summary's COALESCE logic: afw_cprem's coverage-line premium sum where
  // that detail exists (commercial, written through AMS360's detailed rating workflow), falling
  // back to fulltermpremium otherwise. Use policy_query directly (with include: ["premiums"]) for
  // the underlying coverage-line breakdown or to see expired/prior terms — this is current-only.
  policies: `
    SELECT p.custid, p.polid, p.polno, p.status, p.poltype, p.polsubtype, p.typeofbus,
      p.poleffdate, p.polexpdate, p.cocode, co.name AS carrier_name,
      COALESCE(
        (
          SELECT SUM(c.premium) FROM (
            SELECT cp.premium, cp.status,
              ROW_NUMBER() OVER (PARTITION BY cp.lobid, cp.cpremid ORDER BY cp.effdate DESC) AS rn
            FROM afw_cprem cp WHERE cp.polid = p.polid
          ) c WHERE c.rn = 1 AND c.status != 'D'
        ),
        p.fulltermpremium
      ) AS premium
    FROM afw_basicpolinfo p
    LEFT JOIN afw_company co ON p.cocode = co.cocode
    WHERE p.custid = ANY($1::uuid[])
      AND p.renewalrptflag = 'A' AND p.polsubtype != 'S' AND p.status != 'D'
      AND p.poleffdate <= now() AND p.polexpdate >= now()
    ORDER BY p.custid, p.poleffdate DESC
  `
}

// typecust is NOT afw_prcode-backed — the AMS360 Database Design Guide hardcodes this small,
// fixed value set directly in prose rather than delegating to afw_prcode (confirmed with
// postgres-mcp-9f against the Guide text) — resolves via `_code_lookup`, a small hand-maintained
// table (not synced from AMS360, deliberately not `afw_`-prefixed) built for exactly this category
// of column (see policy_query's polsubtype/cotype for the other members of this category).
const CORE_QUERY = `
  SELECT
    c.custid, c.custno, c.lastname, c.firstname, c.dba, c.firmnamecust,
    c.typecust, tcust.description AS typecust_description,
    c.typeentity, c.active,
    c.addr1, c.addr2, c.city, c.state, c.zipcode, c.country,
    c.resareacode, c.resphone, c.busareacode, c.busphone, c.email,
    c.mastersubtype, ms.description AS mastersubtype_description, c.mastercustid,
    c.prod1code, prod.lastname AS producer_lastname, prod.firstname AS producer_firstname,
    c.csrcode, csr.lastname AS csr_lastname, csr.firstname AS csr_firstname,
    c.brokercode, br.lastname AS broker_lastname, br.firstname AS broker_firstname, br.shortname AS broker_shortname,
    c.anotid, an.description AS notation_description,
    c.gldivcode, gld.name AS gldivision_name,
    c.glbrnchcode, glb.name AS glbranch_name,
    c.gldeptcode, gldep.name AS gldepartment_name,
    c.glgrpcode, glg.name AS glgroup_name,
    c.changedby, c.changeddate, c.entereddate
  FROM afw_customer c
  LEFT JOIN _code_lookup tcust ON tcust.category = 'typecust' AND tcust.code = c.typecust
  LEFT JOIN afw_prcode ms ON rtrim(ms.attrcode) = 'ME' AND ms.code = c.mastersubtype
  LEFT JOIN afw_employee prod ON c.prod1code = prod.empcode
  LEFT JOIN afw_employee csr ON c.csrcode = csr.empcode
  LEFT JOIN afw_broker br ON c.brokercode = br.brokercode
  LEFT JOIN afw_agencynotation an ON c.anotid = an.anotid
  LEFT JOIN afw_generalledgerdivision gld ON c.gldivcode = gld.gldivcode
  LEFT JOIN afw_generalledgerbranch glb ON c.glbrnchcode = glb.glbrnchcode
  LEFT JOIN afw_generalledgerdepartment gldep ON c.gldeptcode = gldep.gldeptcode
  LEFT JOIN afw_generalledgergroup glg ON c.glgrpcode = glg.glgrpcode
`

const SORT_OPTIONS = {
  lastname_asc: "c.lastname ASC, c.firstname ASC",
  lastname_desc: "c.lastname DESC, c.firstname DESC",
  custno_asc: "c.custno ASC",
  custno_desc: "c.custno DESC",
  entereddate_asc: "c.entereddate ASC",
  entereddate_desc: "c.entereddate DESC"
} as const

type Sort = keyof typeof SORT_OPTIONS

export function registerCustomerLookupTool(server: McpServer) {
  server.registerTool(
    "customer_lookup",
    {
      description: "Look up customer(s) by ID or customer number, or browse/search customers by name and coarse filters (active, city, state, producer, CSR), with sorting and pagination. With no filters at all, returns a paginated list of all customers. Resolves producer/CSR/broker/GL names inline. Optionally include related records (contacts, dependents, loss history, attributes, relationships, cross-references, expiring outside business, service team, certificates of insurance, current policies). The `certificates` include is a lightweight view (current holder only, per certificate) — use the dedicated `certificate_lookup` tool for full reissue history or the up-to-9 covered-policies detail. The `policies` include is likewise a lightweight, current-only view (policy number, carrier, dates, premium) of the customer's in-force book — use `policy_query` directly (`custid` filter, or `include: [\"premiums\"]`) for expired/prior terms or coverage-line-level pricing detail. IMPORTANT: for a commercial/business customer, `lastname`/`firstname`/`dba` are often all null — use `firmnamecust` (the business name) as the display name in that case; the `name` filter already searches it alongside lastname/firstname/dba. IMPORTANT: `custid` (and every other `*id` field this tool or its includes return — `ccntid`, `depdid`, `closshistid`, `claimid`, `crtid`, `anotid`) is an internal AMS360 identifier (UUID) with no meaning to an end user — never surface it in an answer. Use the resolved name, `custno`, or another human-readable field instead; these ids exist only to chain to other tool calls (e.g. pass `custid` to `policy_query`).",
      inputSchema: {
        custid: z.string().uuid().describe("Exact customer ID (afw_customer.custid)").optional(),
        custno: z.number().int().describe("Exact customer number (afw_customer.custno)").optional(),
        name: z.string().describe("Partial match against last name, first name, or DBA").optional(),
        active: z.enum(["Y", "N"]).describe("Filter by active status").optional(),
        city: z.string().describe("Partial match against city").optional(),
        state: z.string().length(2).describe("Exact 2-letter state code").optional(),
        producer_code: z.string().describe("Exact match against producer employee code (afw_customer.prod1code)").optional(),
        csr_code: z.string().describe("Exact match against CSR employee code (afw_customer.csrcode)").optional(),
        sort: z.enum(Object.keys(SORT_OPTIONS) as [Sort, ...Sort[]]).default("lastname_asc").describe("Sort order, ignored when custid/custno is given"),
        offset: z.number().int().min(0).default(0).describe("Number of customers to skip, ignored when custid/custno is given"),
        include: z.array(z.enum(INCLUDE_OPTIONS)).describe("Related record sets to attach to each customer").optional(),
        limit: z.number().int().min(1).max(50).default(10).describe("Max customers to return per page")
      }
    },
    async ({ custid, custno, name, active, city, state, producer_code, csr_code, sort, offset, include, limit }) => {
      try {
        let sql: string
        let params: unknown[]
        let hasMore = false

        if(custid || custno) {
          const whereClause = custid ? "c.custid = $1" : "c.custno = $1"
          params = [custid ?? custno]
          sql = `${ CORE_QUERY } WHERE ${ whereClause }`
        } else {
          const conditions: string[] = []
          params = []

          if(name) {
            params.push(`%${ name }%`)
            conditions.push(`(c.lastname ILIKE $${ params.length } OR c.firstname ILIKE $${ params.length } OR c.dba ILIKE $${ params.length } OR c.firmnamecust ILIKE $${ params.length })`)
          }
          if(active) {
            params.push(active)
            conditions.push(`c.active = $${ params.length }`)
          }
          if(city) {
            params.push(`%${ city }%`)
            conditions.push(`c.city ILIKE $${ params.length }`)
          }
          if(state) {
            params.push(state.toUpperCase())
            conditions.push(`c.state = $${ params.length }`)
          }
          if(producer_code) {
            params.push(producer_code)
            conditions.push(`c.prod1code = $${ params.length }`)
          }
          if(csr_code) {
            params.push(csr_code)
            conditions.push(`c.csrcode = $${ params.length }`)
          }

          const whereClause = conditions.length ? `WHERE ${ conditions.join(" AND ") }` : ""

          sql = `${ CORE_QUERY } ${ whereClause } ORDER BY ${ SORT_OPTIONS[sort] } LIMIT ${ limit + 1 } OFFSET ${ offset }`
        }

        let customers = await runReadOnlyQuery(sql, params)

        if(!custid && !custno && customers.length > limit) {
          hasMore = true
          customers = customers.slice(0, limit)
        }

        if(customers.length === 0) {
          return textResult({ customers: [], has_more: false })
        }

        const custids = customers.map((row) => row.custid)

        const includedData: Partial<Record<Include, Map<string, unknown[]>>> = {}

        for(const key of include ?? []) {
          const rows = await runReadOnlyQuery(INCLUDE_QUERIES[key], [custids])
          includedData[key] = groupByKey(rows as Record<string, unknown>[], "custid")
        }

        const results = customers.map((customer) => {
          const included: Partial<Record<Include, unknown[]>> = {}

          for(const key of include ?? []) {
            included[key] = includedData[key]?.get(String(customer.custid)) ?? []
          }

          return include?.length ? { ...customer, included } : customer
        })

        return textResult({ customers: results, has_more: hasMore })
      } catch(error) {
        logger.error({ err: error, custid, custno, name, active, city, state, producer_code, csr_code, sort, offset, include }, "customer_lookup failed")
        return errorResult(error)
      }
    }
  )
}
