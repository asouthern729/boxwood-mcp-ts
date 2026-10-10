// One-off quiet backfill (2026-10-10): rebuilds every archived CL Renewal Summary in place so the
// documents lose the "Renewal Terms Pending" callouts and their manifest entries gain `sections`
// (per-line renewed/pending status for the index page). Each entry keeps its generated_at,
// last_refreshed_at and last_refresh_reason, so rows don't all flip to "Updated Today". Uploaded
// quotes are kept (buildClRenewalSummary reads the stored uploads).
//
// Usage: npx tsx scripts/rebuildClRenewalSummaries.ts [--missing-sections] [--dry-run]
//   --missing-sections  only entries without `sections` yet (those a previous run skipped).
//   --dry-run           builds each document and prints its sections without archiving anything.
//   --skip=<text>       leaves out entries whose filename contains <text> (repeatable).

import "dotenv/config"
import { archiveClRenewalSummary, readClRenewalSummaryManifest } from "../src/utils/clRenewalSummaryArchive.js"
import { ClRenewalSummaryRebuildError, buildClRenewalSummary, resolveArchivedClPolicies } from "../src/utils/clRenewalSummaryGenerate.js"

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  const skips = process.argv.filter((a) => a.startsWith("--skip=")).map((a) => a.slice("--skip=".length))
  const entries = readClRenewalSummaryManifest()
    .filter((e) => !process.argv.includes("--missing-sections") || !e.sections)
    .filter((e) => !skips.some((text) => e.filename.includes(text)))
  let rebuilt = 0
  const skipped: { filename: string; reason: string }[] = []

  for(const entry of entries) {
    try {
      const { matches, clientName } = await resolveArchivedClPolicies(entry)
      const { buffer, archiveEntry } = await buildClRenewalSummary(matches, clientName)
      if(dryRun) {
        rebuilt++
        console.log(`[rebuildClRenewalSummaries] would rebuild ${ entry.filename }: ${ archiveEntry.sections!.map((l) => `${ l.title } (${ l.renewed ? "renewed" : "pending" })`).join(", ") }`)
        continue
      }
      archiveClRenewalSummary(buffer, {
        ...archiveEntry,
        generated_at: entry.generated_at,
        last_refreshed_at: entry.last_refreshed_at,
        last_refresh_reason: entry.last_refresh_reason
      })
      rebuilt++
      console.log(`[rebuildClRenewalSummaries] rebuilt ${ entry.filename }`)
    } catch(error) {
      if(!(error instanceof ClRenewalSummaryRebuildError)) throw error
      skipped.push({ filename: entry.filename, reason: error.message })
      console.log(`[rebuildClRenewalSummaries] skipped ${ entry.filename }: ${ error.message }`)
    }
  }

  console.log(`[rebuildClRenewalSummaries] done — ${ dryRun ? "would rebuild" : "rebuilt" } ${ rebuilt }, skipped ${ skipped.length } of ${ entries.length }`)
  process.exit(0)
}

main().catch((error) => {
  console.error("[rebuildClRenewalSummaries] FAILED:", error)
  process.exit(1)
})
