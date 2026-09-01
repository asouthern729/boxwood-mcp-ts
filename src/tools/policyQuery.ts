import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { logger } from "../utils/logger.js"
import { errorResult, groupByKey, textResult } from "../utils/mcpHelpers.js"
import { SECTION_443_INCLUDE_OPTIONS, SECTION_443_INCLUDE_QUERIES } from "./policyQuerySection443Includes.js"

const INCLUDE_OPTIONS = [
  "transactions",
  "lines_of_business",
  "coverage",
  "premiums",
  "vehicles",
  "workers_comp",
  "forms",
  "applicant",
  "personnel",
  "submissions",
  "attributes",
  "contacts",
  ...SECTION_443_INCLUDE_OPTIONS
] as const

type Include = typeof INCLUDE_OPTIONS[number]

const INCLUDE_QUERIES: Record<Include, string> = {
  // trantype resolves via afw_prcode (AttrCode='TT') — attrcode comes back space-padded from the
  // AMS360 API (e.g. 'TT '), so the join must rtrim it; code itself is not padded.
  transactions: `
    SELECT pt.polid, pt.effdate, pt.trantype, tt.description AS trantype_description, pt.description,
      pt.source, pt.billmethodpolt, pt.instdaypolt, pt.reasonpolt, pt.premoneffdate, pt.isposted,
      pt.annualizedpremium, pt.annualizedestrevenue, pt.changeddate
    FROM afw_policytransaction pt
    LEFT JOIN afw_prcode tt ON rtrim(tt.attrcode) = 'TT' AND tt.code = pt.trantype
    WHERE pt.polid = ANY($1::uuid[])
    ORDER BY pt.polid, pt.effdate DESC
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
  // afw_cprem is a coverage-line premium/rating history (AMS360 Database Design Guide §4.4.3,
  // the per-LOB ACORD rating detail group), not a snapshot — the same (polid, lobid, cpremid)
  // gets a new row on every Add/Change/Delete, so this dedupes to each line's latest non-deleted
  // state (mirrors book_summary's cprem_current CTE exactly, same rn=1 + status != 'D' logic).
  // Commercial-only by AMS360's own doc — a personal-lines policy will always come back empty
  // here even when it has real premium (see fulltermpremium on the core result instead).
  // afw_cprem.lobid is NOT unique to one policy (confirmed against real data: the same lobid
  // value showed up on 5 different polids sharing an LOB type) — the lines_of_business join
  // below must also match on polid, or it fans out and multiplies premium rows per policy.
  premiums: `
    SELECT c.polid, c.lobid, l.lineofbus, lo.descriptionlobs AS lob_description,
      c.cpremid, c.coverage, c.premium, c.effdate, c.status,
      c.vlimit1, c.ilimit1, c.vlimit2, c.ilimit2, c.vlimit3, c.ilimit3, c.vlimit4, c.ilimit4,
      c.deduct, c.deduct2, c.deduct3, c.rate, c.ratedescription, c.covlevel, c.state
    FROM (
      SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.polid, c.lobid, c.cpremid ORDER BY c.effdate DESC) AS rn
      FROM afw_cprem c
      WHERE c.polid = ANY($1::uuid[])
    ) c
    LEFT JOIN afw_lineofbusiness l ON l.lobid = c.lobid AND l.polid = c.polid
    LEFT JOIN afw_lobsetup lo ON l.lineofbus = lo.namelobs
    WHERE c.rn = 1 AND c.status != 'D'
    ORDER BY c.polid, c.lobid, c.coverage
  `,
  // afw_vehicle (AMS360 Database Design Guide §4.4.3, one of 191 new per-LOB detail tables built
  // 2026-08-29) — Personal Auto vehicle schedule. Same Add/Change/Delete history shape as
  // afw_cprem, deduped the same way. IMPORTANT: never use v.* (explicit column list only) — this
  // table has had column-level grant restrictions before (Andrew decided plate numbers don't
  // belong in a renewal/proposal workflow; the licenseplatenoveh column has since been dropped
  // from the table entirely, not just access-restricted), and a wildcard against a column-level
  // grant fails with permission denied even for the granted columns, same trap as afw_applicant's
  // ssn/dob exclusion.
  vehicles: `
    SELECT v.polid, v.lobid, v.vehid, v.vehicleno, v.vehyear, v.make, v.model, v.bodytype, v.vin,
      v.vehusage, v.garaged, v.isnew, v.isleased, v.isnonowned, v.issalvaged, v.milesannual,
      v.symbol, v.territory, v.class, v.totalprem, v.effdate, v.status
    FROM (
      SELECT v.polid, v.lobid, v.vehid, v.vehicleno, v.vehyear, v.make, v.model, v.bodytype, v.vin,
        v.vehusage, v.garaged, v.isnew, v.isleased, v.isnonowned, v.issalvaged, v.milesannual,
        v.symbol, v.territory, v.class, v.totalprem, v.effdate, v.status,
        ROW_NUMBER() OVER (PARTITION BY v.polid, v.lobid, v.vehid ORDER BY v.effdate DESC) AS rn
      FROM afw_vehicle v
      WHERE v.polid = ANY($1::uuid[])
    ) v
    WHERE v.rn = 1 AND v.status != 'D'
    ORDER BY v.polid, v.vehicleno
  `,
  // afw_130policy — Workers Comp line-of-business detail (one row per WC policy/LOB rating term).
  workers_comp: `
    SELECT w.polid, w.lobid, w.wpolid, w.ratingdate, w.isparticipating, w.retroplan, w.dividendplan,
      w.employerno, w.nccino, w.state, w.ispart1, w.issafetygroup, w.effdate, w.status
    FROM (
      SELECT w.*, ROW_NUMBER() OVER (PARTITION BY w.polid, w.lobid, w.wpolid ORDER BY w.effdate DESC) AS rn
      FROM afw_130policy w
      WHERE w.polid = ANY($1::uuid[])
    ) w
    WHERE w.rn = 1 AND w.status != 'D'
    ORDER BY w.polid
  `,
  // afw_form — form numbers attached to the policy (per AMS360's own doc, specifically Homeowner
  // and Personal Umbrella LOBs; afw_cform covers forms more generically across other LOBs and
  // isn't wired in yet).
  forms: `
    SELECT f.polid, f.lobid, f.fmid, f.formno, f.editiondate, f.description, f.description2,
      f.origeffdate, f.expdate, f.effdate, f.status
    FROM (
      SELECT f.*, ROW_NUMBER() OVER (PARTITION BY f.polid, f.lobid, f.fmid ORDER BY f.effdate DESC) AS rn
      FROM afw_form f
      WHERE f.polid = ANY($1::uuid[])
    ) f
    WHERE f.rn = 1 AND f.status != 'D'
    ORDER BY f.polid, f.formno
  `,
  // afw_applicant — application info per named applicant on the policy (proposal-tool detail:
  // full name/entity type, mailing + residence address, contact info, occupation/business
  // classification). IMPORTANT: this table also has ssn/dob columns, but they're deliberately
  // omitted here — those columns carry real PII and are locked down at the grant level the same
  // way afw_customer.ssn/dob are (see project memory); selecting them would fail in production
  // anyway (`permission denied`), never add them back without a matching grant decision.
  applicant: `
    SELECT a.polid, a.appid, a.decnameapp, a.firstname, a.midname, a.lastname, a.firmnameapp, a.typeentityapp,
      a.mailaddr1, a.mailaddr2, a.mailcity, a.mailstate, a.mailzip,
      a.resaddr1, a.resaddr2, a.rescity, a.resstate, a.reszip,
      a.busareacode, a.busphone, a.resareacode, a.resphone, a.cellareacodeapp, a.cellphoneapp,
      a.emailapp, a.occupation, a.married, a.typeofbusiness, a.sic, a.naics, a.webaddr,
      a.knownsince, a.bussince, a.datebusstarted, a.numofyrs, a.numofmembers,
      a.effdate, a.status
    FROM (
      -- Explicit column list (not a.*) — afw_applicant has column-level grants (ssn/dob excluded),
      -- and Postgres requires SELECT privilege on every column a wildcard would expand to, so
      -- a.* here would fail with permission denied under the claude role even though none of the
      -- excluded columns are used.
      SELECT a.polid, a.appid, a.decnameapp, a.firstname, a.midname, a.lastname, a.firmnameapp, a.typeentityapp,
        a.mailaddr1, a.mailaddr2, a.mailcity, a.mailstate, a.mailzip,
        a.resaddr1, a.resaddr2, a.rescity, a.resstate, a.reszip,
        a.busareacode, a.busphone, a.resareacode, a.resphone, a.cellareacodeapp, a.cellphoneapp,
        a.emailapp, a.occupation, a.married, a.typeofbusiness, a.sic, a.naics, a.webaddr,
        a.knownsince, a.bussince, a.datebusstarted, a.numofyrs, a.numofmembers,
        a.effdate, a.status,
        ROW_NUMBER() OVER (PARTITION BY a.polid, a.appid ORDER BY a.effdate DESC) AS rn
      FROM afw_applicant a
      WHERE a.polid = ANY($1::uuid[])
    ) a
    WHERE a.rn = 1 AND a.status != 'D'
    ORDER BY a.polid, a.decnameapp
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
  `,
  ...SECTION_443_INCLUDE_QUERIES
}

// poltype (AttrCode='TP') and typeofbus (AttrCode='TB') resolve via afw_prcode, the real AMS360
// master code/label table. polsubtype and cotype are NOT afw_prcode-backed — the AMS360 Database
// Design Guide hardcodes their small, fixed value sets directly in prose rather than delegating to
// afw_prcode (confirmed with postgres-mcp-9f against the Guide text, not guessed from observed
// data) — those two resolve via `_code_lookup`, a small hand-maintained table (not synced from
// AMS360, deliberately not `afw_`-prefixed) built for exactly this category of column.
const CORE_QUERY = `
  SELECT
    p.polid, p.polno, p.shortpolno, p.status, p.renewalrptflag,
    p.typeofbus, tb.description AS typeofbus_description,
    p.poltype, tp.description AS poltype_description,
    p.polsubtype, pst.description AS polsubtype_description,
    p.cotype, ct.description AS cotype_description,
    p.poleffdate, p.polexpdate, p.iscontinuous,
    p.billmethod, bm.description AS billmethod_description,
    p.fulltermpremium,
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
  LEFT JOIN afw_prcode tp ON rtrim(tp.attrcode) = 'TP' AND tp.code = p.poltype
  LEFT JOIN afw_prcode tb ON rtrim(tb.attrcode) = 'TB' AND tb.code = p.typeofbus::text
  LEFT JOIN _code_lookup pst ON pst.category = 'polsubtype' AND pst.code = p.polsubtype
  LEFT JOIN _code_lookup ct ON ct.category = 'cotype' AND ct.code = p.cotype
  LEFT JOIN _code_lookup bm ON bm.category = 'billmethod' AND bm.code = p.billmethod
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
      description: "Look up policy/policies by ID, or browse/search policies by policy number, owning customer, and coarse filters (status, type of business, carrier, CSR), with sorting and pagination. With no filters at all, returns a paginated list of all policies. Resolves carrier/producer/CSR/broker/GL names inline. Optionally include related records (transactions, lines of business, coverage, coverage-line premium/pricing detail, vehicles, workers' comp detail, forms, personnel, submissions, attributes, policy-level contacts). The `premiums` include (afw_cprem) is coverage-line-level rating/pricing detail for commercial policies written through AMS360's detailed rating workflow — limits, deductibles, rate, and premium per coverage line, deduped to each line's current (latest non-deleted) state; it's empty for personal lines and for commercial policies not written through that workflow, in which case `fulltermpremium` on the core result is the only premium figure available. `vehicles` (Personal Auto vehicle schedule — make/model/VIN/usage/territory/premium), `workers_comp` (WC rating detail — state, employer/NCCI numbers, participating-plan flags), and `forms` (form numbers/descriptions/edition dates attached to the policy, primarily Homeowner/Personal Umbrella) are each empty unless the policy carries that specific line of business — don't read an empty array as a data gap, it usually just means the LOB doesn't apply. Beyond those, `include` also accepts ~190 additional AMS360 §4.4.3 per-LOB detail tables (GL hazard/coverage schedules, commercial property/building detail, inland marine equipment schedules, farm/boat/flood/life/health detail, and more) — the full list is in the `include` parameter's enum; each one is named after its underlying AMS360 table with the `afw_` prefix stripped (e.g. `126shazard` for the GL schedule of hazards, `cbuilding` for commercial building detail). Nearly all of these are empty unless the policy carries that specific, often uncommon, line of business — same 'not a data gap' caveat as vehicles/workers_comp/forms above, just far more pronounced since most are thin or unused for a given agency's book. Don't guess at one of these from the name alone if unsure what it returns; a wrong guess wastes a call, so when the LOB is unclear prefer `lines_of_business` or `coverage` first and only reach for a specific §4.4.3 include once the relevant LOB is confirmed. IMPORTANT: to find the currently in-force term (of a customer's book, a renewal chain, etc.), filter on `renewalrptflag: \"A\"`, not `status: \"A\"` — `status` does not track renewal-chain lifecycle in this data (most currently in-force terms carry `status='C'`); `renewalrptflag='A'` is the field that actually identifies the live term. Passing `renewalrptflag: \"A\"` also automatically excludes marketing/submission shells, deleted (status='D') rows, and — client-confirmed as of 2026-08-27 — any bound renewal whose effective date is still in the future or whose term has already expired, so the result is genuinely 'in force today,' matching `book_summary`'s definition of current. To see a future-dated renewal that's already bound but hasn't started yet, use `upcoming_renewals` instead — that tool is specifically for renewals with a future effective date and intentionally does not apply this restriction. IMPORTANT: `polid`/`custid`/`priorpolid`/`sourcepolid`/`anotid`/`paypid` are internal AMS360 identifiers (UUIDs) with no meaning to an end user — never surface them in an answer. `execcode`/`csrcode`/`brokercode`/the GL codes come back raw alongside their resolved name fields (`exec_lastname`/`csr_lastname`/`broker_lastname`, GL division/branch/department/group names) — always use the resolved name/description instead, never the raw code or id.",
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
