import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { logger } from "../utils/logger.js"
import { errorResult, groupByKey, textResult } from "../utils/mcpHelpers.js"

const INCLUDE_OPTIONS = ["loss_history", "payments", "contacts", "injured", "property_damage", "remarks", "risk_info"] as const

type Include = typeof INCLUDE_OPTIONS[number]

const INCLUDE_QUERIES: Record<Include, string> = {
  loss_history: `
    SELECT claimid, closshistid, custid, company, polno, kindofloss, lineofbus,
      poleffdate, polexpdate, amountpaid, dateofloss, claimstatus, claimno, closeddate,
      lossdescclhis
    FROM afw_custlosshist
    WHERE claimid = ANY($1::uuid[])
    ORDER BY dateofloss DESC
  `,
  payments: `
    SELECT claimid, cpayid, coveragecode, amount, paymenttype, paidby, draftno, checkdate,
      claiment, misc, entereddate
    FROM afw_claimpayment
    WHERE claimid = ANY($1::uuid[])
    ORDER BY entereddate DESC
  `,
  // contacttypeclcnt resolves via afw_prcode (AttrCode='CCT') — attrcode comes back space-padded
  // from the AMS360 API (e.g. 'CCT'), so the join must rtrim it; code itself is not padded.
  contacts: `
    SELECT c.claimid, c.clcntid, c.nameclcnt, c.contacttypeclcnt, cct.description AS contact_type_description,
      c.primarynumber, c.resareacodeclcnt, c.resphoneclcnt, c.busareacodeclcnt, c.busphoneclcnt,
      c.mobileareacodeclcnt, c.mobilephoneclcnt, c.emailclcnt
    FROM afw_claimcontact c
    LEFT JOIN afw_prcode cct ON rtrim(cct.attrcode) = 'CCT' AND cct.code = c.contacttypeclcnt
    WHERE c.claimid = ANY($1::uuid[])
    ORDER BY c.nameclcnt
  `,
  injured: `
    SELECT claimid, cliid, injnamecli, injagecli, injgendercli, injoccupationcli,
      isfatalitycli, isinsvehcli, isothvehcli, ispedcli, injdescriptioncli
    FROM afw_claiminjured
    WHERE claimid = ANY($1::uuid[])
    ORDER BY injnamecli
  `,
  property_damage: `
    SELECT claimid, clpdid, compnameclpd, polnoclpd, ownnameclpd, drvnameclpd,
      isdrvsameownclpd, descdamageclpd, estamtclpd, whendamageseenclpd, wheredamageseenclpd
    FROM afw_claimpropdamage
    WHERE claimid = ANY($1::uuid[])
    ORDER BY estamtclpd DESC
  `,
  remarks: `
    SELECT claimid, clrmkid, remarkclrmk, entereddate
    FROM afw_claimremark
    WHERE claimid = ANY($1::uuid[])
    ORDER BY entereddate DESC
  `,
  risk_info: `
    SELECT claimid, claimrid, polid, lobid, effdate, type, description,
      riskdescdamage, riskestamt, riskwhereseen, riskwhenseen, riskotheins
    FROM afw_claimriskinfo
    WHERE claimid = ANY($1::uuid[])
    ORDER BY effdate DESC
  `
}

const CORE_QUERY = `
  SELECT
    cl.claimid, cl.claimno, cl.claimstatus, cl.status,
    cl.causeofloss, cl.lossdate, cl.occurrencedate, cl.reportdate, cl.reportby, cl.reportto,
    cl.reportauthority, cl.reportno, cl.closeddate,
    cl.descriptioncl, cl.isdescpreserved, cl.additionalrisk,
    cl.losslocaddr, cl.lossloccity, cl.losslocstate, cl.lossloczip,
    cl.catcode, cl.elfformid,
    cl.polid, pol.polno,
    pol.custid, cust.lastname AS customer_lastname, cust.firstname AS customer_firstname, cust.dba AS customer_dba,
    cl.lobid, cl.lineofbus, lo.descriptionlobs AS lob_description,
    cl.poleffdate, cl.polexpdate, cl.polenddate,
    cl.changedby, cl.changeddate, cl.entereddate
  FROM afw_claim cl
  LEFT JOIN afw_basicpolinfo pol ON cl.polid = pol.polid
  LEFT JOIN afw_customer cust ON pol.custid = cust.custid
  LEFT JOIN afw_lobsetup lo ON cl.lineofbus = lo.namelobs
`

const SORT_OPTIONS = {
  lossdate_desc: "cl.lossdate DESC",
  lossdate_asc: "cl.lossdate ASC",
  reportdate_desc: "cl.reportdate DESC",
  reportdate_asc: "cl.reportdate ASC",
  entereddate_asc: "cl.entereddate ASC",
  entereddate_desc: "cl.entereddate DESC"
} as const

type Sort = keyof typeof SORT_OPTIONS

export function registerClaimLookupTool(server: McpServer) {
  server.registerTool(
    "claim_lookup",
    {
      description: "Look up claim(s) by ID, or browse/search claims by owning policy, owning customer, and coarse filters (claim number, claim status, cause of loss), with sorting and pagination. With no filters at all, returns a paginated list of all claims. Resolves customer/policy/line-of-business names inline. Optionally include the matching afw_custlosshist summary row, actual payment/reserve line items, claim contacts, injured-party detail, auto property damage detail, adjuster remarks, and risk-info attachments. For real dollar amounts paid on a claim, use the `payments` include (or `book_summary`'s `claims_paid_total`) — `loss_history`'s `amountpaid` is sparse and unreliable, see the claims skill. IMPORTANT: `claimid`/`polid`/`custid`/`lobid` (and every other `*id` field returned, including within includes — `closshistid`, `cpayid`, `clcntid`, `cliid`, `clpdid`, `clrmkid`, `claimrid`) are internal AMS360 identifiers (UUIDs) with no meaning to an end user — never surface them in an answer. They exist only to chain to other tool calls (e.g. pass `polid` to `policy_query`, `custid` to `customer_lookup`); always report `claimno`, the resolved customer/policy name or number, or another human-readable field instead. The same applies to `changedby`, a raw employee code — resolve it via `employee_lookup` if the user needs to know who made a change.",
      inputSchema: {
        claimid: z.string().uuid().describe("Exact claim ID (afw_claim.claimid)").optional(),
        polid: z.string().uuid().describe("Filter to claims on this policy").optional(),
        custid: z.string().uuid().describe("Filter to claims across this customer's policies").optional(),
        claimno: z.string().describe("Partial match against claim number (afw_claim.claimno)").optional(),
        claimstatus: z.string().describe("Exact match against claim status (afw_claim.claimstatus, e.g. \"Open\", \"Closed\")").optional(),
        causeofloss: z.string().describe("Partial match against cause of loss (afw_claim.causeofloss)").optional(),
        sort: z.enum(Object.keys(SORT_OPTIONS) as [Sort, ...Sort[]]).default("lossdate_desc").describe("Sort order, ignored when claimid is given"),
        offset: z.number().int().min(0).default(0).describe("Number of claims to skip, ignored when claimid is given"),
        include: z.array(z.enum(INCLUDE_OPTIONS)).describe("Related record sets to attach to each claim").optional(),
        limit: z.number().int().min(1).max(50).default(10).describe("Max claims to return per page")
      }
    },
    async ({ claimid, polid, custid, claimno, claimstatus, causeofloss, sort, offset, include, limit }) => {
      try {
        let sql: string
        let params: unknown[]
        let hasMore = false

        if(claimid) {
          params = [claimid]
          sql = `${ CORE_QUERY } WHERE cl.claimid = $1`
        } else {
          const conditions: string[] = []
          params = []

          if(polid) {
            params.push(polid)
            conditions.push(`cl.polid = $${ params.length }`)
          }
          if(custid) {
            params.push(custid)
            conditions.push(`pol.custid = $${ params.length }`)
          }
          if(claimno) {
            params.push(`%${ claimno }%`)
            conditions.push(`cl.claimno ILIKE $${ params.length }`)
          }
          if(claimstatus) {
            params.push(claimstatus)
            conditions.push(`cl.claimstatus = $${ params.length }`)
          }
          if(causeofloss) {
            params.push(`%${ causeofloss }%`)
            conditions.push(`cl.causeofloss ILIKE $${ params.length }`)
          }

          const whereClause = conditions.length ? `WHERE ${ conditions.join(" AND ") }` : ""

          sql = `${ CORE_QUERY } ${ whereClause } ORDER BY ${ SORT_OPTIONS[sort] } LIMIT ${ limit + 1 } OFFSET ${ offset }`
        }

        let claims = await runReadOnlyQuery(sql, params)

        if(!claimid && claims.length > limit) {
          hasMore = true
          claims = claims.slice(0, limit)
        }

        if(claims.length === 0) {
          return textResult({ claims: [], has_more: false })
        }

        const claimids = claims.map((row) => row.claimid)

        const includedData: Partial<Record<Include, Map<string, unknown[]>>> = {}

        for(const key of include ?? []) {
          const rows = await runReadOnlyQuery(INCLUDE_QUERIES[key], [claimids])
          includedData[key] = groupByKey(rows as Record<string, unknown>[], "claimid")
        }

        const results = claims.map((claim) => {
          const included: Partial<Record<Include, unknown[]>> = {}

          for(const key of include ?? []) {
            included[key] = includedData[key]?.get(String(claim.claimid)) ?? []
          }

          return include?.length ? { ...claim, included } : claim
        })

        return textResult({ claims: results, has_more: hasMore })
      } catch(error) {
        logger.error({ err: error, claimid, polid, custid, claimno, claimstatus, causeofloss, sort, offset, include }, "claim_lookup failed")
        return errorResult(error)
      }
    }
  )
}
