import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../../config/config.js"
import { storeDownload } from "../../utils/downloadStore.js"
import { logger } from "../../utils/logger.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { downloadWindow, fetchPlRenewalChangeGroups } from "../../utils/plRenewalPremiumChange.js"
import { archivePlRenewalChange } from "../../utils/plRenewalPremiumChangeArchive.js"

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
// One call normally touches one client; a wide date range with no client filter is capped so a
// single chat turn can't build hundreds of files (the daily script has no such cap).
const MAX_WORKBOOKS_PER_CALL = 25

export function registerPlRenewalPremiumChangeTool(server: McpServer) {
  server.registerTool(
    "pl_renewal_premium_change",
    {
      description: "PL Renewal Premium Change: builds the PL team's own \"Renewal Calculator\" workbook (.xlsx) for a personal-lines renewal a carrier has downloaded (RWL). It compares the client's current (expiring) premium with the renewal premium per line: Homeowners, Automobile, Personal Articles, Watercraft, Umbrella, Flood, plus spare rows for Dwelling Fire, a second home and similar. It fills in the template's $ / monthly / % change formulas and the paste-ready note block for the AMS activity note (e.g. \"Acuity 10/18/2026 Renewal: Homeowners $3,646.00 RNWL $4,056.00 Annual Increase $410.00 Monthly Increase $34.17 11.25% … Account Total …\"). There is one workbook per client per renewal effective date, covering every PL policy renewing that day with a downloaded renewal, whichever day each downloaded. Accounts with a 6-month auto term use the template's 6-month table. Package policies are split by line, and Personal Articles scheduled on a homeowners policy is shown as its own line. Premiums are full-term. The expiring side is the prior term's post-endorsement premium. A policy whose premium can't be compared (prior term missing, $0, or negative/cancelled) is left out of the workbook and listed in `excluded` with the reason; never estimate those. Scope with `customer_name` (partial match) or `custid`, a single `policy_no`, and/or a download date range (`start_date`/`end_date`, inclusive, the date the renewal downloaded; defaults to the last 30 days). Every workbook is archived on the server for the PL Premium Change tool page (regenerating the same client/date overwrites it) and gets a 24-hour download link. Nothing is emailed. When presenting results, give the client, renewal date, account change and download link, and show `note` (column-aligned, for pasting into AMS) in a code block if the person wants the note text. Never surface internal ids.",
      inputSchema: {
        customer_name: z.string().min(2).describe("Partial, case-insensitive client name match").optional(),
        custid: z.string().describe("Exact customer id, when already known from another tool").optional(),
        policy_no: z.string().describe("Exact renewal-term policy number — builds that policy's whole client/renewal-date workbook").optional(),
        start_date: z.string().regex(DATE_ONLY_PATTERN, "Expected YYYY-MM-DD").describe("First download date to include (YYYY-MM-DD). Defaults to 30 days ago.").optional(),
        end_date: z.string().regex(DATE_ONLY_PATTERN, "Expected YYYY-MM-DD").describe("Last download date to include (YYYY-MM-DD, inclusive). Defaults to today.").optional()
      }
    },
    async ({ customer_name, custid, policy_no, start_date, end_date }) => {
      try {
        const { groups } = await fetchPlRenewalChangeGroups({
          ...downloadWindow(start_date, end_date),
          custid,
          customerName: customer_name,
          polno: policy_no
        })

        if(groups.length === 0) {
          return textResult({ count: 0, message: "No personal-lines renewal downloads matched. Try a wider start_date, or check the client name." })
        }

        const workbooks = []
        const skipped = []

        for(const group of groups.slice(0, MAX_WORKBOOKS_PER_CALL)) {
          const archived = await archivePlRenewalChange(group)
          if(!archived) {
            skipped.push({ client_name: group.client_name, renewal_date: group.renewal_date_label, excluded: group.excluded })
            continue
          }

          const { entry, buffer, overflow } = archived
          const token = storeDownload(buffer, entry.filename, XLSX_MIME_TYPE)
          workbooks.push({
            client_name: entry.client_name,
            renewal_date: entry.renewal_date_label,
            carriers: entry.carriers,
            policies: entry.polnos,
            term: entry.term,
            current_total: entry.current_total,
            renewal_total: entry.renewal_total,
            change_amount: entry.change_amount,
            change_percent: entry.change_percent,
            lines: group.lines.map(({ label, current, renewal, polno }) => ({ line: label, policy: polno, current, renewal })),
            note: entry.note,
            download_url: `${ publicBaseUrl }/downloads/${ token }`,
            ...(group.excluded.length ? { excluded: group.excluded } : {}),
            ...(overflow.length ? { did_not_fit: overflow } : {})
          })
        }

        return textResult({
          count: workbooks.length,
          truncated: groups.length > MAX_WORKBOOKS_PER_CALL,
          workbooks,
          ...(skipped.length ? { no_comparable_premiums: skipped } : {})
        })
      } catch(err) {
        logger.error({ err, customer_name, policy_no, start_date, end_date }, "pl_renewal_premium_change failed")
        return errorResult(err)
      }
    }
  )
}
