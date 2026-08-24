import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { resolveSince, resolveUntil } from "../utils/dateRange.js"
import { systemEmployeeCondition } from "../utils/employeeClassification.js"
import { logger } from "../utils/logger.js"
import { errorResult, textResult } from "../utils/mcpHelpers.js"

const DOMAIN_OPTIONS = ["policy_transaction", "policy", "claim", "invoice", "activity"] as const

const CUSTOMER_NAME_EXPR = "COALESCE(c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''))"

function changedByTypeExpr(changedByColumn: string): string {
  return `
    CASE WHEN EXISTS (
      SELECT 1 FROM afw_employee e
      WHERE e.empcode = ${ changedByColumn }
        AND NOT ${ systemEmployeeCondition("e") }
    ) THEN 'staff' ELSE 'system' END
  `
}

const FEED_SUBQUERY = `
  (
    SELECT
      pt.changeddate AS changed_at, pt.changedby AS changed_by,
      ${ changedByTypeExpr("pt.changedby") } AS changed_by_type,
      'policy_transaction' AS domain, bp.custid, pt.polid, c.csrcode,
      ${ CUSTOMER_NAME_EXPR } AS customer_name,
      bp.polno AS policy_no,
      pt.trantype || ': ' || pt.description AS summary,
      'afw_policytransaction' AS source_table,
      pt.polid::text || ':' || pt.effdate::text AS source_id
    FROM afw_policytransaction pt
    JOIN afw_basicpolinfo bp ON bp.polid = pt.polid
    LEFT JOIN afw_customer c ON c.custid = bp.custid
    WHERE pt.changeddate BETWEEN $1 AND $2

    UNION ALL

    SELECT
      bp.changeddate, bp.changedby,
      ${ changedByTypeExpr("bp.changedby") },
      'policy', bp.custid, bp.polid, c.csrcode,
      ${ CUSTOMER_NAME_EXPR },
      bp.polno,
      'Policy status: ' || bp.status,
      'afw_basicpolinfo', bp.polid::text
    FROM afw_basicpolinfo bp
    LEFT JOIN afw_customer c ON c.custid = bp.custid
    WHERE bp.changeddate BETWEEN $1 AND $2

    UNION ALL

    SELECT
      cl.changeddate, cl.changedby,
      ${ changedByTypeExpr("cl.changedby") },
      'claim', bp.custid, cl.polid, c.csrcode,
      ${ CUSTOMER_NAME_EXPR },
      bp.polno,
      'Claim ' || COALESCE(cl.claimno, cl.claimid::text) || ' (' || cl.claimstatus || ')',
      'afw_claim', cl.claimid::text
    FROM afw_claim cl
    JOIN afw_basicpolinfo bp ON bp.polid = cl.polid
    LEFT JOIN afw_customer c ON c.custid = bp.custid
    WHERE cl.changeddate BETWEEN $1 AND $2

    UNION ALL

    SELECT
      inv.changeddate, inv.changedby,
      ${ changedByTypeExpr("inv.changedby") },
      'invoice', inv.custid, inv.polid, c.csrcode,
      ${ CUSTOMER_NAME_EXPR },
      inv.polno,
      'Invoice #' || inv.invno || CASE WHEN inv.iscancelled = 'Y' THEN ' (voided)' ELSE '' END,
      'afw_invoice', inv.invid::text
    FROM afw_invoice inv
    LEFT JOIN afw_customer c ON c.custid = inv.custid
    WHERE inv.changeddate BETWEEN $1 AND $2

    UNION ALL

    SELECT
      tr.changeddate, tr.changedby,
      ${ changedByTypeExpr("tr.changedby") },
      'activity',
      COALESCE(bp.custid, CASE WHEN tr.entitytype = 4 THEN tr.entityid::uuid END),
      tr.polid, c.csrcode,
      ${ CUSTOMER_NAME_EXPR },
      tr.polno,
      tr.commenttran,
      'afw_transaction', tr.tranid::text
    FROM afw_transaction tr
    LEFT JOIN afw_basicpolinfo bp ON bp.polid = tr.polid
    LEFT JOIN afw_customer c ON c.custid = COALESCE(bp.custid, CASE WHEN tr.entitytype = 4 THEN tr.entityid::uuid END)
    WHERE tr.changeddate BETWEEN $1 AND $2
  ) feed
`

const FEED_FILTER = `
  ($3::text[] IS NULL OR domain = ANY($3))
  AND ($4::text IS NULL OR changed_by_type = $4)
  AND ($5::uuid IS NULL OR custid = $5)
  AND ($6::uuid IS NULL OR polid = $6)
  AND ($7::text IS NULL OR csrcode = $7)
`

const DETAIL_QUERY = `
  SELECT changed_at, changed_by, changed_by_type, domain, customer_name, policy_no, summary, source_table, source_id
  FROM ${ FEED_SUBQUERY }
  WHERE ${ FEED_FILTER }
  ORDER BY changed_at DESC
  LIMIT $8 OFFSET $9
`

const BREAKDOWN_QUERIES = {
  domain: `
    SELECT domain AS key, COUNT(*)::int AS count
    FROM ${ FEED_SUBQUERY }
    WHERE ${ FEED_FILTER }
    GROUP BY 1
    ORDER BY count DESC
  `,
  changed_by_type: `
    SELECT changed_by_type AS key, COUNT(*)::int AS count
    FROM ${ FEED_SUBQUERY }
    WHERE ${ FEED_FILTER }
    GROUP BY 1
    ORDER BY count DESC
  `
}

type GroupBy = "domain" | "changed_by_type" | "none"

export function registerActivityFeedTool(server: McpServer) {
  server.registerTool(
    "activity_feed",
    {
      description: "Answer \"what's changed lately\" by querying changeddate/changedby across policy transactions, policy term changes, claims, invoices, and staff activity notes, joined back to customer/policy context. Accepts a required time window (ISO timestamp or relative shorthand like \"24h\"/\"7d\"/\"30d\"), with optional domain/changed-by-type/customer/policy/CSR scoping and pagination. Optionally group counts by domain or changed-by-type.",
      inputSchema: {
        since: z.string().describe('Start of window: ISO timestamp or relative shorthand ("1h", "24h", "7d", "30d")'),
        until: z.string().describe("End of window, ISO timestamp. Defaults to now").optional(),
        domains: z.array(z.enum(DOMAIN_OPTIONS)).describe("Subset of domains to include. Defaults to all").optional(),
        changed_by_type: z.enum(["system", "staff", "any"]).default("any").describe("Filter to system-driven or staff-driven changes"),
        custid: z.string().uuid().describe("Scope to one customer").optional(),
        polid: z.string().uuid().describe("Scope to one policy").optional(),
        csr_code: z.string().describe("Scope to customers assigned to one CSR (exact match against afw_customer.csrcode)").optional(),
        group_by: z.enum(["domain", "changed_by_type", "none"]).default("none").describe("Include a breakdown summary grouped by domain or changed-by-type"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return per page"),
        offset: z.number().int().min(0).default(0).describe("Number of results to skip")
      }
    },
    async ({ since, until, domains, changed_by_type, custid, polid, csr_code, group_by, limit, offset }) => {
      try {
        const sinceDate = resolveSince(since)
        const untilDate = resolveUntil(until)
        const domainsParam = domains && domains.length > 0 ? domains : null
        const changedByTypeParam = changed_by_type === "any" ? null : changed_by_type
        const filterParams = [sinceDate, untilDate, domainsParam, changedByTypeParam, custid ?? null, polid ?? null, csr_code ?? null]

        let rows = await runReadOnlyQuery(DETAIL_QUERY, [...filterParams, limit + 1, offset])

        let hasMore = false

        if(rows.length > limit) {
          hasMore = true
          rows = rows.slice(0, limit)
        }

        const response: { breakdown?: Record<string, unknown>[]; results: unknown[]; has_more: boolean } = {
          results: rows,
          has_more: hasMore
        }

        if(group_by !== "none") {
          const breakdownKey = group_by as Exclude<GroupBy, "none">
          const breakdownRows = await runReadOnlyQuery(BREAKDOWN_QUERIES[breakdownKey], filterParams) as { key: string; count: number }[]

          response.breakdown = breakdownRows.map((row) => ({ [breakdownKey]: row.key, count: row.count }))
        }

        return textResult(response)
      } catch(error) {
        logger.error({ err: error, since, until, domains, changed_by_type, custid, polid, csr_code, group_by, limit, offset }, "activity_feed failed")
        return errorResult(error)
      }
    }
  )
}
