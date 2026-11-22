import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import { readFileSync } from "node:fs"
import path from "node:path"
import { PDFDocument } from "pdf-lib"
import * as z from "zod"
import type { AmsCrossCheck } from "./policyCheckAms.js"
import { DOC_TOOL_MODEL, DocToolError, MAX_TOTAL_PAGES, analyzeDocuments, anthropic } from "./docToolClaude.js"
import { normalizedPdf } from "./quoteExtraction.js"

// The two Claude reads behind the CL Policy Check (Andrew, 2026-11-22), built from Patrick's
// org-shared "policy-check" skill:
//   1. readDocumentProfile — a cheap first look at each upload (first pages only) so the page can
//      show what a file is and suggest which drop zone it belongs in.
//   2. runPolicyCheck — the check itself: every document in one request, Patrick's checklist as the
//      instructions and the AMS360 cross-check as data, returning structured findings. Numbering,
//      counts, the banner and premium arithmetic are done afterwards in code (policyCheckRun.ts),
//      never left to the model.

const MODEL = DOC_TOOL_MODEL
export { MAX_TOTAL_PAGES }
const PROFILE_PAGES = 4

const CHECKLIST_PATH = path.join(import.meta.dirname, "..", "..", "assets", "policy-check", "checklist.md")

// Errors written for staff (shared with the other document tools).
export const PolicyCheckError = DocToolError

export type PolicyCheckRole = "baseline" | "compared" | "reference"
export const ROLES: readonly PolicyCheckRole[] = ["baseline", "compared", "reference"]

// ---------- 1. Document profile ----------

const DOCUMENT_TYPES = ["quote", "binder", "issued_policy", "renewal_policy", "expiring_policy", "endorsement", "application", "contract", "other"] as const

const ProfileSchema = z.object({
  document_type: z.enum(DOCUMENT_TYPES),
  named_insured: z.string().nullable().describe("First named insured exactly as printed"),
  carrier: z.string().nullable().describe("Insurance company / writing company as printed"),
  policy_number: z.string().nullable().describe("Policy, quote or binder number as printed"),
  policy_period: z.string().nullable().describe("Effective – expiration as printed"),
  document_date: z.string().nullable().describe("Date the document was issued/prepared, YYYY-MM-DD, if printed")
})

export type DocumentProfile = z.infer<typeof ProfileSchema> & { pages: number; suggested_role: PolicyCheckRole }

const SUGGESTED_ROLE: Record<typeof DOCUMENT_TYPES[number], PolicyCheckRole> = {
  quote: "baseline", binder: "baseline", expiring_policy: "baseline",
  issued_policy: "compared", renewal_policy: "compared",
  endorsement: "reference", application: "reference", contract: "reference", other: "reference"
}

async function pageCount(pdf: Buffer): Promise<{ doc: PDFDocument | null; pages: number }> {
  try {
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false })
    return { doc, pages: doc.getPageCount() }
  } catch {
    return { doc: null, pages: 0 }
  }
}

async function firstPages(doc: PDFDocument, count: number): Promise<Buffer> {
  const out = await PDFDocument.create()
  const pages = await out.copyPages(doc, [...Array(Math.min(count, doc.getPageCount())).keys()])
  for(const page of pages) out.addPage(page)
  return Buffer.from(await out.save())
}

export async function readDocumentProfile(file: Buffer, filename: string): Promise<DocumentProfile> {
  const pdf = normalizedPdf(file)
  const { doc, pages } = await pageCount(pdf)
  if(!doc) throw new PolicyCheckError("This PDF couldn't be opened — it may be damaged or password-protected. Download it again and re-upload.")
  // A slice of a large policy keeps this read cheap; the dec page and forms schedule are up front.
  const excerpt = pages > PROFILE_PAGES ? await firstPages(doc, PROFILE_PAGES) : pdf

  const response = await anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(ProfileSchema) },
    system: "You identify commercial insurance documents for an agency's policy-checking tool. Report only what the pages show; null when not printed. A carrier's issued policy or declarations for a new term is issued_policy; one described as a renewal is renewal_policy; the prior term's policy is expiring_policy.",
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: excerpt.toString("base64") }, title: filename },
        { type: "text", text: `These are the first ${ Math.min(pages, PROFILE_PAGES) } of ${ pages } pages. Identify the document.` }
      ]
    }]
  })

  if(response.stop_reason === "refusal" || !response.parsed_output) throw new PolicyCheckError("This document couldn't be identified. Try a different copy of the file.")
  const profile = response.parsed_output as z.infer<typeof ProfileSchema>
  return { ...profile, pages, suggested_role: SUGGESTED_ROLE[profile.document_type] }
}

// ---------- 2. The check ----------

const STATUSES = ["ERROR", "MISSING", "ADDED", "CHANGED", "VERIFY", "MATCH", "N/A"] as const
const PRIORITIES = ["1", "2", "3", "none"] as const
const SECTIONS = ["A", "B", "C", "D"] as const

const CheckRow = z.object({
  ref: z.string().describe("Short unique id for this row, e.g. \"A1\", \"GL-class-91342\" — used to cross-reference premium drivers and AMS360 rows"),
  section: z.enum(SECTIONS).describe("Checklist section A-D"),
  line: z.string().describe("\"Program\" for section A items that span the program, else the coverage line, e.g. \"General Liability\""),
  item: z.string(),
  baseline: z.string().describe("What the baseline shows, as printed; \"Not shown\" if absent"),
  compared: z.string().describe("What the compared (issued/renewal) policy shows, as printed; \"Not shown\" if absent"),
  status: z.enum(STATUSES),
  priority: z.enum(PRIORITIES).describe("1 Correction needed, 2 Confirm, 3 Housekeeping; \"none\" for MATCH and N/A"),
  action: z.string().describe("One short line: what the account manager should do; empty for MATCH/N/A"),
  citation: z.string().describe("Where it was read, using the document labels, e.g. \"Quote p.4; Issued p.12\" or \"AMS360\""),
  correction_text: z.string().describe("Priority 1 only: \"Currently shows ___; should be ___ per [document dated ___].\" — empty otherwise")
})

const ExposureTable = z.object({
  section: z.enum(SECTIONS),
  line: z.string(),
  title: z.string().describe("e.g. \"Location matrix\", \"GL classes and exposures by location\", \"WC payroll by class and state\", \"Vehicle schedule\", \"Umbrella schedule of underlying\""),
  headers: z.string().describe("Column headings separated by \" | \""),
  rows: z.array(z.string()).describe("One row per item: cells separated by \" | \", one per heading. Start a row that has a discrepancy with its priority in brackets, e.g. \"[1] 2 | 91342 | ...\"; a matching row has no prefix")
})

const PremiumLine = z.object({
  line: z.string().describe("Coverage part, or \"Taxes, fees & surcharges\", \"Terrorism (TRIA)\", \"Installment charges\""),
  baseline: z.string().describe("Dollar amount as digits, e.g. \"9800.00\"; empty if not shown"),
  compared: z.string().describe("Dollar amount as digits; empty if not shown"),
  driver: z.string().describe("What drove the change, short; empty if unchanged"),
  explained_by_correction: z.boolean().describe("True when the change comes from a Priority 1 item")
})

const DRIVER_KINDS = ["Added / removed item", "Exposure change", "Rate / factor change", "Limit, deductible or coverage change", "Taxes, fees, surcharges", "Rounding", "Unexplained"] as const

const PremiumDriver = z.object({
  kind: z.enum(DRIVER_KINDS),
  line: z.string(),
  detail: z.string().describe("Baseline → compared, e.g. \"Payroll $410,000 → $520,000 (class 5645)\""),
  impact: z.number().describe("Dollar impact, signed"),
  ref: z.string().describe("The check row ref this driver relates to; empty if none")
})

const FormRow = z.object({
  form_number: z.string(),
  title: z.string(),
  baseline_edition: z.string().describe("Empty if not on the baseline"),
  compared_edition: z.string().describe("Empty if not on the compared policy"),
  change: z.enum(["Added", "Removed", "Edition", "Same"]),
  coverage_effect: z.string().describe("One line; for added forms, what the form does")
})

const AmsRow = z.object({
  topic: z.string(),
  ams_shows: z.string().describe("One or two sentences with dates"),
  effect: z.string().describe("e.g. \"Explains the addition — moved from Correction to Confirm\", \"Resolved — now a MATCH\", \"Still open\", \"Context only\""),
  ref: z.string().describe("Related check row ref; empty if none")
})

export const PolicyCheckFindingsSchema = z.object({
  mode: z.enum(["quote_to_issued", "expiring_to_renewal", "both"]),
  client_name: z.string().describe("First named insured exactly as on the compared policy"),
  policies_checked: z.array(z.object({ line: z.string(), carrier: z.string(), policy_number: z.string(), term: z.string() })),
  documents_reviewed: z.array(z.object({ label: z.string(), description: z.string().describe("e.g. \"Cincinnati quote dated 9/12/2026, 38 pp.\"") })),
  not_reviewed: z.array(z.string()).describe("Documents or sources not reviewed, unreadable pages, or AMS360 if the cross-check found nothing"),
  rows: z.array(CheckRow).describe("Every check performed, MATCH rows included, in checklist order"),
  exposure_tables: z.array(ExposureTable),
  premium_by_line: z.array(PremiumLine),
  premium_drivers: z.array(PremiumDriver),
  forms: z.array(FormRow),
  ams_cross_reference: z.array(AmsRow)
})

// The schema keeps every field a plain string (no nullables, no nested row objects) because the
// richer version compiled to a structured-output grammar the API rejects as too large (2026-11-22,
// same limit as quoteExtraction.ts). normalizeFindings turns that wire shape back into the
// typed shape the runner and report use.
type RawFindings = z.infer<typeof PolicyCheckFindingsSchema>
type Raw<K extends keyof RawFindings> = RawFindings[K][number]

export type CheckRowFindings = Omit<Raw<"rows">, "correction_text"> & { correction_text: string | null }
export type PolicyCheckFindings = Omit<RawFindings, "rows" | "exposure_tables" | "premium_by_line" | "premium_drivers" | "forms" | "ams_cross_reference"> & {
  rows: CheckRowFindings[]
  exposure_tables: (Omit<Raw<"exposure_tables">, "rows"> & { rows: { cells: string; priority: typeof PRIORITIES[number] }[] })[]
  premium_by_line: (Omit<Raw<"premium_by_line">, "baseline" | "compared"> & { baseline: number | null; compared: number | null })[]
  premium_drivers: (Omit<Raw<"premium_drivers">, "ref"> & { ref: string | null })[]
  forms: (Omit<Raw<"forms">, "baseline_edition" | "compared_edition"> & { baseline_edition: string | null; compared_edition: string | null })[]
  ams_cross_reference: (Omit<Raw<"ams_cross_reference">, "ref"> & { ref: string | null })[]
}

const orNull = (value: string) => (value.trim() ? value.trim() : null)

function amount(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "")
  if(!cleaned) return null
  const negative = /^\(.*\)$/.test(cleaned) || cleaned.startsWith("-")
  const n = Number(cleaned.replace(/[()-]/g, ""))
  return Number.isFinite(n) ? (negative ? -n : n) : null
}

export function normalizeFindings(raw: RawFindings): PolicyCheckFindings {
  return {
    ...raw,
    rows: raw.rows.map((r) => ({ ...r, correction_text: orNull(r.correction_text) })),
    exposure_tables: raw.exposure_tables.map((t) => ({
      ...t,
      rows: t.rows.map((row) => {
        const match = row.match(/^\s*\[([123])\]\s*/)
        return match ? { cells: row.slice(match[0].length), priority: match[1] as "1" | "2" | "3" } : { cells: row.trim(), priority: "none" as const }
      })
    })),
    premium_by_line: raw.premium_by_line.map((l) => ({ ...l, baseline: amount(l.baseline), compared: amount(l.compared) })),
    premium_drivers: raw.premium_drivers.map((d) => ({ ...d, ref: orNull(d.ref) })),
    forms: raw.forms.map((f) => ({ ...f, baseline_edition: orNull(f.baseline_edition), compared_edition: orNull(f.compared_edition) })),
    ams_cross_reference: raw.ams_cross_reference.map((a) => ({ ...a, ref: orNull(a.ref) }))
  }
}

export type CheckDocument = { label: string; filename: string; role: PolicyCheckRole; file: Buffer; pages: number; profile?: DocumentProfile }

const ROLE_HEADING: Record<PolicyCheckRole, string> = {
  baseline: "BASELINE (should be: quote / binder / expiring policy)",
  compared: "COMPARED (what was issued: issued or renewal policy)",
  reference: "REFERENCE (endorsements, applications, contracts and other source-of-truth documents)"
}

function systemPrompt(): string {
  return `You are Boxwood Insurance Group's commercial lines policy checker. An account manager has uploaded documents and you perform the accuracy review described in Boxwood's Policy Check checklist below, returning structured findings. Software turns your findings into the branded Word report, numbers the items, counts the scorecard and does the premium arithmetic — so return data, not a document.

How this run differs from the checklist's own instructions:
- The documents are attached to the message, each titled with a label and its role. The roles were assigned by the account manager — use them as given; don't reassign documents. Reference documents include endorsements: treat an endorsement as a change to the baseline the account manager knows about, and cite it.
- The AMS360 cross-check (section E) has already been pulled for you and is in the message as JSON. Apply section E's effects table using it. Cite it as "AMS360" with dates. If it found no customer or failed, add "AMS360" to not_reviewed. Never mention internal ids or employee codes.
- Cite pages using the document labels, e.g. "Quote p.4" or "Issued p.12".
- rows: one row per check you performed, MATCH rows included (keep them brief), in checklist order. Don't number items; give each row a short unique ref. Only ERROR, MISSING, ADDED, CHANGED and VERIFY rows carry priority 1-3; MATCH and N/A carry "none".
- Keep every cell to one short line. Copy names, numbers and form numbers exactly as printed.
- Refs are internal: never mention a ref in any text the account manager reads (item, action, detail, effect). To point at another finding, describe it ("the Location 2 addition above").
- premium_by_line: one row per coverage part plus taxes/fees, terrorism and installment charges, as numbers. premium_drivers must explain the total change; leave any remainder you can't trace for the software to label Unexplained rather than forcing it.
- forms: every form on either side, Added and Removed first.
- Internal document for the account manager: plain, specific wording, no buying recommendations.

${ readFileSync(CHECKLIST_PATH, "utf8") }`
}

export async function runPolicyCheck({ documents, ams, notes }: { documents: CheckDocument[]; ams: AmsCrossCheck; notes?: string }): Promise<PolicyCheckFindings> {
  const totalPages = documents.reduce((sum, d) => sum + d.pages, 0)
  if(totalPages > MAX_TOTAL_PAGES) {
    throw new PolicyCheckError(`These documents total ${ totalPages } pages; a check can read ${ MAX_TOTAL_PAGES } at most. Remove reference documents or upload only the relevant policy sections.`)
  }

  const raw = await analyzeDocuments({
    groups: ROLES.map((role) => ({
      heading: ROLE_HEADING[role],
      documents: documents.filter((d) => d.role === role).map((d) => ({ title: `${ d.label } — ${ d.filename } (${ d.pages } pp.)`, filename: d.filename, file: d.file }))
    })),
    trailingText: [
      `AMS360 cross-check (Boxwood MCP, pulled ${ ams.pulled_at }):`,
      JSON.stringify(ams),
      notes?.trim() ? `\nAccount manager's notes for this check:\n${ notes.trim() }` : "",
      "\nRun the policy check on these documents."
    ].join("\n"),
    system: systemPrompt(),
    schema: PolicyCheckFindingsSchema,
    logLabel: "policy_check"
  })
  return normalizeFindings(raw as RawFindings)
}
