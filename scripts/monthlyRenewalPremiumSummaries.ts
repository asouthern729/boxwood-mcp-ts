// Monthly batch build of Patrick's "Commercial Renewal Premium Summary" workbook
// (renewal_premium_summary MCP tool) for every commercial account with a policy expiring two
// calendar months out — run on the 1st of month M, this covers everything expiring in month M+2,
// so the workbook is already archived by the time an account manager starts renewal prep.
//
// Calls generateRenewalPremiumSummary() (src/utils/renewalPremiumSummaryGenerate.ts) directly —
// the same build+archive logic the interactive MCP tool uses, extracted into a plain function so
// this script doesn't need an MCP transport or a Claude Agent SDK/LLM turn per account (unlike
// scripts/morningDownload.ts's pattern, there's nothing here for an LLM to decide; every custid is
// already known from the discovery query below). No email is sent — per direction to back off
// automated email except the download-report job, this script only generates + archives to
// scripts/output/cl-renewal-premium-summaries/; the manifest.json it updates is what the
// renewal-premium-summaries index page (and, eventually, the download site) reads from.
//
// Usage: npx tsx scripts/monthlyRenewalPremiumSummaries.ts [--month=YYYY-MM]
//   --month  overrides the target month (for manual/backtesting runs) instead of computing
//            "current month + 2" from today's date.

import "dotenv/config"
import { generateRenewalPremiumSummary, NoCommercialPoliciesError } from "../src/utils/renewalPremiumSummaryGenerate.js"
import { discoverCommercialAccounts, monthArgFromArgv, resolveTargetMonthWindow } from "../src/utils/monthlyRenewalWindow.js"

// Target month + account discovery are shared with scripts/monthlyRiskProfiles.ts (Patrick's
// companion job, same schedule) — see src/utils/monthlyRenewalWindow.ts.
async function main() {
  const targetWindow = resolveTargetMonthWindow(monthArgFromArgv(process.argv.slice(2)))
  const { startDate, endDate, renewalWithinDays } = targetWindow

  console.log(`[monthlyRenewalPremiumSummaries] target month ${ startDate } – ${ endDate } (renewal_within_days=${ renewalWithinDays })`)

  const accounts = await discoverCommercialAccounts(targetWindow)
  console.log(`[monthlyRenewalPremiumSummaries] ${ accounts.length } commercial account(s) with a policy expiring in this window`)

  const generated: { custid: string; clientName: string; includedCount: number; filename: string }[] = []
  const skipped: { custid: string; customerName: string | null; reason: string }[] = []
  const failed: { custid: string; customerName: string | null; error: string }[] = []

  for(const { custid, customer_name } of accounts) {
    try {
      const result = await generateRenewalPremiumSummary({ custid, renewalWithinDays, windowStartDate: startDate })

      if(result.status === "no_policies_in_window") {
        // Shouldn't normally happen given the discovery query mirrors generation's own filter, but
        // a policy could be cancelled/renewed between discovery and this call — treated as a
        // benign skip, not a failure.
        skipped.push({ custid, customerName: customer_name, reason: `no policy actually in window as of generation (soonest renewal ${ result.soonestRenewalDate })` })
        continue
      }

      generated.push({ custid, clientName: result.clientName, includedCount: result.includedCount, filename: result.filename })
      console.log(`[monthlyRenewalPremiumSummaries] generated ${ result.filename } (${ result.includedCount } policy/policies)`)
    } catch(error) {
      if(error instanceof NoCommercialPoliciesError) {
        skipped.push({ custid, customerName: customer_name, reason: error.message })
        continue
      }

      const message = error instanceof Error ? error.message : String(error)
      failed.push({ custid, customerName: customer_name, error: message })
      console.error(`[monthlyRenewalPremiumSummaries] FAILED custid=${ custid } (${ customer_name ?? "unknown" }): ${ message }`)
    }
  }

  console.log(`[monthlyRenewalPremiumSummaries] done — generated ${ generated.length }, skipped ${ skipped.length }, failed ${ failed.length }`)
  if(skipped.length > 0) console.log("[monthlyRenewalPremiumSummaries] skipped:", skipped)
  if(failed.length > 0) console.log("[monthlyRenewalPremiumSummaries] failed:", failed)

  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error("[monthlyRenewalPremiumSummaries] fatal:", error)
  process.exit(1)
})
