// One-off quiet rebuild (2026-10-10) of every archived Pre-Renewal Review in the restyled layout
// (CL Renewal Summary look, no premiums). Each document is rebuilt in place from the exact policy
// terms it was built from — by polid, even if they've since expired — and keeps its generated_at, so
// the index page's dates don't all change.
//
// Usage: npx tsx scripts/rebuildRiskProfiles.ts [--dry-run]

import "dotenv/config"
import { resolvePolicyTerms } from "../src/utils/clPolicyData.js"
import { archiveRiskProfile, readManifest } from "../src/utils/riskProfileArchive.js"
import { buildRiskProfile } from "../src/utils/riskProfileGenerate.js"

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  const entries = readManifest()
  let rebuilt = 0
  const skipped: { filename: string; reason: string }[] = []

  for(const entry of entries) {
    const polids = entry.polids ?? []
    const found = polids.length > 0 ? await resolvePolicyTerms(polids) : []
    const matches = polids.flatMap((polid) => found.filter((m) => m.polid === polid))

    if(polids.length === 0 || matches.length !== polids.length) {
      skipped.push({ filename: entry.filename, reason: polids.length === 0 ? "no polids recorded" : "some policies are no longer in AMS360" })
      continue
    }

    const { buffer, archiveEntry, includedSections } = await buildRiskProfile(matches, matches[0].customer_name?.trim() || entry.client_name)

    // The filename comes from the client name and polnos; a rename in AMS360 would file it as a new
    // document beside the old one, so keep the archived name.
    if(archiveEntry.filename !== entry.filename) console.log(`[rebuildRiskProfiles] note: ${ entry.filename } would now be named ${ archiveEntry.filename } — keeping the archived name`)

    if(!dryRun) archiveRiskProfile(buffer, { ...archiveEntry, filename: entry.filename, generated_at: entry.generated_at })
    rebuilt++
    console.log(`[rebuildRiskProfiles] ${ dryRun ? "would rebuild" : "rebuilt" } ${ entry.filename } — ${ includedSections.join(", ") }`)
  }

  console.log(`[rebuildRiskProfiles] done — ${ dryRun ? "would rebuild" : "rebuilt" } ${ rebuilt }, skipped ${ skipped.length } of ${ entries.length }`)
  if(skipped.length > 0) console.log("[rebuildRiskProfiles] skipped:", skipped)
  process.exit(0)
}

main().catch((error) => {
  console.error("[rebuildRiskProfiles] FAILED:", error)
  process.exit(1)
})
