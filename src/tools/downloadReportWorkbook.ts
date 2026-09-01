import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../config/config.js"
import type { WorkbookInput } from "../utils/downloadWorkbook.js"
import { buildDownloadReportWorkbook } from "../utils/downloadWorkbook.js"
import { getDownload, storeDownload } from "../utils/downloadStore.js"
import { errorResult } from "../utils/mcpHelpers.js"
import { logger } from "../utils/logger.js"

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

const accuracyVerdictSchema = z.object({
  status: z.enum(["matches", "no_match", "rejected", "verify"]).describe("matches: the download lines up with a documented client request. no_match/rejected: it doesn't, or nothing documented explains it — needs follow-up. verify: plausible but not confidently confirmed from the notes available"),
  note: z.string().describe("One or two sentences citing what in candidate_prior_activity supports (or fails to support) this verdict")
})

const verdictSchema = z.object({
  item_id: z.number().describe("The item_id of the flagged item this verdict is for, from download_report's `flagged_items`"),
  accuracy: accuracyVerdictSchema
})

export function registerDownloadReportWorkbookTool(server: McpServer) {
  server.registerTool(
    "download_report_workbook",
    {
      description: "Stage 2 of the morning download review — renders download_report's output into the actual distributable .xlsx workbook a rep reads (one Summary tab plus one tab per representative, color-coded flagged rows and accuracy verdicts), matching Morning_Download_Action_List_Example.xlsx in the repo root. This tool ONLY renders — it does not judge anything itself. Pass `report_token` exactly as returned by download_report (it re-fetches that call's full dataset — every item, not just the flagged ones you saw inline — so nothing needs to be re-sent here) plus `verdicts`: one `{item_id, accuracy}` entry for each FLAGGED item from download_report's `flagged_items` — read its `candidate_prior_activity` (staff notes) and decide an `accuracy` verdict (matches/no_match/rejected/verify + a short note); that reasoning step is intentionally left to the caller, same as download_report's own tool description says. Non-flagged items don't need a verdict (they render as \"Routine\"/\"Informational\" automatically); a flagged item with no matching entry in `verdicts` renders as \"Needs review\" rather than silently reading as fine. Returns a plain download link (`https://mcp.boxwoodins.com/downloads/<token>`, valid 24 hours) rather than embedding the file in the tool result — pass this URL back to the user as-is; do not try to open, decode, or re-interpret it as anything other than a link for them to click.",
      inputSchema: {
        report_token: z.string().describe("The `report_token` from download_report's response for this same window — tokens expire after 24 hours, same as this tool's own returned link"),
        verdicts: z.array(verdictSchema).describe("One entry per FLAGGED item you judged from download_report's `flagged_items` — omit an item and it renders as \"Needs review\"")
      }
    },
    async ({ report_token, verdicts }) => {
      try {
        const entry = getDownload(report_token)

        if(!entry) {
          return errorResult(new Error(`report_token "${ report_token }" was not found or has expired (report links expire after 24 hours) — call download_report again to get a fresh token`))
        }

        const stored = JSON.parse(entry.buffer.toString("utf8")) as WorkbookInput
        const verdictByItemId = new Map(verdicts.map((v) => [v.item_id, v.accuracy]))

        for(const rep of stored.reps) {
          for(const item of rep.items) {
            const accuracy = verdictByItemId.get(item.item_id)
            if(accuracy) item.accuracy = accuracy
          }
        }

        const buffer = await buildDownloadReportWorkbook(stored)

        const itemCount = stored.reps.reduce((sum, rep) => sum + rep.items.length, 0)
        const flaggedCount = stored.reps.reduce((sum, rep) => sum + rep.items.filter((item) => item.flagged).length, 0)
        const dateSlug = stored.window.until.slice(0, 10)
        const filename = `morning-download-action-list-${ dateSlug }.xlsx`

        const token = storeDownload(buffer, filename, XLSX_MIME_TYPE)
        const downloadUrl = `${ publicBaseUrl }/downloads/${ token }`

        return {
          content: [
            { type: "text" as const, text: `Built the Morning Download Action List — ${ stored.reps.length } rep(s), ${ itemCount } item(s), ${ flaggedCount } flagged for review.\n\nDownload: ${ downloadUrl }\n\n(Link expires in 24 hours.)` }
          ]
        }
      } catch(error) {
        logger.error({ err: error, report_token }, "download_report_workbook failed")
        return errorResult(error)
      }
    }
  )
}
