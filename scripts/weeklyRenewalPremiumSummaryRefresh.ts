// Weekly touch-up of every archived commercial Renewal Premium Summary workbook
// (scripts/output/cl-renewal-premium-summaries/, built monthly by monthlyRenewalPremiumSummaries.ts).
// Walks the manifest and runs the same Refresh the index page's button does
// (refreshRenewalPremiumSummary, src/utils/renewalPremiumSummaryRefresh.ts) against each one: fills a
// still-blank Renewal cell once AMS360 has a priced successor term, and updates Current when AMS360's
// figure has changed and nobody has edited that cell by hand. A workbook is only rewritten when at
// least one of those cells actually changes — and even then only those cells, never an employee's
// notes or anything else in the file (see that function's own comments for every guard).
//
// No email — per direction to back off automated email except the download-report job; the log is
// the record of what changed.
//
// Usage: npx tsx scripts/weeklyRenewalPremiumSummaryRefresh.ts [--dry-run]
//   --dry-run  reports what would change without writing any workbook or the manifest.

import "dotenv/config"
import { existsSync } from "node:fs"
import path from "node:path"
import { RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, readManifest } from "../src/utils/renewalPremiumSummaryArchive.js"
import { refreshRenewalPremiumSummary } from "../src/utils/renewalPremiumSummaryRefresh.js"

const LOG_PREFIX = "[weeklyRenewalPremiumSummaryRefresh]"

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

function formatValue(value: number | null): string {
  return value === null ? "(blank)" : `$${ value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }`
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run")
  const manifest = readManifest()
  const today = todayLocal()
  console.log(`${ LOG_PREFIX } ${ manifest.length } archived workbook(s)${ dryRun ? " — DRY RUN, nothing will be written" : "" }`)

  const updated: string[] = []
  const unchanged: string[] = []
  const notRefreshable: { filename: string; reason: string }[] = []
  const pastRenewals: string[] = []
  const failed: { filename: string; error: string }[] = []

  for(const entry of manifest) {
    const { filename } = entry

    // Matches the index page, which only offers Refresh on upcoming renewals
    if(entry.renewal_date < today) {
      pastRenewals.push(filename)
      continue
    }
    if(!entry.custid || !entry.cell_map) {
      notRefreshable.push({ filename, reason: "generated before Refresh support existed" })
      continue
    }
    if(!existsSync(path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, filename))) {
      notRefreshable.push({ filename, reason: "file missing from disk" })
      continue
    }

    try {
      const result = await refreshRenewalPremiumSummary(filename, { dryRun })

      if(result.changes.length > 0) {
        updated.push(filename)
        console.log(`${ LOG_PREFIX } ${ dryRun ? "WOULD UPDATE" : "UPDATED" } ${ filename } (${ entry.client_name })`)
        for(const change of result.changes) {
          console.log(`    row ${ change.row } [${ change.polnos.join(", ") }] ${ change.field }: ${ formatValue(change.old_value) } → ${ formatValue(change.new_value) }`)
        }
      } else {
        unchanged.push(filename)
      }

      for(const skip of result.skipped_rows) {
        console.log(`${ LOG_PREFIX }   skipped ${ filename } row ${ skip.row } [${ skip.polnos.join(", ") }]: ${ skip.reason }`)
      }
    } catch(error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ filename, error: message })
      console.error(`${ LOG_PREFIX } FAILED ${ filename }: ${ message }`)
    }
  }

  console.log(`${ LOG_PREFIX } done — ${ dryRun ? "would update" : "updated" } ${ updated.length }, unchanged ${ unchanged.length }, past renewal ${ pastRenewals.length }, not refreshable ${ notRefreshable.length }, failed ${ failed.length }`)
  if(notRefreshable.length > 0) console.log(`${ LOG_PREFIX } not refreshable:`, notRefreshable)

  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(`${ LOG_PREFIX } fatal:`, error)
  process.exit(1)
})
