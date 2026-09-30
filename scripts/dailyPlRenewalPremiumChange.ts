// Daily PL Renewal Premium Change run (the "auto-triggered from the download report" half of
// Patrick's 2026-09-29 spec). It covers every personal-lines renewal (RWL) a carrier downloaded
// since the last successful run. For each one it builds or rebuilds that client's Renewal Calculator
// workbook for the renewal date and archives it to scripts/output/pl-renewal-premium-change/, where
// the dashboard's PL Premium Change page lists it. The group is re-read in full, so a client whose
// auto downloads today next to a home that downloaded last week gets one workbook covering both.
// Nothing is emailed (Andrew, 2026-09-30: written to the server only). OneDrive filing hooks into
// archivePlRenewalChange once Graph access exists.
//
// Calls the shared utils directly, like scripts/monthlyRenewalPremiumSummaries.ts — no LLM turn,
// nothing for one to decide.
//
// "Since the last run" is a cursor on afw_policytransaction.synced_at (true UTC, immutable after
// insert — see src/utils/downloadReportWatermark.ts for why entereddate alone strands late-syncing
// rows), persisted only after every group archived, so a failed run is simply retried next time.
//
// Usage: npx tsx scripts/dailyPlRenewalPremiumChange.ts [--dry-run] [--since=ISO]
//   --dry-run  list the groups that would be built, write nothing, leave the cursor untouched
//   --since    override the cursor with a UTC instant (manual backfill/testing)

import "dotenv/config"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pool } from "../src/db.js"
import { fetchPlRenewalChangeGroups } from "../src/utils/plRenewalPremiumChange.js"
import { archivePlRenewalChange } from "../src/utils/plRenewalPremiumChangeArchive.js"

const CURSOR_PATH = path.join(import.meta.dirname, "state", "pl-renewal-premium-change-cursor.json")
// First run only (no cursor yet): look back this far on synced_at instead of the whole history.
const FIRST_RUN_LOOKBACK_HOURS = 24

function readCursor(): string | null {
  if(!existsSync(CURSOR_PATH)) return null

  try {
    const { syncedAfter } = JSON.parse(readFileSync(CURSOR_PATH, "utf-8"))
    return typeof syncedAfter === "string" && !Number.isNaN(new Date(syncedAfter).getTime()) ? syncedAfter : null
  } catch {
    return null
  }
}

function writeCursor(syncedAfter: string): void {
  mkdirSync(path.dirname(CURSOR_PATH), { recursive: true })
  writeFileSync(CURSOR_PATH, JSON.stringify({ syncedAfter }, null, 2))
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const sinceArg = args.find((arg) => arg.startsWith("--since="))?.split("=")[1]
  const syncedAfter = sinceArg ?? readCursor() ?? new Date(Date.now() - FIRST_RUN_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()

  const { groups, maxSyncedAt } = await fetchPlRenewalChangeGroups({ syncedAfter })
  console.log(`[plRenewalPremiumChange] ${ groups.length } client renewal(s) with PL downloads synced after ${ syncedAfter }`)

  for(const group of groups) {
    const label = `${ group.client_name } ${ group.renewal_date } (${ group.carriers }, ${ group.term }, ${ group.lines.length } line(s)${ group.excluded.length ? `, ${ group.excluded.length } excluded` : "" })`

    if(dryRun) {
      console.log(`  would build: ${ label }`)
      for(const ex of group.excluded) console.log(`    excluded ${ ex.polno }: ${ ex.reason }`)
      continue
    }

    const archived = await archivePlRenewalChange(group)
    console.log(archived ? `  archived ${ archived.entry.filename }: ${ label }` : `  skipped (nothing comparable): ${ label }`)
  }

  if(!dryRun && maxSyncedAt) writeCursor(maxSyncedAt)
}

main()
  .catch((error) => {
    console.error("[plRenewalPremiumChange] failed:", error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
