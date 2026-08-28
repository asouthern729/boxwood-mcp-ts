import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { logger } from "../utils/logger.js"
import { errorResult, groupByKey, textResult } from "../utils/mcpHelpers.js"

const INCLUDE_OPTIONS = [
  "transactions",
  "lines_of_business",
  "coverage",
  "personnel",
  "submissions",
  "attributes",
  "contacts"
] as const

type Include = typeof INCLUDE_OPTIONS[number]

const INCLUDE_QUERIES: Record<Include, string> = {
  transactions: `
    SELECT polid, effdate, trantype, description, source, billmethodpolt,
      instdaypolt, reasonpolt, premoneffdate, isposted, annualizedpremium, annualizedestrevenue,
      changeddate
    FROM afw_policytransaction
    WHERE polid = ANY($1::uuid[])
    ORDER BY polid, effdate DESC
  `,
  lines_of_business: `
    SELECT l.polid, l.lobid, l.lineofbus, lo.descriptionlobs AS lob_description,
      l.plantype, l.stateplantype, l.writingcocode, l.effdate, l.expdate, l.description
    FROM afw_lineofbusiness l
    LEFT JOIN afw_lobsetup lo ON l.lineofbus = lo.namelobs
    WHERE l.polid = ANY($1::uuid[])
    ORDER BY l.polid, l.sortno
  `,
  coverage: `
    SELECT polid, lobid, coverageid, coveragecode, descrcov, limit1, limit2, limit3,
      deduct1, deduct2, deduct3, fulltermprem, effdate, expdate, status
    FROM afw_coverage
    WHERE polid = ANY($1::uuid[])
    ORDER BY polid, sortno
  `,
  personnel: `
    SELECT p.polid, p.empcode, e.lastname AS employee_lastname, e.firstname AS employee_firstname,
      p.emptype, p.isprimary, p.method, p.percentage, p.flatamount, p.position
    FROM afw_policypersonnel p
    LEFT JOIN afw_employee e ON p.empcode = e.empcode
    WHERE p.polid = ANY($1::uuid[])
    ORDER BY p.polid, p.position
  `,
  submissions: `
    SELECT s.polid, s.submid, s.subgrid, sg.groupno, sg.groupdate
    FROM afw_submission s
    LEFT JOIN afw_submissiongroup sg ON s.subgrid = sg.subgrid
    WHERE s.polid = ANY($1::uuid[])
  `,
  attributes: `
    SELECT a.polid, t.policyattributetypename AS attribute_name,
      a.policyattributevalue AS attribute_value, t.policyattributetypedatatype AS data_type
    FROM afw_policyattribute a
    JOIN afw_policyattributetype t ON a.policyattributetypeid = t.policyattributetypeid
    WHERE a.polid = ANY($1::uuid[])
    ORDER BY t.policyattributetypename
  `,
  contacts: `
    SELECT polid, polcid, name, title, responsibility, status,
      areacode, phone, ext, mobileareacode, mobilephone,
      email, contactmethod, notes
    FROM afw_polcontact
    WHERE polid = ANY($1::uuid[])
    ORDER BY polid, name
  `
}

const CORE_QUERY = `
  SELECT
    p.polid, p.polno, p.shortpolno, p.status, p.renewalrptflag, p.typeofbus, p.poltype, p.polsubtype,
    p.poleffdate, p.polexpdate, p.iscontinuous, p.billmethod, p.fulltermpremium,
    p.custid, cust.lastname AS customer_lastname, cust.firstname AS customer_firstname, cust.dba AS customer_dba,
    p.cocode, co.name AS carrier_name,
    p.writingcocode, wco.name AS writing_carrier_name,
    p.execcode, exec.lastname AS exec_lastname, exec.firstname AS exec_firstname,
    p.csrcode, csr.lastname AS csr_lastname, csr.firstname AS csr_firstname,
    p.brokercode, br.lastname AS broker_lastname, br.firstname AS broker_firstname, br.shortname AS broker_shortname,
    p.anotid, an.description AS notation_description,
    p.paypid, pp.description AS payment_plan_description,
    p.priorpolid, p.sourcepolid,
    p.gldivcode, gld.name AS gldivision_name,
    p.glbrnchcode, glb.name AS glbranch_name,
    p.gldeptcode, gldep.name AS gldepartment_name,
    p.glgrpcode, glg.name AS glgroup_name,
    p.changedby, p.changeddate, p.entereddate
  FROM afw_basicpolinfo p
  LEFT JOIN afw_customer cust ON p.custid = cust.custid
  LEFT JOIN afw_company co ON p.cocode = co.cocode
  LEFT JOIN afw_company wco ON p.writingcocode = wco.cocode
  LEFT JOIN afw_employee exec ON p.execcode = exec.empcode
  LEFT JOIN afw_employee csr ON p.csrcode = csr.empcode
  LEFT JOIN afw_broker br ON p.brokercode = br.brokercode
  LEFT JOIN afw_agencynotation an ON p.anotid = an.anotid
  LEFT JOIN afw_paymentplan pp ON p.paypid = pp.paypid
  LEFT JOIN afw_generalledgerdivision gld ON p.gldivcode = gld.gldivcode
  LEFT JOIN afw_generalledgerbranch glb ON p.glbrnchcode = glb.glbrnchcode
  LEFT JOIN afw_generalledgerdepartment gldep ON p.gldeptcode = gldep.gldeptcode
  LEFT JOIN afw_generalledgergroup glg ON p.glgrpcode = glg.glgrpcode
`

const SORT_OPTIONS = {
  poleffdate_desc: "p.poleffdate DESC",
  poleffdate_asc: "p.poleffdate ASC",
  polno_asc: "p.polno ASC",
  polno_desc: "p.polno DESC",
  entereddate_asc: "p.entereddate ASC",
  entereddate_desc: "p.entereddate DESC"
} as const

type Sort = keyof typeof SORT_OPTIONS

export function registerPolicyQueryTool(server: McpServer) {
  server.registerTool(
    "policy_query",
    {
      description: "Look up policy/policies by ID, or browse/search policies by policy number, owning customer, and coarse filters (status, type of business, carrier, CSR), with sorting and pagination. With no filters at all, returns a paginated list of all policies. Resolves carrier/producer/CSR/broker/GL names inline. Optionally include related records (transactions, lines of business, coverage, personnel, submissions, attributes, policy-level contacts). IMPORTANT: to find the currently in-force term (of a customer's book, a renewal chain, etc.), filter on `renewalrptflag: \"A\"`, not `status: \"A\"` — `status` does not track renewal-chain lifecycle in this data (most currently in-force terms carry `status='C'`); `renewalrptflag='A'` is the field that actually identifies the live term. Passing `renewalrptflag: \"A\"` also automatically excludes marketing/submission shells, deleted (status='D') rows, and — client-confirmed as of 2026-08-27 — any bound renewal whose effective date is still in the future or whose term has already expired, so the result is genuinely 'in force today,' matching `book_summary`'s definition of current. To see a future-dated renewal that's already bound but hasn't started yet, use `upcoming_renewals` instead — that tool is specifically for renewals with a future effective date and intentionally does not apply this restriction.",
      inputSchema: {
        polid: z.string().uuid().describe("Exact policy ID (afw_basicpolinfo.polid)").optional(),
        polno: z.string().describe("Partial match against policy number or short policy number").optional(),
        custid: z.string().uuid().describe("Filter to policies belonging to this customer").optional(),
        status: z.string().length(1).describe("Exact match against raw AMS360 status code (afw_basicpolinfo.status). NOT a reliable signal for \"current/active\" — despite the name, it doesn't track renewal-chain lifecycle in this data. Use renewalrptflag for that instead.").optional(),
        renewalrptflag: z.string().length(1).describe("Exact match against the renewal-chain lifecycle flag (afw_basicpolinfo.renewalrptflag). Pass \"A\" to get only the currently in-force term of each policy/renewal chain — this is the correct filter for \"current\"/\"active\" policies, not status. Passing \"A\" also excludes submission shells, status='D' rows, and future-dated/already-expired terms (see tool description) — passing any other value does not apply those extra exclusions.").optional(),
        typeofbus: z.number().int().describe("Exact match against type-of-business code (afw_basicpolinfo.typeofbus)").optional(),
        carrier_code: z.string().describe("Exact match against carrier code (afw_basicpolinfo.cocode)").optional(),
        csr_code: z.string().describe("Exact match against CSR employee code (afw_basicpolinfo.csrcode)").optional(),
        sort: z.enum(Object.keys(SORT_OPTIONS) as [Sort, ...Sort[]]).default("poleffdate_desc").describe("Sort order, ignored when polid is given"),
        offset: z.number().int().min(0).default(0).describe("Number of policies to skip, ignored when polid is given"),
        include: z.array(z.enum(INCLUDE_OPTIONS)).describe("Related record sets to attach to each policy").optional(),
        limit: z.number().int().min(1).max(50).default(10).describe("Max policies to return per page")
      }
    },
    async ({ polid, polno, custid, status, renewalrptflag, typeofbus, carrier_code, csr_code, sort, offset, include, limit }) => {
      try {
        let sql: string
        let params: unknown[]
        let hasMore = false

        if(polid) {
          params = [polid]
          sql = `${ CORE_QUERY } WHERE p.polid = $1`
        } else {
          const conditions: string[] = []
          params = []

          if(polno) {
            params.push(`%${ polno }%`)
            conditions.push(`(p.polno ILIKE $${ params.length } OR p.shortpolno ILIKE $${ params.length })`)
          }
          if(custid) {
            params.push(custid)
            conditions.push(`p.custid = $${ params.length }`)
          }
          if(status) {
            params.push(status)
            conditions.push(`p.status = $${ params.length }`)
          }
          if(renewalrptflag) {
            params.push(renewalrptflag)
            conditions.push(`p.renewalrptflag = $${ params.length }`)

            // "A" is specifically a request for "the current/active term" (see tool description)
            // — client-confirmed 2026-08-27 that this must mean genuinely in force today, not just
            // flagged as the latest bound term. Mirrors book_summary's current_policies definition
            // exactly (a bound renewal with a future poleffdate, or a term whose polexpdate has
            // already passed, doesn't count as current even though renewalrptflag='A' alone doesn't
            // distinguish either case). A caller filtering on any other renewalrptflag value is
            // asking a different, non-"current" question, so these extra exclusions don't apply.
            if(renewalrptflag === "A") {
              conditions.push(
                `p.polsubtype != 'S'`,
                `p.status != 'D'`,
                `p.poleffdate <= now()`,
                `p.polexpdate >= now()`
              )
            }
          }
          if(typeofbus !== undefined) {
            params.push(typeofbus)
            conditions.push(`p.typeofbus = $${ params.length }`)
          }
          if(carrier_code) {
            params.push(carrier_code)
            conditions.push(`p.cocode = $${ params.length }`)
          }
          if(csr_code) {
            params.push(csr_code)
            conditions.push(`p.csrcode = $${ params.length }`)
          }

          const whereClause = conditions.length ? `WHERE ${ conditions.join(" AND ") }` : ""

          sql = `${ CORE_QUERY } ${ whereClause } ORDER BY ${ SORT_OPTIONS[sort] } LIMIT ${ limit + 1 } OFFSET ${ offset }`
        }

        let policies = await runReadOnlyQuery(sql, params)

        if(!polid && policies.length > limit) {
          hasMore = true
          policies = policies.slice(0, limit)
        }

        if(policies.length === 0) {
          return textResult({ policies: [], has_more: false })
        }

        const polids = policies.map((row) => row.polid)

        const includedData: Partial<Record<Include, Map<string, unknown[]>>> = {}

        for(const key of include ?? []) {
          const rows = await runReadOnlyQuery(INCLUDE_QUERIES[key], [polids])
          includedData[key] = groupByKey(rows as Record<string, unknown>[], "polid")
        }

        const results = policies.map((policy) => {
          const included: Partial<Record<Include, unknown[]>> = {}

          for(const key of include ?? []) {
            included[key] = includedData[key]?.get(String(policy.polid)) ?? []
          }

          return include?.length ? { ...policy, included } : policy
        })

        return textResult({ policies: results, has_more: hasMore })
      } catch(error) {
        logger.error({ err: error, polid, polno, custid, status, renewalrptflag, typeofbus, carrier_code, csr_code, sort, offset, include }, "policy_query failed")
        return errorResult(error)
      }
    }
  )
}
