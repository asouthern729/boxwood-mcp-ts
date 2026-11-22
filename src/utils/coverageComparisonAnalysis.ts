import { readFileSync } from "node:fs"
import path from "node:path"
import * as z from "zod"
import { DocToolError, MAX_TOTAL_PAGES, analyzeDocuments } from "./docToolClaude.js"

// CL Coverage Comparison (Andrew, 2026-11-22), from Patrick's org-shared "coverage-comparison"
// skill: two sets of commercial quote/policy PDFs (Set A: current / expiring / Quote 1; Set B:
// proposed / renewal / Quote 2) compared line by line into a branded, client-facing Word document
// (coverageComparisonDoc.ts, a port of the skill's own generator). PDFs only — no AMS360, per the
// skill and Patrick's 11/10 email.
//
// The schema follows the skill's comparison.json but flattened (rows carry their line and section;
// amounts and optional fields are plain strings) so the structured-output grammar stays under the
// API's size limit — the nested version is what broke Policy Check's first run. normalizeComparison
// turns it back into the nested shape the document builder uses.

export type ComparisonRole = "set_a" | "set_b"
export const COMPARISON_ROLES: readonly ComparisonRole[] = ["set_a", "set_b"]

const INSTRUCTIONS_PATH = path.join(import.meta.dirname, "..", "..", "assets", "coverage-comparison", "instructions.md")

const ROW_STATUSES = ["same", "a_only", "b_only", "better", "worse", "different", "info"] as const

const SetLabel = z.object({
  label: z.string().describe("Column header, e.g. \"Current — Erie\", \"Expiring 2025–26\", \"Quote A — Cincinnati\""),
  short: z.string().describe("One word used in tags, e.g. \"Current\", \"Expiring\", \"Quote A\"")
})

export const ComparisonSchema = z.object({
  client_name: z.string().describe("Named insured as printed"),
  client_address: z.string().describe("Mailing address as printed; empty if not shown"),
  set_a: SetLabel,
  set_b: SetLabel,
  intro: z.string().describe("One sentence, e.g. \"This summary compares your current Erie program to the proposed Travelers and Hartford program, effective 10/16/2026.\""),
  glance: z.array(z.object({
    item: z.string().describe("e.g. \"Package (GL, Property)\", \"Policy period\""),
    a: z.string().describe("Set A value; use \\n for a line break; \"—\" if none"),
    b: z.string().describe("Set B value; use \\n for a line break; \"—\" if none")
  })),
  glance_notes: z.array(z.string()),
  premium_rows: z.array(z.object({
    line: z.string(),
    a: z.string().describe("Dollar amount as digits (e.g. \"4002\") or text such as \"Not shown\" / \"Included\""),
    b: z.string().describe("Dollar amount as digits or text"),
    difference_text: z.string().describe("Only to override the computed difference, e.g. \"New line\"; else empty"),
    total: z.boolean().describe("True only for the total program row")
  })),
  premium_notes: z.array(z.string()),
  premium_tables: z.array(z.object({
    title: z.string().describe("e.g. \"Optional umbrella limits\""),
    headers: z.string().describe("Column headings separated by \" | \""),
    rows: z.array(z.string()).describe("Cells separated by \" | \""),
    note: z.string().describe("Empty if none")
  })),
  key_points: z.array(z.object({ lead: z.string(), text: z.string() })).describe("6–12 bullets, most important first"),
  lines: z.array(z.object({
    title: z.string().describe("Coverage line, e.g. \"General Liability\""),
    single: z.enum(["both", "a", "b"]).describe("\"a\"/\"b\" when the line is only in that set")
  })).describe("In order: Property, General Liability, EPL, Crime, Auto, Inland Marine, Workers' Compensation, Umbrella/Excess, Professional/Cyber/D&O, other"),
  rows: z.array(z.object({
    line: z.string().describe("Title of its line, exactly as in lines"),
    section: z.string().describe("e.g. \"Limits\", \"Deductibles\", \"Exposures\", \"Terms and conditions\""),
    item: z.string(),
    a: z.string().describe("Set A value as printed; empty if not in Set A"),
    b: z.string().describe("Set B value as printed; empty if not in Set B"),
    status: z.enum(ROW_STATUSES),
    note: z.string().describe("Short plain-English explanation; don't repeat the tag; empty if none"),
    flag: z.boolean().describe("True for anything the client must look at")
  })),
  extensions: z.array(z.object({
    line: z.string(),
    title: z.string().describe("e.g. \"Additional Property Extensions — Proposed\""),
    note: z.string().describe("e.g. \"Listed in the proposal; not itemized in the current policy.\"; empty if none"),
    item: z.string(),
    value: z.string()
  })).describe("One-sided property-style extensions, one entry per extension; entries of the same line share its title and note"),
  forms: z.array(z.object({
    group: z.string().describe("e.g. \"Travelers BOP (Proposed)\""),
    form: z.string(),
    edition: z.string().describe("Empty if not shown"),
    description: z.string()
  }))
})

type Raw = z.infer<typeof ComparisonSchema>

// The nested shape of the skill's comparison.json, which the document builder takes.
export type ComparisonRow = { item: string; a: string | null; b: string | null; status: typeof ROW_STATUSES[number]; note: string | null; flag: boolean }
export type Comparison = {
  client: { name: string; address: string | null }
  set_a: { label: string; short: string }
  set_b: { label: string; short: string }
  intro: string
  glance: { item: string; a: string; b: string }[]
  glance_notes: string[]
  premium: { rows: { line: string; a: number | string | null; b: number | string | null; diff_text: string | null; total: boolean }[]; notes: string[] }
  premium_tables: { title: string; header: string[]; rows: string[][]; notes: string[] }[]
  key_points: { lead: string; text: string }[]
  lines: {
    title: string
    single: "a" | "b" | null
    sections: { title: string; rows: ComparisonRow[] }[]
    extensions: { title: string; note: string | null; rows: { item: string; value: string }[] } | null
  }[]
  forms: { title: string; rows: { form: string; edition: string | null; description: string }[] }[]
}

const orNull = (value: string) => (value.trim() ? value.trim() : null)

// "4002", "$4,002.00" → 4002; "Not shown" stays text.
function amountOrText(value: string): number | string | null {
  const trimmed = value.trim()
  if(!trimmed) return null
  const cleaned = trimmed.replace(/[$,\s]/g, "")
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : trimmed
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for(const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
  return groups
}

export function normalizeComparison(raw: Raw, labels: { a?: string; b?: string } = {}): Comparison {
  const rowsByLine = groupBy(raw.rows, (r) => r.line)
  const extensionsByLine = groupBy(raw.extensions, (e) => e.line)
  // A row whose line isn't listed still prints, under its own heading at the end.
  const lineTitles = [...new Set([...raw.lines.map((l) => l.title), ...rowsByLine.keys()])]

  return {
    client: { name: raw.client_name, address: orNull(raw.client_address) },
    set_a: { label: labels.a?.trim() || raw.set_a.label, short: raw.set_a.short || "Current" },
    set_b: { label: labels.b?.trim() || raw.set_b.label, short: raw.set_b.short || "Proposed" },
    intro: raw.intro,
    glance: raw.glance,
    glance_notes: raw.glance_notes,
    premium: {
      rows: raw.premium_rows.map((r) => ({ line: r.line, a: amountOrText(r.a), b: amountOrText(r.b), diff_text: orNull(r.difference_text), total: r.total })),
      notes: raw.premium_notes
    },
    premium_tables: raw.premium_tables.map((t) => ({ title: t.title, header: t.headers.split(" | "), rows: t.rows.map((r) => r.split(" | ")), notes: orNull(t.note) ? [t.note.trim()] : [] })),
    key_points: raw.key_points,
    lines: lineTitles.map((title) => {
      const single = raw.lines.find((l) => l.title === title)?.single ?? "both"
      const sections = [...groupBy(rowsByLine.get(title) ?? [], (r) => r.section)].map(([sectionTitle, rows]) => ({
        title: sectionTitle,
        rows: rows.map((r) => ({ item: r.item, a: orNull(r.a), b: orNull(r.b), status: r.status, note: orNull(r.note), flag: r.flag }))
      }))
      const ext = extensionsByLine.get(title) ?? []
      return {
        title,
        single: single === "both" ? null : single,
        sections,
        extensions: ext.length > 0 ? { title: ext[0].title, note: orNull(ext[0].note), rows: ext.map((e) => ({ item: e.item, value: e.value })) } : null
      }
    }),
    forms: [...groupBy(raw.forms, (f) => f.group)].map(([title, rows]) => ({ title, rows: rows.map((f) => ({ form: f.form, edition: orNull(f.edition), description: f.description })) }))
  }
}

const SET_HEADING: Record<ComparisonRole, string> = {
  set_a: "SET A (baseline: current program / expiring policy / Quote 1)",
  set_b: "SET B (comparison: proposed program / renewal / Quote 2)"
}

function systemPrompt(): string {
  return `You are Boxwood Insurance Group's coverage comparison writer. A staff member has uploaded two sets of commercial insurance documents and you compare them as described in Boxwood's Coverage Comparison instructions below. Software turns your answer into the branded Word document, so return data, not a document.

How this run differs from the instructions:
- The documents are attached, grouped under SET A and SET B headings. The staff member chose which set each file belongs to — use that; don't move files between sets.
- Fill the structured fields: rows carry their coverage line (exactly as titled in lines) and section; leave a value empty when that set doesn't have it. Premium amounts are digits only (no $ or commas) or a short text like "Not shown".
- This document goes to the client: plain English, factual, no buying recommendation. Copy limits, deductibles, form numbers and premiums exactly as printed.

${ readFileSync(INSTRUCTIONS_PATH, "utf8") }`
}

export type ComparisonDocument = { role: ComparisonRole; filename: string; file: Buffer; pages: number }

export async function runCoverageComparison({ documents, notes, labels }: { documents: ComparisonDocument[]; notes?: string; labels?: { a?: string; b?: string } }): Promise<Comparison> {
  const totalPages = documents.reduce((sum, d) => sum + d.pages, 0)
  if(totalPages > MAX_TOTAL_PAGES) {
    throw new DocToolError(`These documents total ${ totalPages } pages; a comparison can read ${ MAX_TOTAL_PAGES } at most. Upload only the relevant quotes or policy sections.`)
  }

  const labelHints = [labels?.a ? `Set A column label: ${ labels.a }` : "", labels?.b ? `Set B column label: ${ labels.b }` : ""].filter(Boolean)
  const raw = await analyzeDocuments({
    groups: COMPARISON_ROLES.map((role) => ({
      heading: SET_HEADING[role],
      documents: documents.filter((d) => d.role === role).map((d) => ({ title: `${ d.filename } (${ d.pages } pp.)`, filename: d.filename, file: d.file }))
    })),
    trailingText: [
      ...labelHints,
      notes?.trim() ? `Staff notes for this comparison:\n${ notes.trim() }` : "",
      "Compare Set A and Set B."
    ].filter(Boolean).join("\n\n"),
    system: systemPrompt(),
    schema: ComparisonSchema,
    logLabel: "coverage_comparison"
  })
  return normalizeComparison(raw as Raw, labels)
}
