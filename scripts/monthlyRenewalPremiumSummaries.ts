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
import { runReadOnlyQuery } from "../src/db.js"
import { generateRenewalPremiumSummary, NoCommercialPoliciesError } from "../src/utils/renewalPremiumSummaryGenerate.js"

// Mirrors generateRenewalPremiumSummary's own ACCOUNT_POLICIES_QUERY "genuinely in force" filter
// (typeofbus=2, polsubtype!='S', status!='D', poleffdate<=now()) exactly, so every custid this
// discovers is guaranteed to actually produce a workbook — deliberately NOT upcoming_renewals'
// filter (renewalrptflag='A' + not-yet-renewed), which answers a different question and would
// drift out of sync with what generation itself considers "in force." DISTINCT because an account
// can have more than one commercial policy expiring in the same target month.
const DISCOVERY_QUERY = `
  SELECT DISTINCT p.custid,
    COALESCE(c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''), c.firmnamecust) AS customer_name
  FROM afw_basicpolinfo p
  LEFT JOIN afw_customer c ON c.custid = p.custid
  WHERE p.typeofbus = 2
    AND p.polsubtype != 'S'
    AND p.status != 'D'
    AND p.poleffdate <= now()
    AND p.polexpdate BETWEEN $1::date AND $2::date
  ORDER BY customer_name
`

type DiscoveredAccount = { custid: string; customer_name: string | null }

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// current month + 2, with year rollover (e.g. run in November → target January of next year).
function resolveTargetMonth(monthArg: string | undefined): { year: number; month: number } {
  if(monthArg) {
    const match = monthArg.match(/^(\d{4})-(\d{2})$/)
    if(!match) throw new Error(`--month must be YYYY-MM, got "${ monthArg }"`)
    return { year: Number(match[1]), month: Number(match[2]) - 1 }
  }

  const now = new Date()
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1))
  return { year: target.getUTCFullYear(), month: target.getUTCMonth() }
}

function targetMonthBounds(year: number, month: number): { startDate: string; endDate: string } {
  const start = new Date(Date.UTC(year, month, 1))
  const end = new Date(Date.UTC(year, month + 1, 0)) // day 0 of next month = last day of this one
  return { startDate: toDateString(start), endDate: toDateString(end) }
}

// Sized so every renewal through the end of the target month lands in the main table (per-run
// window, not a fixed 90-day default) — +1 day of buffer against any time-of-day component on
// polexpdate so the last day of the month is never clipped by the cutoff comparison.
function renewalWithinDaysThrough(endDate: string): number {
  const now = new Date()
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const endUtc = new Date(`${ endDate }T00:00:00Z`).getTime()
  return Math.max(1, Math.ceil((endUtc - todayUtc) / (24 * 60 * 60 * 1000)) + 1)
}

async function main() {
  const monthArg = process.argv.slice(2).find((arg) => arg.startsWith("--month="))?.split("=")[1]
  const { year, month } = resolveTargetMonth(monthArg)
  const { startDate, endDate } = targetMonthBounds(year, month)
  const renewalWithinDays = renewalWithinDaysThrough(endDate)

  console.log(`[monthlyRenewalPremiumSummaries] target month ${ startDate } – ${ endDate } (renewal_within_days=${ renewalWithinDays })`)

  const accounts = await runReadOnlyQuery(DISCOVERY_QUERY, [startDate, endDate]) as DiscoveredAccount[]
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
