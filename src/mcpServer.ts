import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerCustomerLookupTool } from "./tools/customers/customerLookup.js"
import { registerPolicyQueryTool } from "./tools/policies/policyQuery.js"
import { registerInvoiceLookupTool } from "./tools/invoices/invoiceLookup.js"
import { registerActivityFeedTool } from "./tools/activity/activityFeed.js"
import { registerUpcomingRenewalsTool } from "./tools/renewals/upcomingRenewals.js"
import { registerPlRenewalPremiumChangeTool } from "./tools/renewals/plRenewalPremiumChange.js"
import { registerClaimLookupTool } from "./tools/claims/claimLookup.js"
import { registerBookSummaryTool } from "./tools/bookSummary.js"
import { registerEmployeeLookupTool } from "./tools/employeeLookup.js"
import { registerCertificateLookupTool } from "./tools/certificates/certificateLookup.js"
import { registerDownloadReportTool } from "./tools/downloads/downloadReport.js"
import { registerDownloadReportWorkbookTool } from "./tools/downloads/downloadReportWorkbook.js"
import { registerRiskProfileTool } from "./tools/policies/riskProfile.js"
import { registerClRenewalSummaryTool } from "./tools/policies/clRenewalSummary.js"
import { registerPlRenewalSummaryTool } from "./tools/policies/plRenewalSummary.js"
import { registerRenewalPremiumSummaryTool } from "./tools/policies/renewalPremiumSummary.js"

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
  registerPlRenewalPremiumChangeTool(server)
  registerClaimLookupTool(server)
  registerBookSummaryTool(server)
  registerEmployeeLookupTool(server)
  registerCertificateLookupTool(server)
  registerDownloadReportTool(server)
  registerDownloadReportWorkbookTool(server)
  registerRiskProfileTool(server)
  registerClRenewalSummaryTool(server)
  registerPlRenewalSummaryTool(server)
  registerRenewalPremiumSummaryTool(server)

  return server
}
