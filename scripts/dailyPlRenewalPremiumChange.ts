// Daily PL Renewal Premium Change email (roadmap #11): every personal-lines renewal (RWL) a carrier
// downloaded since the last successful run, as one tab-delimited line per policy ready to paste into
// an AMS activity note. Nothing is saved — the email is the deliverable (Patrick, 2026-09-15).
//
// Calls fetchPlRenewalPremiumChanges() (src/utils/plRenewalPremiumChange.ts) directly, like
// scripts/monthlyRenewalPremiumSummaries.ts — no LLM turn, nothing for one to decide.
//
// "Since the last run" is a cursor on afw_policytransaction.synced_at (true UTC, immutable after
// insert — see src/utils/downloadReportWatermark.ts for why entereddate alone strands late-syncing
// rows), persisted only after a successful send so a failed run is simply retried next time. No
// email is sent on a day with no PL renewals.
//
// Usage: npx tsx scripts/dailyPlRenewalPremiumChange.ts [--dry-run] [--to=a@x.com,b@y.com] [--since=ISO]
//   --dry-run  print the email body instead of sending, and leave the cursor untouched
//   --since    override the cursor with a UTC instant (manual backfill/testing)
//   --to       override recipients (CC is dropped when overridden, for test sends)

import "dotenv/config"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pool } from "../src/db.js"
import { sendMail } from "../src/utils/mailer.js"
import { activityLineHeader, fetchPlRenewalPremiumChanges, formatActivityLine } from "../src/utils/plRenewalPremiumChange.js"

const CURSOR_PATH = path.join(import.meta.dirname, "state", "pl-renewal-premium-change-cursor.json")
const DEFAULT_RECIPIENTS = ["personal@boxwoodins.com"]
const CC_RECIPIENTS = ["patrick@boxwoodins.com"]
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

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date())
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const toArg = args.find((arg) => arg.startsWith("--to="))?.split("=")[1]
  const to = toArg ? toArg.split(",").map((address) => address.trim()) : DEFAULT_RECIPIENTS
  const cc = toArg ? undefined : CC_RECIPIENTS

  const sinceArg = args.find((arg) => arg.startsWith("--since="))?.split("=")[1]
  const syncedAfter = sinceArg ?? readCursor() ?? new Date(Date.now() - FIRST_RUN_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
  const { renewals, maxSyncedAt, truncated } = await fetchPlRenewalPremiumChanges({ syncedAfter })

  console.log(`[plRenewalPremiumChange] ${ renewals.length } PL renewal(s) synced after ${ syncedAfter }${ truncated ? " (truncated)" : "" }`)

  if(renewals.length === 0) return

  const date = todayLocal()
  const text = [
    `PL renewals downloaded since the last report: ${ renewals.length }. One line per policy, tab-separated — copy a line into the AMS activity note.`,
    "",
    activityLineHeader(),
    ...renewals.map(formatActivityLine),
    "",
    "Expiring premium is the prior term's full-term premium at expiration (after endorsements); renewal premium is the new term's full-term premium. When either is missing in AMS360 the change is left blank with a note."
  ].join("\n")

  if(dryRun) {
    console.log(`--- DRY RUN: would send to ${ to }${ cc ? `, cc ${ cc }` : "" } ---\n${ text }`)
    return
  }

  await sendMail({ to, cc, subject: `Boxwood PL Renewal Premium Changes — ${ date }`, text })
  console.log(`[plRenewalPremiumChange] sent to ${ to }`)

  if(maxSyncedAt) writeCursor(maxSyncedAt)
}

main()
  .catch((error) => {
    console.error("[plRenewalPremiumChange] failed:", error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
