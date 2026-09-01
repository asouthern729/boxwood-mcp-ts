import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerCustomerLookupTool } from "./tools/customerLookup.js"
import { registerPolicyQueryTool } from "./tools/policyQuery.js"
import { registerInvoiceLookupTool } from "./tools/invoiceLookup.js"
import { registerActivityFeedTool } from "./tools/activityFeed.js"
import { registerUpcomingRenewalsTool } from "./tools/upcomingRenewals.js"
import { registerClaimLookupTool } from "./tools/claimLookup.js"
import { registerBookSummaryTool } from "./tools/bookSummary.js"
import { registerEmployeeLookupTool } from "./tools/employeeLookup.js"
import { registerCertificateLookupTool } from "./tools/certificateLookup.js"
import { registerDownloadReportTool } from "./tools/downloadReport.js"
import { registerDownloadReportWorkbookTool } from "./tools/downloadReportWorkbook.js"

export function createServer() {
  const server = new McpServer({
    name: "boxwood-mcp-ts",
    version: "1.0.0"
  })

  registerCustomerLookupTool(server)
  registerPolicyQueryTool(server)
  registerInvoiceLookupTool(server)
  registerActivityFeedTool(server)
  registerUpcomingRenewalsTool(server)
  registerClaimLookupTool(server)
  registerBookSummaryTool(server)
  registerEmployeeLookupTool(server)
  registerCertificateLookupTool(server)
  registerDownloadReportTool(server)
  registerDownloadReportWorkbookTool(server)

  return server
}
