import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { realCertHolderCondition } from "../utils/certificateDataQuality.js"
import { systemEmployeeCondition } from "../utils/employeeClassification.js"
import { logger } from "../utils/logger.js"
import { errorResult, groupByKey, textResult } from "../utils/mcpHelpers.js"

const INCLUDE_OPTIONS = ["holder_history"] as const

type Include = typeof INCLUDE_OPTIONS[number]

const INCLUDE_QUERIES: Record<Include, string> = {
  // Every reissue/resend of a certificate creates a new afw_certholderinfo row against the same
  // crtid (confirmed 1:1 FK-shaped relationship against real data, ~11 snapshots per certificate
  // on average) — this is the full history, not just who holds it today (that's already inline
  // on the core result via the current_holder_* fields).
  holder_history: `
    SELECT crtid, crthid, name1crth, name2crth, contactnamecrth,
      addr1crth, addr2crth, citycrth, statecrth, zipcodecrth, emailcrth,
      certissuedatecrth, methodofdelivery, nameselectioncrth, descrcrth,
      changedby, changeddate, entereddate
    FROM afw_certholderinfo
    WHERE crtid = ANY($1::uuid[]) AND ${ realCertHolderCondition("afw_certholderinfo") }
    ORDER BY crtid, certissuedatecrth DESC NULLS LAST, entereddate DESC
  `
}

// Covered policies: afw_certliabprop stores up to 9 policy ids as 9 discrete columns rather than
// a child table (Pol1Id...Pol9Id) — slots 7/8/9 have fixed special meanings per the AMS360 spec
// (Cargo/Trailer Interchange/Garage Keepers respectively), slots 1-6 are any general LOB. Zipping
// the 9 columns against their slot numbers via unnest() and joining afw_basicpolinfo/afw_company
// resolves this into a single JSON array per certificate without a separate include round-trip.
const COVERED_POLICIES_EXPR = `
  (
    SELECT json_agg(json_build_object(
      'slot', u.slot,
      'slot_label', CASE u.slot WHEN 7 THEN 'Cargo' WHEN 8 THEN 'Trailer Interchange' WHEN 9 THEN 'Garage Keepers' ELSE NULL END,
      'polid', p.polid,
      'polno', p.polno,
      'carrier_name', co.name
    ) ORDER BY u.slot)
    FROM unnest(
      ARRAY[clp.pol1id, clp.pol2id, clp.pol3id, clp.pol4id, clp.pol5id, clp.pol6id, clp.pol7id, clp.pol8id, clp.pol9id],
      ARRAY[1, 2, 3, 4, 5, 6, 7, 8, 9]
    ) AS u(polid, slot)
    JOIN afw_basicpolinfo p ON p.polid = u.polid
    LEFT JOIN afw_company co ON p.cocode = co.cocode
  ) AS covered_policies
`

// The current/latest holder is resolved inline (via LATERAL, ordered same as holder_history)
// since "who holds this certificate today" is the central fact about a certificate, not
// supplementary detail — the full reissue history is still available via the holder_history
// include for anyone who needs it.
const CORE_QUERY = `
  SELECT
    clp.crtid, clp.custid,
    COALESCE(NULLIF(TRIM(CONCAT_WS(' ', cust.firstname, cust.lastname)), ''), cust.firmnamecust, cust.dba) AS customer_name,
    clp.certformtype, clp.crtno, clp.descofopslocs, clp.descriptioncrt, clp.isoninternet, clp.authorizedrep,
    clp.isaddlinsuredgenl, clp.isaddlinsuredautol, clp.isaddlinsuredgarl, clp.isaddlinsuredgark,
    clp.isaddlinsuredumbl, clp.isaddlinsuredother,
    clp.iswaivegl, clp.iswaiveauto, clp.iswaivegarl, clp.iswaivegark, clp.iswaiveexcess, clp.iswaivewc, clp.iswaiveother,
    ch.name1crth AS current_holder_name, ch.name2crth AS current_holder_name2,
    ch.contactnamecrth AS current_holder_contact,
    ch.addr1crth AS current_holder_addr1, ch.addr2crth AS current_holder_addr2,
    ch.citycrth AS current_holder_city, ch.statecrth AS current_holder_state, ch.zipcodecrth AS current_holder_zip,
    ch.emailcrth AS current_holder_email, ch.certissuedatecrth AS current_holder_cert_issue_date,
    ch.methodofdelivery AS current_holder_delivery_method,
    ${ COVERED_POLICIES_EXPR },
    clp.changedby, clp.changeddate, clp.entereddate
  FROM afw_certliabprop clp
  LEFT JOIN afw_customer cust ON clp.custid = cust.custid
  LEFT JOIN LATERAL (
    SELECT * FROM afw_certholderinfo chi
    WHERE chi.crtid = clp.crtid AND ${ realCertHolderCondition("chi") }
    ORDER BY chi.certissuedatecrth DESC NULLS LAST, chi.entereddate DESC
    LIMIT 1
  ) ch ON true
`

const SORT_OPTIONS = {
  entereddate_desc: "clp.entereddate DESC",
  entereddate_asc: "clp.entereddate ASC",
  crtno_asc: "clp.crtno ASC",
  crtno_desc: "clp.crtno DESC"
} as const

type Sort = keyof typeof SORT_OPTIONS

// Three different counts per group, all real and all answering different questions:
// - certificate_count: how many distinct certificates (afw_certliabprop rows)
// - reissue_count: how many times any of those certificates have actually been (re)sent to a
//   holder (afw_certholderinfo rows) — the real repeat-service-event signal, ~11 resends per
//   certificate on average. Counts EVENTS, not distinct recipients.
// - distinct_holder_count: how many different entities (by name1crth) those reissues have
//   actually gone to. A group can have a high reissue_count from resending to the same handful
//   of holders repeatedly (e.g. an annual renewal to the same landlord) or from constantly adding
//   new holders (e.g. a subcontractor naming a new GC on every job) - confirmed these diverge on
//   real data (one customer: 1,269 reissues, only 439 distinct holder names, i.e. ~2.9 resends
//   per holder on average, not 1,269 different recipients).
// name1crth is a plain name match, not a deduped identity - two genuinely different holders that
// happen to share a name would undercount, and the same holder spelled two different ways would
// overcount. Treat distinct_holder_count as a reasonable approximation, not an exact figure.
const GROUP_BY_BASE_QUERY = `
  FROM afw_certliabprop clp
  LEFT JOIN afw_customer cust ON clp.custid = cust.custid
  LEFT JOIN afw_certholderinfo chi ON chi.crtid = clp.crtid AND ${ realCertHolderCondition("chi") }
`

// customer: key is custid (a raw uuid, never shown - see the tool description's IMPORTANT note),
// label is the resolved customer name. csr: key is csrcode (a raw AMS360 code, same rule) and
// label is the resolved CSR name, matching book_summary's producer/csr dimensions exactly -
// including excluding known system/integration employee accounts (DBO etc.) from showing up as
// if they were a real CSR with a certificate-heavy book. holder: key/label are both the holder's
// name (afw_certholderinfo.name1crth) - a plain name match, not a deduped identity, same caveat as
// distinct_holder_count elsewhere. "Which holder do we send the most certificates to" is a
// genuinely different question from "which customer/CSR" - a holder like a bank or a recurring GC
// can span many unrelated customers, which is exactly what distinct_customer_count surfaces here
// (customer/csr dimensions have no equivalent field - that's what distinct_holder_count is for on
// those, and the two aren't interchangeable across dimensions).
const GROUP_BY_DIMENSIONS = {
  customer: {
    keySelect: "clp.custid",
    labelSelect: "COALESCE(NULLIF(TRIM(CONCAT_WS(' ', cust.firstname, cust.lastname)), ''), cust.firmnamecust, cust.dba)",
    extraJoin: "",
    extraCondition: null as string | null,
    metricsSelect: `
      COUNT(DISTINCT clp.crtid)::int AS certificate_count,
      COUNT(chi.crthid)::int AS reissue_count,
      COUNT(DISTINCT chi.name1crth)::int AS distinct_holder_count
    `,
    validSorts: ["certificate_count_desc", "certificate_count_asc", "reissue_count_desc", "reissue_count_asc", "distinct_holder_count_desc", "distinct_holder_count_asc"]
  },
  csr: {
    keySelect: "cust.csrcode",
    labelSelect: "COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), cust.csrcode)",
    extraJoin: "LEFT JOIN afw_employee csr ON cust.csrcode = csr.empcode",
    extraCondition: `NOT EXISTS (SELECT 1 FROM afw_employee e WHERE e.empcode = cust.csrcode AND ${ systemEmployeeCondition("e") })`,
    metricsSelect: `
      COUNT(DISTINCT clp.crtid)::int AS certificate_count,
      COUNT(chi.crthid)::int AS reissue_count,
      COUNT(DISTINCT chi.name1crth)::int AS distinct_holder_count
    `,
    validSorts: ["certificate_count_desc", "certificate_count_asc", "reissue_count_desc", "reissue_count_asc", "distinct_holder_count_desc", "distinct_holder_count_asc"]
  },
  holder: {
    keySelect: "chi.name1crth",
    labelSelect: "chi.name1crth",
    extraJoin: "",
    extraCondition: "chi.crthid IS NOT NULL" as string | null,
    metricsSelect: `
      COUNT(DISTINCT clp.crtid)::int AS certificate_count,
      COUNT(*)::int AS reissue_count,
      COUNT(DISTINCT clp.custid)::int AS distinct_customer_count
    `,
    validSorts: ["certificate_count_desc", "certificate_count_asc", "reissue_count_desc", "reissue_count_asc", "distinct_customer_count_desc", "distinct_customer_count_asc"]
  }
} as const

type GroupByDimension = keyof typeof GROUP_BY_DIMENSIONS

// "Most certificates," "most reissues," and the dimension-specific third metric are different
// questions with different rankings (see the certificates skill) — this MUST be an explicit,
// queryable sort rather than always ranking by certificate_count, or "which customer has the most
// reissues" would silently return the wrong answer (or omit the real top customer entirely once
// default pagination truncates the result). Not every sort key is valid for every dimension
// (distinct_holder_count doesn't exist on the holder dimension, distinct_customer_count doesn't
// exist on customer/csr) - the handler falls back to certificate_count_desc for a mismatched
// combination rather than erroring, and reports which sort actually got applied.
const GROUP_SORT_OPTIONS = {
  certificate_count_desc: "certificate_count DESC",
  certificate_count_asc: "certificate_count ASC",
  reissue_count_desc: "reissue_count DESC",
  reissue_count_asc: "reissue_count ASC",
  distinct_holder_count_desc: "distinct_holder_count DESC",
  distinct_holder_count_asc: "distinct_holder_count ASC",
  distinct_customer_count_desc: "distinct_customer_count DESC",
  distinct_customer_count_asc: "distinct_customer_count ASC"
} as const

type GroupSort = keyof typeof GROUP_SORT_OPTIONS

export function registerCertificateLookupTool(server: McpServer) {
  server.registerTool(
    "certificate_lookup",
    {
      description: "Look up certificate(s) of insurance (afw_certliabprop — liability/property COIs issued to a third party, e.g. a general contractor or landlord requiring proof of coverage) by ID, or browse/search by owning customer, certificate number, form type, or holder name, with sorting and pagination. With no filters at all, returns a paginated list of all certificates. `holder_name` answers \"which of our customers issue certificates to X\" (e.g. \"give me City of Franklin's customers\") — matches any past or current holder snapshot for that certificate, not just the most recent one; combine with `group_by: \"customer\"` for a deduplicated per-customer list/count instead of one row per certificate. Pass `group_by: \"customer\"`, `\"csr\"`, or `\"holder\"` to instead roll up counts per customer, per CSR (attributed via the customer's header CSR field, matching book_summary), or per certificate holder — always returns `certificate_count` and `reissue_count`, plus one more dimension-specific field: `distinct_holder_count` on the customer/csr dimensions (how many different holders that group's certificates have gone to) or `distinct_customer_count` on the holder dimension (how many different Boxwood customers have sent a certificate to this same holder — e.g. a bank or a recurring GC that shows up across many unrelated accounts). These fields answer genuinely DIFFERENT questions that can each name a different top customer/CSR/holder — use `group_sort` to pick which one ranks the results (`certificate_count_desc` is the default); reading one count's top row as the answer to a different count's question will give you the wrong name, not just a differently-ordered view of the same answer. Passing a `group_sort` that doesn't apply to the chosen dimension (e.g. `distinct_holder_count_desc` with `group_by: \"holder\"`) silently falls back to `certificate_count_desc` — the response's own `group_sort` field always shows what was actually applied, check it rather than assuming your request was honored. On the customer/csr dimensions, `key` is a raw internal identifier (a `custid` uuid or a `csrcode` employee code) — same rule as everywhere else, never surface it; always report `label` instead. On the holder dimension there's no separate opaque code to hide — `key` and `label` are both just the holder's name, safe to report either way. Every certificate can cover up to 9 policies (`covered_policies`, resolved to policy number + carrier name; slots 7/8/9 have fixed meanings — Cargo/Trailer Interchange/Garage Keepers — slots 1-6 are any general line of business). `current_holder_*` fields show who the certificate is issued to as of its most recent reissue/resend — a certificate can be resent to the same or a different holder many times over its life (confirmed against real data: ~11 reissues per certificate on average); use `include: [\"holder_history\"]` to see every prior holder snapshot, not just the current one. `certformtype` is `L` (liability) or `P` (property). `isaddlinsured*`/`iswaive*` flags are two different, easily-confused concepts — additional insured (actually endorsed onto the policy as a covered party) vs. waiver of subrogation (insurer gives up its own right to recover from this party after a claim) — neither implies the other. CONFIRMED as of 2026-08-27: every one of these flags is currently `null` on every real certificate in this database, and the raw Vertafore API response itself returns null before this project's sync even runs — so a `null` here means 'unknown,' not 'no.' IMPORTANT: `crtid`/`custid`/`polid` (inside `covered_policies`)/`crthid` (in `holder_history`) are internal AMS360 identifiers (UUIDs) with no meaning to an end user — never surface them in an answer; use `crtno`, the customer name, or `polno` instead. They exist only to chain to other tool calls (e.g. pass `polid` to `policy_query`, `custid` to `customer_lookup`). `changedby` is a raw AMS360 employee code, same rule — never surface it, resolve it via employee_lookup if the user needs to know who made a change.",
      inputSchema: {
        crtid: z.string().uuid().describe("Exact certificate ID (afw_certliabprop.crtid)").optional(),
        custid: z.string().uuid().describe("Filter to certificates belonging to this customer").optional(),
        crtno: z.string().describe("Partial match against certificate number").optional(),
        certformtype: z.enum(["L", "P"]).describe("Filter to liability (L) or property (P) certificates").optional(),
        holder_name: z.string().describe("Partial match against the certificate holder's name — matches if this holder has EVER received the certificate (any afw_certholderinfo reissue snapshot), not just the current one. Use this to answer \"which of our customers issue certificates to X\" (e.g. holder_name: \"City of Franklin\"). Combine with group_by: \"customer\" to get a deduplicated per-customer list/count instead of one row per certificate").optional(),
        group_by: z.enum(["none", "customer", "csr", "holder"]).default("none").describe("Pass \"customer\"/\"csr\"/\"holder\" to roll up counts per customer, per CSR, or per certificate holder instead of returning individual certificates — crtid/crtno/sort/include are ignored in this mode; use group_sort to pick which count ranks the results. \"csr\" attributes each certificate to its owning customer's header CSR (afw_customer.csrcode), matching book_summary's csr dimension. \"holder\" answers \"who do we send the most certificates/reissues to\" or \"top distinct holders\" — a different question from \"customer\"/\"csr\", since one holder (e.g. a bank) can span many unrelated customers"),
        group_sort: z.enum(Object.keys(GROUP_SORT_OPTIONS) as [GroupSort, ...GroupSort[]]).default("certificate_count_desc").describe("Only used when group_by is not \"none\". \"Most certificates\", \"most reissues\", and the dimension-specific third metric (distinct_holder_count for customer/csr, distinct_customer_count for holder) are DIFFERENT questions that can each rank the results differently — pick the option matching what's actually being asked. Defaults to certificate_count_desc; get this wrong and you will read off the wrong name, not just a differently-sorted list of the same one. A sort key that doesn't apply to the chosen group_by falls back to certificate_count_desc — check the response's own group_sort field to see what was actually applied"),
        sort: z.enum(Object.keys(SORT_OPTIONS) as [Sort, ...Sort[]]).default("entereddate_desc").describe("Sort order, ignored when crtid is given or when group_by is not \"none\""),
        offset: z.number().int().min(0).default(0).describe("Number of certificates (or customers/CSRs, when grouping) to skip, ignored when crtid is given"),
        include: z.array(z.enum(INCLUDE_OPTIONS)).describe("Related record sets to attach to each certificate, ignored when group_by is not \"none\"").optional(),
        limit: z.number().int().min(1).max(50).default(10).describe("Max certificates (or customers/CSRs, when grouping) to return per page")
      }
    },
    async ({ crtid, custid, crtno, certformtype, holder_name, group_by, group_sort, sort, offset, include, limit }) => {
      try {
        if(group_by !== "none") {
          const dim = GROUP_BY_DIMENSIONS[group_by as GroupByDimension]
          const conditions: string[] = []
          const params: unknown[] = []

          if(custid) {
            params.push(custid)
            conditions.push(`clp.custid = $${ params.length }`)
          }
          if(certformtype) {
            params.push(certformtype)
            conditions.push(`clp.certformtype = $${ params.length }`)
          }
          if(holder_name) {
            // chi here is already the full (non-sample) reissue history via GROUP_BY_BASE_QUERY's
            // join, not just the latest snapshot — matches any past or current holder name.
            params.push(`%${ holder_name }%`)
            conditions.push(`chi.name1crth ILIKE $${ params.length }`)
          }
          if(dim.extraCondition) {
            conditions.push(dim.extraCondition)
          }

          const whereClause = conditions.length ? `WHERE ${ conditions.join(" AND ") }` : ""

          // A sort key that isn't valid for this dimension (e.g. distinct_holder_count on the
          // holder dimension, which has no such field) would be a SQL error against an unknown
          // column — fall back to the universal default instead, and report which sort actually
          // ran so the caller isn't silently misled about what was applied.
          const effectiveGroupSort = (dim.validSorts as readonly string[]).includes(group_sort)
            ? group_sort
            : "certificate_count_desc"

          const sql = `
            SELECT ${ dim.keySelect } AS key, ${ dim.labelSelect } AS label,
              ${ dim.metricsSelect }
            ${ GROUP_BY_BASE_QUERY }
            ${ dim.extraJoin }
            ${ whereClause }
            GROUP BY 1, 2
            ORDER BY ${ GROUP_SORT_OPTIONS[effectiveGroupSort] }
            LIMIT ${ limit + 1 } OFFSET ${ offset }
          `

          let rows = await runReadOnlyQuery(sql, params)
          let hasMore = false

          if(rows.length > limit) {
            hasMore = true
            rows = rows.slice(0, limit)
          }

          return textResult({ group_by, group_sort: effectiveGroupSort, rows, has_more: hasMore })
        }

        let sql: string
        let params: unknown[]
        let hasMore = false

        if(crtid) {
          params = [crtid]
          sql = `${ CORE_QUERY } WHERE clp.crtid = $1`
        } else {
          const conditions: string[] = []
          params = []

          if(custid) {
            params.push(custid)
            conditions.push(`clp.custid = $${ params.length }`)
          }
          if(crtno) {
            params.push(`%${ crtno }%`)
            conditions.push(`clp.crtno ILIKE $${ params.length }`)
          }
          if(certformtype) {
            params.push(certformtype)
            conditions.push(`clp.certformtype = $${ params.length }`)
          }
          if(holder_name) {
            // EXISTS against the full afw_certholderinfo history (not the CORE_QUERY's LATERAL
            // "latest snapshot" ch alias) so this matches a past holder too, not just the current
            // one — a certificate reissued away from City of Franklin last year should still
            // count as "we've issued a certificate to City of Franklin" for this filter.
            params.push(`%${ holder_name }%`)
            conditions.push(`EXISTS (SELECT 1 FROM afw_certholderinfo h WHERE h.crtid = clp.crtid AND h.name1crth ILIKE $${ params.length } AND ${ realCertHolderCondition("h") })`)
          }

          const whereClause = conditions.length ? `WHERE ${ conditions.join(" AND ") }` : ""

          sql = `${ CORE_QUERY } ${ whereClause } ORDER BY ${ SORT_OPTIONS[sort] } LIMIT ${ limit + 1 } OFFSET ${ offset }`
        }

        let certificates = await runReadOnlyQuery(sql, params)

        if(!crtid && certificates.length > limit) {
          hasMore = true
          certificates = certificates.slice(0, limit)
        }

        if(certificates.length === 0) {
          return textResult({ certificates: [], has_more: false })
        }

        const crtids = certificates.map((row) => row.crtid)

        const includedData: Partial<Record<Include, Map<string, unknown[]>>> = {}

        for(const key of include ?? []) {
          const rows = await runReadOnlyQuery(INCLUDE_QUERIES[key], [crtids])
          includedData[key] = groupByKey(rows as Record<string, unknown>[], "crtid")
        }

        const results = certificates.map((certificate) => {
          const included: Partial<Record<Include, unknown[]>> = {}

          for(const key of include ?? []) {
            included[key] = includedData[key]?.get(String(certificate.crtid)) ?? []
          }

          return include?.length ? { ...certificate, included } : certificate
        })

        return textResult({ certificates: results, has_more: hasMore })
      } catch(error) {
        logger.error({ err: error, crtid, custid, crtno, certformtype, holder_name, group_by, group_sort, sort, offset, include }, "certificate_lookup failed")
        return errorResult(error)
      }
    }
  )
}
