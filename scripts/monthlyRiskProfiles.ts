// Monthly batch build of the CL "Pre-Renewal Review" (risk_profile MCP tool) — the companion to
// scripts/monthlyRenewalPremiumSummaries.ts, on the same schedule per Patrick (2026-09-15): "Run on
// the 1st of the month for all policies/accounts renewing 60 days later. Oct 1 should create these
// for all accounts renewing in December." Run on the 1st of month M, this covers every commercial
// account with a policy expiring in month M+2, one document per account.
//
// Each account's document combines only its policies expiring in the target month — an earlier
// renewal on the same account (e.g. a November policy on a December run) was already covered by an
// earlier month's run, and including it would also change the combined set's archive key. Policies
// renewing after the target month are excluded by the resolve window itself.
//
// Calls generateRiskProfile() (src/utils/riskProfileGenerate.ts) directly — the same build+archive
// the interactive tool uses, no MCP transport or LLM turn. No email; archives to
// scripts/output/cl-risk-profile/, whose manifest.json backs the risk-profile index page.
//
// Usage: npx tsx scripts/monthlyRiskProfiles.ts [--month=YYYY-MM]
//   --month  overrides the target month (for manual/backtesting runs) instead of computing
//            "current month + 2" from today's date.

import "dotenv/config"
import { formatDate, resolveClPolicies } from "../src/utils/clPolicyData.js"
import { generateRiskProfile } from "../src/utils/riskProfileGenerate.js"
import { discoverCommercialAccounts, monthArgFromArgv, resolveTargetMonthWindow } from "../src/utils/monthlyRenewalWindow.js"

async function main() {
  const targetWindow = resolveTargetMonthWindow(monthArgFromArgv(process.argv.slice(2)))
  const { startDate, endDate, renewalWithinDays } = targetWindow

  console.log(`[monthlyRiskProfiles] target month ${ startDate } – ${ endDate } (renewal_within_days=${ renewalWithinDays })`)

  const accounts = await discoverCommercialAccounts(targetWindow)
  console.log(`[monthlyRiskProfiles] ${ accounts.length } commercial account(s) with a policy expiring in this window`)

  const generated: { custid: string; clientName: string; polnos: string }[] = []
  const skipped: { custid: string; customerName: string | null; reason: string }[] = []
  const failed: { custid: string; customerName: string | null; error: string }[] = []

  for(const { custid, customer_name } of accounts) {
    try {
      const resolution = await resolveClPolicies({ custid, renewal_within_days: renewalWithinDays })

      if(resolution.kind !== "ok") {
        // Shouldn't normally happen given discovery mirrors resolution's own filter, but a policy
        // could be cancelled/renewed between the two — a benign skip, not a failure.
        const reason = resolution.kind === "error" ? resolution.error.message : resolution.payload.message
        skipped.push({ custid, customerName: customer_name, reason })
        continue
      }

      const inMonth = resolution.matches.filter((m) => formatDate(m.polexpdate) >= startDate)

      if(inMonth.length === 0) {
        skipped.push({ custid, customerName: customer_name, reason: "no policy actually in the target month as of generation" })
        continue
      }

      const { polnoLabel, includedSections } = await generateRiskProfile(inMonth, resolution.clientName)
      generated.push({ custid, clientName: resolution.clientName, polnos: polnoLabel })
      console.log(`[monthlyRiskProfiles] generated ${ resolution.clientName } (${ polnoLabel }) — ${ includedSections.length } section(s)`)
    } catch(error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ custid, customerName: customer_name, error: message })
      console.error(`[monthlyRiskProfiles] FAILED custid=${ custid } (${ customer_name ?? "unknown" }): ${ message }`)
    }
  }

  console.log(`[monthlyRiskProfiles] done — generated ${ generated.length }, skipped ${ skipped.length }, failed ${ failed.length }`)
  if(skipped.length > 0) console.log("[monthlyRiskProfiles] skipped:", skipped)
  if(failed.length > 0) console.log("[monthlyRiskProfiles] failed:", failed)

  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error("[monthlyRiskProfiles] fatal:", error)
  process.exit(1)
})
