import { createDocArchive, sanitizeForFilename } from "./docArchive.js"
import type { DocArchiveEntry } from "./docArchive.js"
import type { PlRenewalChangeGroup } from "./plRenewalPremiumChange.js"
import { buildPlRenewalCalculatorWorkbook } from "./plRenewalPremiumChangeWorkbook.js"
import type { PlCalculatorTerm } from "./plRenewalPremiumChangeWorkbook.js"

// scripts/output/pl-renewal-premium-change/ — same manifest conventions as the PL Renewal Summary
// archive (docArchive.ts), plus the figures the dashboard's index rows show without opening the file.
// This is the interim filing location (Andrew, 2026-09-30: written to the server only, nothing
// emailed); Patrick's target is OneDrive Personal Lines/PL Client Renewals/<client>/<year>/ ("Ren
// Change SS"), and `archivePlRenewalChange` below is the one place to add that upload once Graph
// access exists.
export type PlRenewalChangeManifestEntry = DocArchiveEntry & {
  carriers: string
  term: PlCalculatorTerm
  current_total: number
  renewal_total: number
  change_amount: number
  change_percent: number | null
  // The paste-ready AMS note block ("Copy For AMS"): a header line, then one space-aligned line per
  // row (label, current, RNWL, renewal, increase label, increase, Monthly Increase, monthly, %), joined with \n.
  note: string
}

const plRenewalChangeArchive = createDocArchive<PlRenewalChangeManifestEntry>("pl-renewal-premium-change")

export const PL_RENEWAL_CHANGE_OUTPUT_DIR = plRenewalChangeArchive.outputDir
export const readPlRenewalChangeManifest = plRenewalChangeArchive.readManifest
export const deletePlRenewalChange = plRenewalChangeArchive.remove

export type ArchivedPlRenewalChange = { entry: PlRenewalChangeManifestEntry; buffer: Buffer; overflow: string[] }

// One file per client + renewal effective date: a later download for the same renewal rebuilds and
// overwrites it (bumping generated_at) rather than accumulating copies.
export function plRenewalChangeFilename(group: Pick<PlRenewalChangeGroup, "client_name" | "renewal_date">): string {
  return `${ sanitizeForFilename(group.client_name) }_${ group.renewal_date }_Renewal_Change.xlsx`
}

// Builds the workbook for a group and archives it. Null when the group has no comparable line at
// all (every policy excluded), so there's nothing meaningful to file.
export async function archivePlRenewalChange(group: PlRenewalChangeGroup): Promise<ArchivedPlRenewalChange | null> {
  if(group.lines.length === 0) return null

  const workbook = await buildPlRenewalCalculatorWorkbook({
    carriersLabel: group.carriers,
    renewalDateLabel: group.renewal_date_label,
    term: group.term,
    lines: group.lines
  })

  const entry: PlRenewalChangeManifestEntry = {
    filename: plRenewalChangeFilename(group),
    generated_at: new Date().toISOString(),
    csr_code: group.csr_code,
    csr_name: group.csr_name,
    client_name: group.client_sort_name,
    polnos: group.polnos.join(", "),
    renewal_date: group.renewal_date,
    renewal_date_label: group.renewal_date_label,
    carriers: group.carriers,
    term: group.term,
    current_total: workbook.currentTotal,
    renewal_total: workbook.renewalTotal,
    change_amount: workbook.changeAmount,
    change_percent: workbook.changePercent,
    note: workbook.note
  }

  plRenewalChangeArchive.archive(workbook.buffer, entry)
  return { entry, buffer: workbook.buffer, overflow: workbook.overflow }
}
