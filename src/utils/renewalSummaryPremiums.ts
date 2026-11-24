import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { ProposalPremiumSummary } from "./clProposalDoc.js"
import type { SlotLine } from "./clProposalLines.js"
import { spreadsheetPolids } from "./documentLinks.js"
import { RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, readManifest as readPremiumManifest, type RenewalPremiumSummaryManifestEntry } from "./renewalPremiumSummaryArchive.js"
import { lobLabel, type RenewalPremiumSummaryCellMapEntry } from "./renewalPremiumSummaryWorkbook.js"
import { readCells } from "./xlsxCellPatch.js"

// The CL Renewal Summary's Premium Summary page, filled from its linked Renewal Premium Spreadsheet
// (Andrew, 2026-11-21 — reversing Patrick's 2026-10-07 "no premium page", per his call today).
//
// - Rows are the spreadsheet's rows for this summary's policy terms (shared polids — documentLinks.ts):
//   Line of Business | Carrier | Annual Premium (the renewal premium), plus a total. Premiums are per
//   policy, and a package policy is several sections, so they're never put on the sections.
// - Printed only when complete: every one of the summary's terms is on a spreadsheet row and every
//   such row has its renewal premium. Until then there's no page, so no partial total reaches a client.
// - The spreadsheet's figures are the tool-written AMS360 renewal premiums (AMS360 is the trigger —
//   see premiumSections in renewalPremiumSummaryArchive.ts). They win over an uploaded quote's
//   premium; the quote's figure is kept only as internal provenance (not printed).
//
// signature captures what the page shows (rows and total), so a spreadsheet change only rebuilds the
// summaries whose page would actually change (renewalSummaryPremiumSync.ts).

export type LinkedPremiums = { summary?: ProposalPremiumSummary; signature: string | null }

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })

type SheetRow = { sheet: RenewalPremiumSummaryManifestEntry; row: RenewalPremiumSummaryCellMapEntry }

// Carrier text for rows archived before cell_map recorded it, read from each workbook's column D.
async function carriersOf(rows: SheetRow[]): Promise<Map<SheetRow, string>> {
  const out = new Map<SheetRow, string>()
  const bySheet = new Map<string, SheetRow[]>()
  for(const r of rows) {
    if(r.row.carrier !== undefined) out.set(r, r.row.carrier)
    else bySheet.set(r.sheet.filename, [...(bySheet.get(r.sheet.filename) ?? []), r])
  }
  for(const [filename, sheetRows] of bySheet) {
    const cells = await readCells(readFileSync(path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, filename)), 1, sheetRows.map((r) => `D${ r.row.row }`))
    for(const r of sheetRows) {
      const cell = cells.get(`D${ r.row.row }`)
      out.set(r, cell?.kind === "text" ? cell.text : "—")
    }
  }
  return out
}

// The rows and total the page would show, or null when it isn't complete — cheap (no workbook reads),
// for deciding whether a summary needs rebuilding.
function completeRows(polids: string[]): SheetRow[] | null {
  if(polids.length === 0) return null
  const wanted = new Set(polids)
  const sheets = readPremiumManifest()
    .filter((sheet) => existsSync(path.join(RENEWAL_PREMIUM_SUMMARY_OUTPUT_DIR, sheet.filename)))
    .filter((sheet) => [...spreadsheetPolids(sheet)].some((polid) => wanted.has(polid)))

  const rows = sheets.flatMap((sheet) => (sheet.cell_map ?? [])
    .filter((row) => row.polids?.some((polid) => wanted.has(polid)))
    .map((row) => ({ sheet, row })))

  const covered = new Set(rows.flatMap((r) => r.row.polids ?? []))
  if(!polids.every((polid) => covered.has(polid))) return null
  if(rows.some((r) => r.row.renewal === null || r.row.renewal === undefined)) return null
  return rows
}

const rowTitle = (row: RenewalPremiumSummaryCellMapEntry) => row.kind === "known" ? lobLabel(row.code) : row.title ?? row.polnos.join(", ")

function signatureOf(rows: SheetRow[]): string {
  return JSON.stringify(rows.map((r) => [r.sheet.filename, r.row.row, rowTitle(r.row), r.row.carrier ?? null, r.row.renewal]))
}

// What a summary for these terms would print now — just the signature, for change detection.
export function premiumSignature(polids: string[]): string | null {
  const rows = completeRows(polids)
  return rows ? signatureOf(rows) : null
}

// The Premium Summary page for a CL Renewal Summary built from these terms. quoteLines: the document's
// lines, whose uploaded-quote premiums (if any) are recorded in the internal `comment` (not printed).
export async function linkedPremiumSummary(polids: string[], quoteLines: SlotLine[]): Promise<LinkedPremiums> {
  const rows = completeRows(polids)
  if(!rows) return { signature: null }

  const carriers = await carriersOf(rows)
  const tableRows: [string, string, string][] = rows.map((r) => [rowTitle(r.row), carriers.get(r) ?? "—", money(r.row.renewal!)])
  const total = rows.reduce((sum, r) => sum + r.row.renewal!, 0)

  const quoted = quoteLines.filter((l) => l.comment && l.premium?.amount != null).map((l) => `${ l.title }: ${ money(l.premium!.amount!) }`)
  const sheets = [...new Set(rows.map((r) => r.sheet.client_name + " (" + r.sheet.renewal_date_label + ")"))]

  return {
    summary: {
      rows: tableRows,
      total: money(total),
      notes: ["Annual renewal premiums as recorded in AMS360. All amounts are subject to change at binding and to audit."],
      comment: `Premiums from the Renewal Premium Spreadsheet (${ sheets.join("; ") }) — the AMS360 renewal premiums. Check them against the spreadsheet before sending.${ quoted.length > 0 ? ` Uploaded quote premiums, for comparison: ${ quoted.join(" | ") }.` : "" }`
    },
    signature: signatureOf(rows)
  }
}
