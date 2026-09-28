import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { logger } from "../../utils/logger.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { activityLineHeader, downloadWindow, fetchPlRenewalPremiumChanges, formatActivityLine } from "../../utils/plRenewalPremiumChange.js"

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function registerPlRenewalPremiumChangeTool(server: McpServer) {
  server.registerTool(
    "pl_renewal_premium_change",
    {
      description: "PL Renewal Premium Change — for personal-lines renewals a carrier downloaded (afw_policytransaction trantype RWL, typeofbus=1), compares each renewal term's full-term premium against the expiring term it replaces and returns the $ and % change, plus a ready-to-paste tab-delimited line per policy for an AMS activity note (`activity_lines`, with `activity_header` as the column row). Scope by client (`customer_name` partial match, or `custid`), a single `policy_no`, and/or a download date range (`start_date`/`end_date`, inclusive, on the date the renewal downloaded — defaults to the last 30 days). Expiring premium is the prior term's endorsed full-term premium at expiration; renewal premium is the new term's full-term premium. When either side is $0/missing (common on Flood downloads) the change is left blank and `note` says why — never report a change the data can't support. When presenting results, give the activity lines inside a code block so tabs survive copy/paste. `csr_name` is for routing only; never surface internal ids.",
      inputSchema: {
        customer_name: z.string().min(2).describe("Partial, case-insensitive client name match").optional(),
        custid: z.string().describe("Exact customer id, when already known from another tool").optional(),
        policy_no: z.string().describe("Exact renewal-term policy number").optional(),
        start_date: z.string().regex(DATE_ONLY_PATTERN, "Expected YYYY-MM-DD").describe("First download date to include (YYYY-MM-DD). Defaults to 30 days ago.").optional(),
        end_date: z.string().regex(DATE_ONLY_PATTERN, "Expected YYYY-MM-DD").describe("Last download date to include (YYYY-MM-DD, inclusive). Defaults to today.").optional()
      }
    },
    async ({ customer_name, custid, policy_no, start_date, end_date }) => {
      try {
        const { renewals, truncated } = await fetchPlRenewalPremiumChanges({
          ...downloadWindow(start_date, end_date),
          custid,
          customerName: customer_name,
          polno: policy_no
        })

        return textResult({
          count: renewals.length,
          truncated,
          renewals,
          activity_header: activityLineHeader(),
          activity_lines: renewals.map(formatActivityLine)
        })
      } catch(err) {
        logger.error({ err, customer_name, policy_no, start_date, end_date }, "pl_renewal_premium_change failed")
        return errorResult(err)
      }
    }
  )
}
