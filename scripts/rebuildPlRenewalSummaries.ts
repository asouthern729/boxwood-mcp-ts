// One-off quiet rebuild (2026-11-21) of every archived PL Renewal Summary in the house-style layout
// (commit 2878097). Each document is rebuilt in place under its archived filename and keeps its
// generated_at, so the index page's dates don't all change.
//
// Which policies to rebuild from: entries archived from 2026-11-21 on record the current terms they
// were built from (polids), and are resolved by those. Older entries only carry their policy
// numbers, so each polno is matched exactly among the client's current in-force personal policies.
// Either way the document goes through the same build as the original (same-polno dedupe, then any
// downloaded renewal term swapped in).
//
// Skipped, left exactly as they are:
//   - documents whose renewal date has already passed;
//   - documents whose policies can no longer all be found as current terms;
//   - documents whose rebuild would land on a different renewal date (the policies have since rolled
//     to a later term, so it would no longer be the same document).
//
// Usage: npx tsx scripts/rebuildPlRenewalSummaries.ts [--dry-run]
//   --dry-run  builds each document and reports what it would do without archiving anything.

import "dotenv/config"
import { PERSONAL_BOOK, resolveClPolicies, resolvePolicyTerms } from "../src/utils/clPolicyData.js"
import type { ResolvedPolicy } from "../src/utils/clPolicyData.js"
import { archivePlRenewalSummary, readPlRenewalSummaryManifest } from "../src/utils/plRenewalSummaryArchive.js"
import type { PlRenewalSummaryManifestEntry } from "../src/utils/plRenewalSummaryArchive.js"
import { buildPlRenewalSummary } from "../src/utils/plRenewalSummaryBuild.js"

class SkipError extends Error {}

const normalizePolno = (polno: string) => polno.replace(/\s+/g, "").toUpperCase()

// Today in Boxwood's timezone, as YYYY-MM-DD — renewal_date is a calendar date as staff read it.
function chicagoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

// Every listed polno matched exactly (ignoring spacing/case) among current in-force personal
// policies, all belonging to one client.
async function resolveByPolnos(polnos: string[]): Promise<ResolvedPolicy[]> {
  const found = new Map<string, ResolvedPolicy>()
  let custid: string | undefined

  for(const polno of polnos) {
    const resolution = await resolveClPolicies({ polno, custid }, PERSONAL_BOOK)
    const candidates = resolution.kind === "ok" ? resolution.matches : []
    const exact = candidates.filter((m) => normalizePolno(m.polno) === normalizePolno(polno))

    if(exact.length === 0) {
      throw new SkipError(resolution.kind === "ambiguous"
        ? `policy ${ polno } matches policies on more than one client`
        : `policy ${ polno } is no longer a current in-force personal policy`)
    }
    if(new Set(exact.map((m) => m.custid)).size > 1) throw new SkipError(`policy ${ polno } matches policies on more than one client`)

    custid = exact[0].custid
    for(const m of exact) found.set(m.polid, m)
  }

  return [...found.values()]
}

async function resolveEntryTerms(entry: PlRenewalSummaryManifestEntry): Promise<ResolvedPolicy[]> {
  if(entry.polids && entry.polids.length > 0) {
    const terms = await resolvePolicyTerms(entry.polids, PERSONAL_BOOK)
    if(terms.length !== entry.polids.length) throw new SkipError("some of its policy terms are no longer in AMS360")
    return entry.polids.map((polid) => terms.find((t) => t.polid === polid)!)
  }

  const polnos = entry.polnos.split(",").map((p) => p.trim()).filter(Boolean)
  if(polnos.length === 0) throw new SkipError("no policy numbers recorded")
  return await resolveByPolnos(polnos)
}

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  const today = chicagoToday()
  const entries = readPlRenewalSummaryManifest()
  let rebuilt = 0
  const skipped: { filename: string; reason: string }[] = []

  for(const entry of entries) {
    try {
      if(entry.renewal_date < today) throw new SkipError(`renewal date ${ entry.renewal_date } has passed`)

      const terms = await resolveEntryTerms(entry)
      // The archived filename tells the two filing kinds apart (see buildPlRenewalSummary).
      const singlePolicy = !entry.filename.endsWith("_Personal_Insurance_Summary.docx")
      const clientName = terms[0].customer_name?.trim() || entry.client_name
      const built = await buildPlRenewalSummary(terms, clientName, singlePolicy)

      if(built.entry.renewal_date !== entry.renewal_date) {
        throw new SkipError(`would now renew ${ built.entry.renewal_date } instead of ${ entry.renewal_date } — its policies have moved to a later term`)
      }

      // A client rename in AMS360 would file it as a new document beside the old one, so keep the
      // archived name.
      if(built.entry.filename !== entry.filename) console.log(`[rebuildPlRenewalSummaries] note: ${ entry.filename } would now be named ${ built.entry.filename } — keeping the archived name`)

      if(!dryRun) {
        archivePlRenewalSummary(built.buffer, {
          ...entry,
          ...built.entry,
          filename: entry.filename,
          generated_at: entry.generated_at
        })
      }
      rebuilt++
      console.log(`[rebuildPlRenewalSummaries] ${ dryRun ? "would rebuild" : "rebuilt" } ${ entry.filename } — ${ built.includedSections.join(", ") }`)
    } catch(error) {
      if(!(error instanceof SkipError)) {
        // One bad document mustn't stop the rest; report it with the skips.
        const message = error instanceof Error ? error.message : String(error)
        skipped.push({ filename: entry.filename, reason: `error: ${ message }` })
        console.error(`[rebuildPlRenewalSummaries] FAILED ${ entry.filename }: ${ message }`)
        continue
      }
      skipped.push({ filename: entry.filename, reason: error.message })
      console.log(`[rebuildPlRenewalSummaries] skipped ${ entry.filename }: ${ error.message }`)
    }
  }

  console.log(`[rebuildPlRenewalSummaries] done — ${ dryRun ? "would rebuild" : "rebuilt" } ${ rebuilt }, skipped ${ skipped.length } of ${ entries.length }`)
  process.exit(0)
}

main().catch((error) => {
  console.error("[rebuildPlRenewalSummaries] FAILED:", error)
  process.exit(1)
})
