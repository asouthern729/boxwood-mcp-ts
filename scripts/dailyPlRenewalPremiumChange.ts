// Daily PL Renewal Premium Change run (the "auto-triggered from the download report" half of
// Patrick's 2026-09-29 spec). It covers every personal-lines renewal (RWL) a carrier downloaded
// since the last successful run. For each one it builds or rebuilds that client's Renewal Calculator
// workbook for the renewal date and archives it to scripts/output/pl-renewal-premium-change/, where
// the dashboard's PL Premium Change page lists it. The group is re-read in full, so a client whose
// auto downloads today next to a home that downloaded last week gets one workbook covering both.
// Nothing is emailed (Andrew, 2026-09-30: written to the server only). OneDrive filing hooks into
// archivePlRenewalChange once Graph access exists.
//
// The same trigger also builds that client's PL Renewal Summary (Patrick, 2026-09-29: "Renewal
// Summary Tool — auto triggered when on download report & user initiated"): the account-level
// Personal Insurance Portfolio Summary, with every in-force personal policy and any downloaded
// renewal shown on its renewal term, archived for the dashboard's PL Renewal Summary page.
//
// Calls the shared utils directly, like scripts/monthlyRenewalPremiumSummaries.ts — no LLM turn,
// nothing for one to decide.
//
// The two run as separate cron jobs (Andrew, 2026-10-01: Premium Change at 8:30, Renewal Summary at
// 9:00, after the 7:30 AMS360 sync), selected with --job. Each keeps its own cursor so neither
// skips or repeats work when the other fails or runs at a different time.
//
// "Since the last run" is a cursor on afw_policytransaction.synced_at (true UTC, immutable after
// insert — see src/utils/downloadReportWatermark.ts for why entereddate alone strands late-syncing
// rows), persisted only after every group archived, so a failed run is simply retried next time.
//
// Usage: npx tsx scripts/dailyPlRenewalPremiumChange.ts [--job=premium-change|renewal-summary] [--dry-run] [--since=ISO]
//   --job      run just one of the two (default: both, sharing the premium-change cursor as before)
//   --dry-run  list the groups that would be built, write nothing, leave the cursor untouched
//   --since    override the cursor with a UTC instant (manual backfill/testing)

import "dotenv/config"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pool } from "../src/db.js"
import { fetchPlRenewalChangeGroups } from "../src/utils/plRenewalPremiumChange.js"
import { archivePlRenewalChange } from "../src/utils/plRenewalPremiumChangeArchive.js"
import { buildAndArchivePlRenewalSummary } from "../src/utils/plRenewalSummaryBuild.js"

const PREMIUM_CHANGE_CURSOR_PATH = path.join(import.meta.dirname, "state", "pl-renewal-premium-change-cursor.json")
const RENEWAL_SUMMARY_CURSOR_PATH = path.join(import.meta.dirname, "state", "pl-renewal-summary-cursor.json")
// First run only (no cursor yet): look back this far on synced_at instead of the whole history.
const FIRST_RUN_LOOKBACK_HOURS = 24

type Job = "premium-change" | "renewal-summary" | "both"

function readCursor(cursorPath: string): string | null {
  if(!existsSync(cursorPath)) return null

  try {
    const { syncedAfter } = JSON.parse(readFileSync(cursorPath, "utf-8"))
    return typeof syncedAfter === "string" && !Number.isNaN(new Date(syncedAfter).getTime()) ? syncedAfter : null
  } catch {
    return null
  }
}

function writeCursor(cursorPath: string, syncedAfter: string): void {
  mkdirSync(path.dirname(cursorPath), { recursive: true })
  writeFileSync(cursorPath, JSON.stringify({ syncedAfter }, null, 2))
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const sinceArg = args.find((arg) => arg.startsWith("--since="))?.split("=")[1]
  const jobArg = args.find((arg) => arg.startsWith("--job="))?.split("=")[1] ?? "both"
  if(jobArg !== "premium-change" && jobArg !== "renewal-summary" && jobArg !== "both") throw new Error(`--job must be premium-change or renewal-summary, got "${ jobArg }"`)
  const job: Job = jobArg
  const buildChange = job !== "renewal-summary"
  const buildSummary = job !== "premium-change"

  // The Renewal Summary's own cursor starts from the Premium Change one the first time it runs on its
  // own, so the split neither skips nor rebuilds what the combined run already covered.
  const cursorPath = job === "renewal-summary" ? RENEWAL_SUMMARY_CURSOR_PATH : PREMIUM_CHANGE_CURSOR_PATH
  const cursor = readCursor(cursorPath) ?? (job === "renewal-summary" ? readCursor(PREMIUM_CHANGE_CURSOR_PATH) : null)
  const syncedAfter = sinceArg ?? cursor ?? new Date(Date.now() - FIRST_RUN_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()

  const { groups, maxSyncedAt } = await fetchPlRenewalChangeGroups({ syncedAfter })
  console.log(`[plRenewalPremiumChange] job=${ job }: ${ groups.length } client renewal(s) with PL downloads synced after ${ syncedAfter }`)

  let failures = 0
  // A client with two renewal dates in one batch gets one account-level summary, not two.
  const summarizedCustids = new Set<string>()

  for(const group of groups) {
    const label = `${ group.client_name } ${ group.renewal_date } (${ group.carriers }, ${ group.term }, ${ group.lines.length } line(s)${ group.excluded.length ? `, ${ group.excluded.length } excluded` : "" })`

    if(dryRun) {
      console.log(`  would build: ${ label }`)
      for(const ex of group.excluded) console.log(`    excluded ${ ex.polno }: ${ ex.reason }`)
      continue
    }

    if(buildChange) {
      const archived = await archivePlRenewalChange(group)
      console.log(archived ? `  archived ${ archived.entry.filename }: ${ label }` : `  skipped (nothing comparable): ${ label }`)
    }

    if(!buildSummary || summarizedCustids.has(group.custid)) continue
    summarizedCustids.add(group.custid)

    // One failed summary mustn't stop the rest; the cursor then stays put so tomorrow retries (a
    // rebuild just overwrites the same archived file).
    try {
      const summary = await buildAndArchivePlRenewalSummary({ custid: group.custid })
      console.log(summary.kind === "ok"
        ? `  renewal summary ${ summary.filename }${ summary.renewedPolnos.length ? ` (renewal term: ${ summary.renewedPolnos.join(", ") })` : "" }`
        : `  renewal summary not built for ${ group.client_name }: ${ summary.kind === "error" ? summary.error.message : "ambiguous customer match" }`)
    } catch(error) {
      failures++
      console.error(`  renewal summary FAILED for ${ group.client_name }:`, error)
    }
  }

  if(!dryRun && maxSyncedAt && failures === 0) writeCursor(cursorPath, maxSyncedAt)
  if(failures > 0) {
    console.error(`[plRenewalPremiumChange] ${ failures } renewal summary build(s) failed — cursor not advanced, will retry next run`)
    process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error("[plRenewalPremiumChange] failed:", error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
