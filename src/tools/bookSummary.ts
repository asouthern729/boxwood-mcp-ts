import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { systemEmployeeCondition } from "../utils/employeeClassification.js"
import { logger } from "../utils/logger.js"
import { errorResult, textResult } from "../utils/mcpHelpers.js"

// Book (policy/premium) and claims metrics are always computed as two separate aggregate
// queries and merged by key in JS, never joined into one query — joining afw_custlosshist
// into a SUM(fulltermpremium) query would fan out one policy row per claim on it, multiplying
// that policy's premium into the sum once per claim.
const DIMENSIONS = {
  producer: {
    bookSelect: "p.execcode AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', exec.firstname, exec.lastname)), ''), p.execcode) AS label",
    bookJoin: "LEFT JOIN afw_employee exec ON p.execcode = exec.empcode",
    claimsSelect: "pol.execcode AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', exec.firstname, exec.lastname)), ''), pol.execcode) AS label",
    claimsJoin: "LEFT JOIN afw_employee exec ON pol.execcode = exec.empcode",
    hasPremium: true,
    employeeCodeColumn: "execcode"
  },
  csr: {
    bookSelect: "p.csrcode AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), p.csrcode) AS label",
    bookJoin: "LEFT JOIN afw_employee csr ON p.csrcode = csr.empcode",
    claimsSelect: "pol.csrcode AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), pol.csrcode) AS label",
    claimsJoin: "LEFT JOIN afw_employee csr ON pol.csrcode = csr.empcode",
    hasPremium: true,
    employeeCodeColumn: "csrcode"
  },
  carrier: {
    bookSelect: "p.cocode AS key, COALESCE(co.name, p.cocode) AS label",
    bookJoin: "LEFT JOIN afw_company co ON p.cocode = co.cocode",
    claimsSelect: "pol.cocode AS key, COALESCE(co.name, pol.cocode) AS label",
    claimsJoin: "LEFT JOIN afw_company co ON pol.cocode = co.cocode",
    hasPremium: true,
    employeeCodeColumn: null
  },
  // A package policy can carry multiple LOB lines (afw_lineofbusiness), but premium is only
  // stored once per policy term — summing whole-policy premium once per LOB line would
  // multi-count revenue, so LOB grouping omits premium entirely rather than guessing.
  lob: {
    bookSelect: "l.lineofbus AS key, COALESCE(lo.descriptionlobs, l.lineofbus) AS label",
    bookJoin: "JOIN afw_lineofbusiness l ON l.polid = p.polid LEFT JOIN afw_lobsetup lo ON l.lineofbus = lo.namelobs",
    claimsSelect: "h.lineofbus AS key, COALESCE(lo.descriptionlobs, h.lineofbus) AS label",
    claimsJoin: "LEFT JOIN afw_lobsetup lo ON h.lineofbus = lo.namelobs",
    hasPremium: false,
    employeeCodeColumn: null
  }
} as const

type GroupBy = keyof typeof DIMENSIONS

export function registerBookSummaryTool(server: McpServer) {
  server.registerTool(
    "book_summary",
    {
      description: "Roll up the current active book (afw_basicpolinfo, status='A', excluding marketing/submission shells) by producer, CSR, carrier, or line of business: policy count, customer count, premium sum/average, and all-time claim count/paid total. Premium is not available when grouping by line of business, since a package policy's premium can't be safely split across its multiple LOB lines without double-counting revenue. Claims figures are all-time, not a rolling window. Optionally scope to one producer, CSR, carrier, or type of business before grouping.",
      inputSchema: {
        group_by: z.enum(Object.keys(DIMENSIONS) as [GroupBy, ...GroupBy[]]).describe("Dimension to roll the book up by"),
        producer_code: z.string().describe("Scope to one producer/exec employee code before grouping").optional(),
        csr_code: z.string().describe("Scope to one CSR employee code before grouping").optional(),
        carrier_code: z.string().describe("Scope to one carrier code before grouping").optional(),
        typeofbus: z.number().int().describe("Scope to one type-of-business code before grouping").optional()
      }
    },
    async ({ group_by, producer_code, csr_code, carrier_code, typeofbus }) => {
      try {
        const dim = DIMENSIONS[group_by]

        const bookConditions = ["p.status = 'A'", "p.polsubtype != 'S'"]
        const bookParams: unknown[] = []

        if(producer_code) {
          bookParams.push(producer_code)
          bookConditions.push(`p.execcode = $${ bookParams.length }`)
        }
        if(csr_code) {
          bookParams.push(csr_code)
          bookConditions.push(`p.csrcode = $${ bookParams.length }`)
        }
        if(carrier_code) {
          bookParams.push(carrier_code)
          bookConditions.push(`p.cocode = $${ bookParams.length }`)
        }
        if(typeofbus !== undefined) {
          bookParams.push(typeofbus)
          bookConditions.push(`p.typeofbus = $${ bookParams.length }`)
        }
        // Excludes rows for known AMS360 system/integration accounts (e.g. the "DBO" default
        // bucket) surfacing as if they were a real producer/CSR — see systemEmployeeCondition.
        if(dim.employeeCodeColumn) {
          bookConditions.push(`NOT EXISTS (SELECT 1 FROM afw_employee e WHERE e.empcode = p.${ dim.employeeCodeColumn } AND ${ systemEmployeeCondition("e") })`)
        }

        const premiumColumns = dim.hasPremium ? ", SUM(p.fulltermpremium) AS premium_sum, AVG(p.fulltermpremium) AS premium_avg" : ""

        const bookSql = `
          SELECT ${ dim.bookSelect },
            COUNT(DISTINCT p.polid)::int AS policy_count,
            COUNT(DISTINCT p.custid)::int AS customer_count
            ${ premiumColumns }
          FROM afw_basicpolinfo p
          ${ dim.bookJoin }
          WHERE ${ bookConditions.join(" AND ") }
          GROUP BY 1, 2
        `

        // Same "current active book" scope as the book query — without this, claims tied to
        // expired/cancelled/renewed-over policies or marketing shells surface as phantom
        // groups (policy_count: 0, claim_count > 0) for a producer/CSR/carrier who no longer
        // — or never really did — service that policy as part of the current book.
        const claimsConditions: string[] = ["pol.status = 'A'", "pol.polsubtype != 'S'"]
        const claimsParams: unknown[] = []

        if(producer_code) {
          claimsParams.push(producer_code)
          claimsConditions.push(`pol.execcode = $${ claimsParams.length }`)
        }
        if(csr_code) {
          claimsParams.push(csr_code)
          claimsConditions.push(`pol.csrcode = $${ claimsParams.length }`)
        }
        if(carrier_code) {
          claimsParams.push(carrier_code)
          claimsConditions.push(`pol.cocode = $${ claimsParams.length }`)
        }
        if(typeofbus !== undefined) {
          claimsParams.push(typeofbus)
          claimsConditions.push(`pol.typeofbus = $${ claimsParams.length }`)
        }
        if(dim.employeeCodeColumn) {
          claimsConditions.push(`NOT EXISTS (SELECT 1 FROM afw_employee e WHERE e.empcode = pol.${ dim.employeeCodeColumn } AND ${ systemEmployeeCondition("e") })`)
        }

        const claimsWhereClause = `WHERE ${ claimsConditions.join(" AND ") }`

        // afw_custlosshist.claimid is never null (confirmed against real data), so the inner
        // joins here don't drop any loss-history rows.
        const claimsSql = `
          SELECT ${ dim.claimsSelect },
            COUNT(*)::int AS claim_count,
            SUM(h.amountpaid) AS claims_paid_total
          FROM afw_custlosshist h
          JOIN afw_claim cl ON h.claimid = cl.claimid
          JOIN afw_basicpolinfo pol ON cl.polid = pol.polid
          ${ dim.claimsJoin }
          ${ claimsWhereClause }
          GROUP BY 1, 2
        `

        const bookRows = await runReadOnlyQuery(bookSql, bookParams) as {
          key: string; label: string; policy_count: number; customer_count: number
          premium_sum: string | null; premium_avg: string | null
        }[]
        const claimsRows = await runReadOnlyQuery(claimsSql, claimsParams) as {
          key: string; label: string; claim_count: number; claims_paid_total: string | null
        }[]

        const merged = new Map<string, Record<string, unknown>>()

        for(const row of bookRows) {
          merged.set(row.key, {
            code: row.key,
            label: row.label,
            policy_count: row.policy_count,
            customer_count: row.customer_count,
            ...(dim.hasPremium ? { premium_sum: row.premium_sum, premium_avg: row.premium_avg } : {}),
            claim_count: 0,
            claims_paid_total: 0
          })
        }

        for(const row of claimsRows) {
          const existing = merged.get(row.key)

          if(existing) {
            existing.claim_count = row.claim_count
            existing.claims_paid_total = row.claims_paid_total ?? 0
          } else {
            merged.set(row.key, {
              code: row.key,
              label: row.label,
              policy_count: 0,
              customer_count: 0,
              ...(dim.hasPremium ? { premium_sum: null, premium_avg: null } : {}),
              claim_count: row.claim_count,
              claims_paid_total: row.claims_paid_total ?? 0
            })
          }
        }

        const rows = [...merged.values()].sort((a, b) => (b.policy_count as number) - (a.policy_count as number))

        return textResult({ group_by, rows })
      } catch(error) {
        logger.error({ err: error, group_by, producer_code, csr_code, carrier_code, typeofbus }, "book_summary failed")
        return errorResult(error)
      }
    }
  )
}
