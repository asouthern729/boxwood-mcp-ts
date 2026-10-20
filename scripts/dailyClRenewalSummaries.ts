// Weekday build of the CL Renewal Summary (cl_renewal_summary MCP tool) — Patrick's 9/29 "final
// lap": "Auto created 30 days"; Andrew, 2026-09-30: runs M–F like the PL tools, on a rolling 30-day
// window. Each run picks up every commercial policy term expiring within the next 30 days that
// doesn't already have a Renewal Summary archived — whether built by an earlier run or on demand
// through the dashboard chat — so each term is built once, the first weekday it enters the window
// (a policy crossing 30 days over a weekend is caught Monday).
//
// Rebuilds: the document is a renewal proposal printed from each policy's renewal term once AMS360
// has it (clRenewalTerms.ts). Built before that, it shows the expiring program — so each run also
// rebuilds, in place, any archived document with a term whose renewal has landed since it was built
// (its manifest entry's renewal_polids). Uploaded quotes are kept (rebuildClRenewalSummary).
//
// An account's not-yet-covered terms in the window are combined into one document, same as an
// on-demand account-level request; terms already covered are left out rather than rebuilt.
//
// Calls generateClRenewalSummary() (src/utils/clRenewalSummaryGenerate.ts) directly — the same
// build+archive the interactive tool uses, no MCP transport or LLM turn. No email; archives to
// <OUTPUT_ROOT>/cl-renewal-summary/, whose manifest.json backs the CL Renewal Summary index page.
//
// Usage: npx tsx scripts/dailyClRenewalSummaries.ts [--dry-run] [--rebuild]
//   --dry-run  lists what would be built without building or archiving anything.
//   --rebuild  also rebuilds every archived document whose terms haven't expired yet — a one-time
//              pass after a format change (the 2026-10-08 move to the proposal layout).

import "dotenv/config"
import { formatDate, resolveClPolicies } from "../src/utils/clPolicyData.js"
import { readClRenewalSummaryManifest } from "../src/utils/clRenewalSummaryArchive.js"
import { ClRenewalSummaryRebuildError, archivedPolids, generateClRenewalSummary, rebuildClRenewalSummary } from "../src/utils/clRenewalSummaryGenerate.js"
import { polidsWithRenewal } from "../src/utils/clRenewalTerms.js"
import { isTermArchived } from "../src/utils/docArchive.js"
import type { DocArchiveEntry } from "../src/utils/docArchive.js"
import { discoverCommercialAccounts } from "../src/utils/monthlyRenewalWindow.js"

const WINDOW_DAYS = 30

// Calendar date in Boxwood's timezone — the window is "expiring within 30 days of today" as staff
// read it, not of today in UTC.
function chicagoDate(offsetDays: number): string {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
}

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  // From tomorrow: a term expiring today is already past (resolution compares polexpdate to now()),
  // and its renewal is in place — it was due a document 30 days ago.
  const startDate = chicagoDate(1)
  const endDate = chicagoDate(WINDOW_DAYS)

  console.log(`[dailyClRenewalSummaries] window ${ startDate } – ${ endDate }${ dryRun ? " (dry run)" : "" }`)

  const accounts = await discoverCommercialAccounts({ startDate, endDate })
  console.log(`[dailyClRenewalSummaries] ${ accounts.length } commercial account(s) with a policy expiring in this window`)

  const manifest = readClRenewalSummaryManifest()
  const generated: { custid: string; clientName: string; polnos: string }[] = []
  const alreadyCovered: string[] = []
  const skipped: { custid: string; customerName: string | null; reason: string }[] = []
  const failed: { custid: string; customerName: string | null; error: string }[] = []

  for(const { custid, customer_name } of accounts) {
    try {
      const resolution = await resolveClPolicies({ custid, renewal_within_days: WINDOW_DAYS })

      if(resolution.kind !== "ok") {
        // Shouldn't normally happen given discovery mirrors resolution's own filter, but a policy
        // could be cancelled/renewed between the two — a benign skip, not a failure.
        const reason = resolution.kind === "error" ? resolution.error.message : resolution.payload.message
        skipped.push({ custid, customerName: customer_name, reason })
        continue
      }

      const uncovered = resolution.matches.filter((m) => !isTermArchived(manifest, {
        polid: m.polid, polno: m.polno, renewalDate: formatDate(m.polexpdate)
      }))

      if(uncovered.length === 0) {
        alreadyCovered.push(resolution.clientName)
        continue
      }

      const polnoLabel = uncovered.map((m) => m.polno).join(", ")

      if(dryRun) {
        generated.push({ custid, clientName: resolution.clientName, polnos: polnoLabel })
        console.log(`[dailyClRenewalSummaries] would generate ${ resolution.clientName } (${ polnoLabel }; renews ${ uncovered.map((m) => formatDate(m.polexpdate)).join(", ") })`)
        continue
      }

      const result = await generateClRenewalSummary(uncovered, resolution.clientName)
      generated.push({ custid, clientName: resolution.clientName, polnos: result.polnoLabel })
      console.log(`[dailyClRenewalSummaries] generated ${ resolution.clientName } (${ result.polnoLabel }) — ${ result.includedSections.length } section(s)`)
    } catch(error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ custid, customerName: customer_name, error: message })
      console.error(`[dailyClRenewalSummaries] FAILED custid=${ custid } (${ customer_name ?? "unknown" }): ${ message }`)
    }
  }

  const rebuilt = await rebuildArchived({ dryRun, everything: process.argv.includes("--rebuild"), today: chicagoDate(0), failed })

  console.log(`[dailyClRenewalSummaries] done — ${ dryRun ? "would generate" : "generated" } ${ generated.length }, ${ dryRun ? "would rebuild" : "rebuilt" } ${ rebuilt }, already on file ${ alreadyCovered.length }, skipped ${ skipped.length }, failed ${ failed.length }`)
  if(skipped.length > 0) console.log("[dailyClRenewalSummaries] skipped:", skipped)
  if(failed.length > 0) console.log("[dailyClRenewalSummaries] failed:", failed)

  process.exit(failed.length > 0 ? 1 : 0)
}

// Archived documents that need rebuilding: those with a term whose renewal has landed since the
// build, or (with --rebuild) every one whose earliest renewal is still ahead. A document whose terms
// are no longer in force can't be rebuilt and is left as it is.
async function rebuildArchived({ dryRun, everything, today, failed }: {
  dryRun: boolean; everything: boolean; today: string; failed: { custid: string; customerName: string | null; error: string }[]
}): Promise<number> {
  const upcoming = readClRenewalSummaryManifest().filter((e) => e.renewal_date >= today)
  const candidates = upcoming.filter((e) => archivedPolids(e))
  const ready = everything ? new Set<string>() : await polidsWithRenewal(candidates.flatMap((e) => archivedPolids(e)!))

  const due = candidates.filter((e: DocArchiveEntry) => everything
    || archivedPolids(e)!.some((polid) => ready.has(polid) && !(e.renewal_polids ?? []).includes(polid)))
  let rebuilt = 0

  for(const entry of due) {
    if(dryRun) {
      console.log(`[dailyClRenewalSummaries] would rebuild ${ entry.client_name } (${ entry.polnos })`)
      rebuilt++
      continue
    }
    try {
      const result = await rebuildClRenewalSummary(entry, everything ? "Rebuilt in the latest format" : "Renewal term landed in AMS360")
      rebuilt++
      console.log(`[dailyClRenewalSummaries] rebuilt ${ entry.client_name } (${ entry.polnos })${ result.renewalPendingPolnos.length > 0 ? ` — renewal still pending for ${ result.renewalPendingPolnos.join(", ") }` : " — renewal terms" }`)
    } catch(error) {
      if(error instanceof ClRenewalSummaryRebuildError) {
        console.log(`[dailyClRenewalSummaries] can't rebuild ${ entry.client_name } (${ entry.polnos }): ${ error.message }`)
        continue
      }
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ custid: "", customerName: entry.client_name, error: `rebuild: ${ message }` })
      console.error(`[dailyClRenewalSummaries] FAILED rebuild ${ entry.client_name } (${ entry.polnos }): ${ message }`)
    }
  }

  return rebuilt
}

main().catch((error) => {
  console.error("[dailyClRenewalSummaries] fatal:", error)
  process.exit(1)
})
