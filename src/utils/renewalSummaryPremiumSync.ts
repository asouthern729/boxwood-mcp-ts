import { existsSync } from "node:fs"
import path from "node:path"
import { CL_RENEWAL_SUMMARY_OUTPUT_DIR, readClRenewalSummaryManifest } from "./clRenewalSummaryArchive.js"
import { archivedPolids, rebuildClRenewalSummary } from "./clRenewalSummaryGenerate.js"
import { spreadsheetPolids } from "./documentLinks.js"
import { logger } from "./logger.js"
import type { RenewalPremiumSummaryManifestEntry } from "./renewalPremiumSummaryArchive.js"
import { premiumSignature } from "./renewalSummaryPremiums.js"

// Keeps each CL Renewal Summary's Premium Summary page in step with its linked Renewal Premium
// Spreadsheet (renewalSummaryPremiums.ts). Called after a spreadsheet is generated or refreshed: every
// upcoming summary sharing its policy terms whose page would now read differently — newly complete,
// a premium changed, or no longer complete — is rebuilt in place (uploaded quotes kept), the same
// rebuild the daily job does when a renewal lands. A failed rebuild is logged, never thrown: the
// spreadsheet's own change already succeeded.
export async function syncLinkedRenewalSummaries(sheet: RenewalPremiumSummaryManifestEntry): Promise<string[]> {
  const sheetPolids = spreadsheetPolids(sheet)
  if(sheetPolids.size === 0) return []

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
  const linked = readClRenewalSummaryManifest()
    .filter((entry) => entry.renewal_date >= today)
    .filter((entry) => existsSync(path.join(CL_RENEWAL_SUMMARY_OUTPUT_DIR, entry.filename)))
    .filter((entry) => archivedPolids(entry)?.some((polid) => sheetPolids.has(polid)))

  const rebuilt: string[] = []
  for(const entry of linked) {
    const now = premiumSignature(archivedPolids(entry)!)
    if(now === (entry.premium_signature ?? null)) continue
    try {
      await rebuildClRenewalSummary(entry, now ? "Renewal premiums updated" : "Renewal premiums removed")
      rebuilt.push(entry.filename)
    } catch(err) {
      logger.error({ err, summary: entry.filename, spreadsheet: sheet.filename }, "renewal summary premium sync failed")
    }
  }
  return rebuilt
}
