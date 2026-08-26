import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { logger } from "../utils/logger.js"
import { errorResult, textResult } from "../utils/mcpHelpers.js"

// polsubtype = 'S' is a marketing/submission shell, not a real bound term (see policies SKILL.md).
// A term with a successor (another row's priorpolid pointing back at it) has already been renewed —
// without this exclusion ~80% of a naive "expiring soon" result in test data is already-handled noise.
// renewalrptflag (not status) is the field that actually tracks renewal-chain lifecycle here —
// status='A' undercounts the true in-force book by roughly 8x (confirmed against real data).
const BASE_CONDITIONS = [
  "p.renewalrptflag = 'A'",
  "p.polsubtype != 'S'",
  "p.polexpdate BETWEEN now() AND now() + make_interval(days => $1::int)",
  "NOT EXISTS (SELECT 1 FROM afw_basicpolinfo bp2 WHERE bp2.priorpolid = p.polid)"
]

const CORE_QUERY = `
  SELECT
    p.polid, p.polno, p.shortpolno, p.typeofbus, p.poleffdate, p.polexpdate, p.fulltermpremium,
    p.custid, cust.lastname AS customer_lastname, cust.firstname AS customer_firstname, cust.dba AS customer_dba,
    p.cocode, co.name AS carrier_name,
    p.execcode, exec.lastname AS producer_lastname, exec.firstname AS producer_firstname,
    p.csrcode, csr.lastname AS csr_lastname, csr.firstname AS csr_firstname,
    EXISTS (
      SELECT 1 FROM afw_policytransaction pt
      WHERE pt.polid = p.polid AND pt.trantype IN ('RWL', 'RWQ')
    ) AS has_renewal_activity
  FROM afw_basicpolinfo p
  LEFT JOIN afw_customer cust ON p.custid = cust.custid
  LEFT JOIN afw_company co ON p.cocode = co.cocode
  LEFT JOIN afw_employee exec ON p.execcode = exec.empcode
  LEFT JOIN afw_employee csr ON p.csrcode = csr.empcode
`

const BREAKDOWN_DIMENSIONS = {
  producer: {
    select: "p.execcode AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', exec.firstname, exec.lastname)), ''), p.execcode) AS label",
    join: "LEFT JOIN afw_employee exec ON p.execcode = exec.empcode"
  },
  carrier: {
    select: "p.cocode AS key, COALESCE(co.name, p.cocode) AS label",
    join: "LEFT JOIN afw_company co ON p.cocode = co.cocode"
  }
} as const

type GroupBy = keyof typeof BREAKDOWN_DIMENSIONS | "none"

export function registerUpcomingRenewalsTool(server: McpServer) {
  server.registerTool(
    "upcoming_renewals",
    {
      description: "Answer \"what's renewing soon?\" — active policy terms (afw_basicpolinfo) whose polexpdate falls within a day window from now. Excludes marketing/submission shells, non-active terms, and terms that already have a successor via priorpolid (already renewed). Resolves carrier/producer/CSR/customer names inline and flags whether a renewal transaction (RWL/RWQ) already exists. Optionally scope by producer, CSR, carrier, or type of business, and group by producer or carrier for a count plus premium sum/average within the window (e.g. \"premium renewing next quarter, by carrier\"). IMPORTANT: the resolved name fields sit alongside the raw csrcode/execcode (and, in a breakdown, alongside a raw `code`) — those raw codes (e.g. \"!!C\") are opaque AMS360 identifiers with no meaning to an end user and should never be surfaced in an answer; always report the resolved name instead.",
      inputSchema: {
        within_days: z.number().int().min(1).max(365).default(30).describe("Renewal window in days from now"),
        producer_code: z.string().describe("Exact match against producer/exec employee code (afw_basicpolinfo.execcode)").optional(),
        csr_code: z.string().describe("Exact match against CSR employee code (afw_basicpolinfo.csrcode)").optional(),
        carrier_code: z.string().describe("Exact match against carrier code (afw_basicpolinfo.cocode)").optional(),
        typeofbus: z.number().int().describe("Exact match against type-of-business code (afw_basicpolinfo.typeofbus)").optional(),
        group_by: z.enum(["producer", "carrier", "none"]).default("none").describe("Include a breakdown (count + premium sum/average) grouped by producer or carrier, scoped to the same renewal window"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return per page"),
        offset: z.number().int().min(0).default(0).describe("Number of results to skip")
      }
    },
    async ({ within_days, producer_code, csr_code, carrier_code, typeofbus, group_by, limit, offset }) => {
      try {
        const conditions = [...BASE_CONDITIONS]
        const params: unknown[] = [within_days]

        if(producer_code) {
          params.push(producer_code)
          conditions.push(`p.execcode = $${ params.length }`)
        }
        if(csr_code) {
          params.push(csr_code)
          conditions.push(`p.csrcode = $${ params.length }`)
        }
        if(carrier_code) {
          params.push(carrier_code)
          conditions.push(`p.cocode = $${ params.length }`)
        }
        if(typeofbus !== undefined) {
          params.push(typeofbus)
          conditions.push(`p.typeofbus = $${ params.length }`)
        }

        const whereClause = conditions.join(" AND ")

        const detailSql = `
          ${ CORE_QUERY }
          WHERE ${ whereClause }
          ORDER BY p.polexpdate ASC
          LIMIT ${ limit + 1 } OFFSET ${ offset }
        `

        let results = await runReadOnlyQuery(detailSql, params)

        let hasMore = false

        if(results.length > limit) {
          hasMore = true
          results = results.slice(0, limit)
        }

        const response: { breakdown?: Record<string, unknown>[]; results: unknown[]; has_more: boolean } = {
          results,
          has_more: hasMore
        }

        if(group_by !== "none") {
          const dimension = BREAKDOWN_DIMENSIONS[group_by as Exclude<GroupBy, "none">]
          const breakdownSql = `
            SELECT ${ dimension.select }, COUNT(*)::int AS count,
              SUM(p.fulltermpremium) AS premium_sum, AVG(p.fulltermpremium) AS premium_avg
            FROM afw_basicpolinfo p
            ${ dimension.join }
            WHERE ${ whereClause }
            GROUP BY 1, 2
            ORDER BY count DESC
          `
          const breakdownRows = await runReadOnlyQuery(breakdownSql, params) as {
            key: string; label: string; count: number; premium_sum: string | null; premium_avg: string | null
          }[]

          response.breakdown = breakdownRows.map((row) => ({
            code: row.key, label: row.label, count: row.count,
            premium_sum: row.premium_sum, premium_avg: row.premium_avg
          }))
        }

        return textResult(response)
      } catch(error) {
        logger.error({ err: error, within_days, producer_code, csr_code, carrier_code, typeofbus, group_by, limit, offset }, "upcoming_renewals failed")
        return errorResult(error)
      }
    }
  )
}
