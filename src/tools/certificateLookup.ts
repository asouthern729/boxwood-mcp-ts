import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
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
    WHERE crtid = ANY($1::uuid[])
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
    WHERE chi.crtid = clp.crtid
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

export function registerCertificateLookupTool(server: McpServer) {
  server.registerTool(
    "certificate_lookup",
    {
      description: "Look up certificate(s) of insurance (afw_certliabprop — liability/property COIs issued to a third party, e.g. a general contractor or landlord requiring proof of coverage) by ID, or browse/search by owning customer, certificate number, or form type, with sorting and pagination. With no filters at all, returns a paginated list of all certificates. Every certificate can cover up to 9 policies (`covered_policies`, resolved to policy number + carrier name; slots 7/8/9 have fixed meanings — Cargo/Trailer Interchange/Garage Keepers — slots 1-6 are any general line of business). `current_holder_*` fields show who the certificate is issued to as of its most recent reissue/resend — a certificate can be resent to the same or a different holder many times over its life (confirmed against real data: ~11 reissues per certificate on average); use `include: [\"holder_history\"]` to see every prior holder snapshot, not just the current one. `certformtype` is `L` (liability) or `P` (property). `isaddlinsured*`/`iswaive*` flags are two different, easily-confused concepts — additional insured (actually endorsed onto the policy as a covered party) vs. waiver of subrogation (insurer gives up its own right to recover from this party after a claim) — neither implies the other. CONFIRMED as of 2026-08-27: every one of these flags is currently `null` on every real certificate in this database, and the raw Vertafore API response itself returns null before this project's sync even runs — so a `null` here means 'unknown,' not 'no.' IMPORTANT: `changedby` is a raw AMS360 employee code with no meaning to an end user — never surface it in an answer, resolve it via employee_lookup if the user needs to know who made a change.",
      inputSchema: {
        crtid: z.string().uuid().describe("Exact certificate ID (afw_certliabprop.crtid)").optional(),
        custid: z.string().uuid().describe("Filter to certificates belonging to this customer").optional(),
        crtno: z.string().describe("Partial match against certificate number").optional(),
        certformtype: z.enum(["L", "P"]).describe("Filter to liability (L) or property (P) certificates").optional(),
        sort: z.enum(Object.keys(SORT_OPTIONS) as [Sort, ...Sort[]]).default("entereddate_desc").describe("Sort order, ignored when crtid is given"),
        offset: z.number().int().min(0).default(0).describe("Number of certificates to skip, ignored when crtid is given"),
        include: z.array(z.enum(INCLUDE_OPTIONS)).describe("Related record sets to attach to each certificate").optional(),
        limit: z.number().int().min(1).max(50).default(10).describe("Max certificates to return per page")
      }
    },
    async ({ crtid, custid, crtno, certformtype, sort, offset, include, limit }) => {
      try {
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
        logger.error({ err: error, crtid, custid, crtno, certformtype, sort, offset, include }, "certificate_lookup failed")
        return errorResult(error)
      }
    }
  )
}
