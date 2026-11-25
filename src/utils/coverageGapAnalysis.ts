import { readFileSync } from "node:fs"
import path from "node:path"
import * as z from "zod"
import { DocToolError, MAX_TOTAL_PAGES, analyzeDocuments } from "./docToolClaude.js"

// Coverage Gap (Andrew, 2026-11-25), from Patrick's org-shared "coverage-gap-analysis" skill: a
// commercial account's policy PDFs run through Boxwood's 11-step gap review into a condensed
// internal Word report (coverageGapDoc.ts). PDFs only — no AMS360, per Patrick's 11/10 email.
//
// Patrick (11/20) wants "a place where more information can" [be added]; until he says otherwise
// that's the account notes box: revenue, payroll, operations, contract requirements and the like,
// which the review uses as exposures but cites as "Staff notes", never as a document.
//
// Scorecard counts, sorting and the "Housekeeping" merge are done in code (normalizeGapAnalysis),
// not left to the model. The schema is flat for the same reason as the comparison's: nested
// structured-output grammars hit the API's size limit.

export type GapRole = "policy"
export const GAP_ROLES: readonly GapRole[] = ["policy"]

const INSTRUCTIONS_PATH = path.join(import.meta.dirname, "..", "..", "assets", "coverage-gap", "instructions.md")

export const GAP_STEPS = [
  "Document inventory and account profile",
  "Named insured consistency",
  "Policy period alignment",
  "Location schedule reconciliation",
  "Limits and sublimits vs exposures",
  "Named exclusions",
  "Exclusions that hit operations",
  "Limitations, conditions, deductibles",
  "Umbrella / excess underlying",
  "Coordination and missing lines",
  "Validation questions"
] as const

const STEP_STATUSES = ["OK", "GAP", "CONFIRM", "N/A"] as const
const PRIORITIES = ["High", "Medium", "Low"] as const

export const GapSchema = z.object({
  client_name: z.string().describe("First named insured as printed"),
  operations: z.string().describe("One line describing what the business does"),
  policies: z.array(z.object({
    carrier: z.string().describe("Writing company as printed"),
    policy_number: z.string().describe("Empty if not shown"),
    lines: z.string().describe("Line(s) of coverage, e.g. \"BOP (Property, GL)\""),
    term: z.string().describe("e.g. \"01/01/2026 – 01/01/2027, 12:01 AM\"; empty if not shown")
  })).describe("One per policy reviewed"),
  not_reviewed: z.array(z.string()).describe("Documents that couldn't be read, or policies referred to (e.g. scheduled as underlying) but not uploaded"),
  steps: z.array(z.object({
    step: z.number().int().describe("1-11"),
    status: z.enum(STEP_STATUSES).describe("GAP if the step has any GAP finding, else CONFIRM if any CONFIRM, else OK or N/A")
  })).describe("Exactly 11 entries, one per step of the standard"),
  findings: z.array(z.object({
    step: z.number().int().describe("The step (1-11) that found it"),
    status: z.enum(["GAP", "CONFIRM"]),
    priority: z.enum(PRIORITIES),
    coverage_part: z.string().describe("e.g. \"General Liability\", \"Umbrella\", \"All policies\""),
    finding: z.string().describe("One or two short lines"),
    impact: z.string().describe("Operational impact, e.g. \"Rentals to groups are not covered\""),
    action: z.string().describe("What the producer/CSR should do"),
    citation: z.string().describe("Document name + form number, or \"Staff notes\" when it rests on the account notes")
  })).describe("Every GAP and CONFIRM, stated once"),
  locations: z.array(z.object({
    address: z.string(),
    property: z.string().describe("e.g. \"Yes\", \"Mailing\", \"—\""),
    gl: z.string().describe("GL / Garage"),
    wc: z.string(),
    other: z.string().describe("Other policies listing it, e.g. \"Auto (garaging)\""),
    notes: z.string()
  })).describe("Location matrix (Step 4) — only when Step 4 has findings; else empty"),
  term_groups: z.array(z.object({
    term: z.string().describe("e.g. \"03/15/2026 – 03/15/2027\""),
    policies: z.string().describe("The policies on that term"),
    notes: z.string().describe("e.g. \"74 days after the GL term\"")
  })).describe("Policy term grouping (Step 3) — only when Step 3 has findings; else empty"),
  named_insureds: z.array(z.object({
    name: z.string().describe("Entity name as printed"),
    policy: z.string().describe("Policy it appears on (or \"None\")"),
    shown_as: z.string().describe("e.g. \"First named insured\", \"DBA\", \"Additional named insured\""),
    note: z.string()
  })).describe("Named insured table (Step 2) — only the mismatched rows, and only when Step 2 has findings; else empty"),
  underlying: z.array(z.object({
    underlying: z.string().describe("Underlying coverage, e.g. \"Employers Liability\""),
    scheduled: z.string().describe("Yes / No"),
    number_match: z.string().describe("Yes / No / —"),
    term_match: z.string().describe("Yes / No / —"),
    limits_match: z.string().describe("Yes / No / —")
  })).describe("Umbrella underlying check (Step 9) — only when Step 9 has findings; else empty"),
  validation_questions: z.array(z.string()).describe("One plain-language client question per CONFIRM"),
  recommendations: z.array(z.string()).describe("At most 5")
})

type Raw = z.infer<typeof GapSchema>
type StepStatus = typeof STEP_STATUSES[number]
type Priority = typeof PRIORITIES[number]

export type GapFinding = Raw["findings"][number]
export type GapAnalysis = Omit<Raw, "steps" | "findings" | "recommendations"> & {
  steps: { step: number; title: string; status: StepStatus; findings: number }[]
  findings: GapFinding[]
  recommendations: string[]
  // Low-priority findings folded into one "Housekeeping" row when the list runs long.
  housekeeping_merged: number
}

const PRIORITY_ORDER: Record<Priority, number> = { High: 0, Medium: 1, Low: 2 }
// Past this many findings the report runs beyond the skill's 3-5 pages, so Lows merge.
const MERGE_LOW_ABOVE = 18

export function normalizeGapAnalysis(raw: Raw): GapAnalysis {
  let findings = raw.findings
    .filter((f) => f.step >= 1 && f.step <= GAP_STEPS.length)
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.step - b.step)

  let merged = 0
  const lows = findings.filter((f) => f.priority === "Low")
  if(findings.length > MERGE_LOW_ABOVE && lows.length > 1) {
    merged = lows.length
    findings = [
      ...findings.filter((f) => f.priority !== "Low"),
      {
        step: 0,
        status: lows.some((f) => f.status === "GAP") ? "GAP" : "CONFIRM",
        priority: "Low",
        coverage_part: "Housekeeping",
        finding: lows.map((f) => `${ f.coverage_part }: ${ f.finding }`).join("; "),
        impact: "Minor; tidy up at the next endorsement or renewal.",
        action: lows.map((f) => f.action).join("; "),
        citation: [...new Set(lows.map((f) => f.citation))].join("; ")
      }
    ]
  }

  // Counts and status come from the findings themselves, so the scorecard always agrees with the
  // table; the model's status is kept only to tell OK from N/A on steps with no findings.
  const steps = GAP_STEPS.map((title, i) => {
    const step = i + 1
    // Step 11 turns each CONFIRM into a client question, so it scores by those questions.
    if(step === GAP_STEPS.length) {
      const questions = raw.validation_questions.length
      return { step, title, status: (questions > 0 ? "CONFIRM" : "OK") as StepStatus, findings: questions }
    }
    const own = raw.findings.filter((f) => f.step === step)
    const given = raw.steps.find((s) => s.step === step)?.status
    const status: StepStatus = own.some((f) => f.status === "GAP") ? "GAP" : own.length > 0 ? "CONFIRM" : given === "N/A" ? "N/A" : "OK"
    return { step, title, status, findings: own.length }
  })

  return { ...raw, steps, findings, recommendations: raw.recommendations.slice(0, 5), housekeeping_merged: merged }
}

function systemPrompt(): string {
  return `You are Boxwood Insurance Group's coverage gap reviewer. A staff member has uploaded a commercial account's policy documents and you review them as described in Boxwood's Coverage Gap Analysis instructions below. Software turns your answer into the internal Word report, so return data, not a document — ignore the instructions' references to loading skills or building files.

How this run differs from the instructions:
- The policy documents are attached. Review every one in full, endorsements included.
- The staff member may add account notes (operations, revenue, payroll, employees, contract requirements, things the client told them). Use them as exposure information for Steps 1, 5, 7 and 10, but they are not policy documents: cite a finding that rests on them as "Staff notes", and never treat a note as proof of what a policy covers. Anything a note leaves open still becomes a validation question.
- Fill the structured fields. The exhibits (locations, term_groups, named_insureds, underlying) are only for steps that have findings; leave them empty otherwise. Every GAP and CONFIRM goes in findings exactly once with its step number.
- Copy limits, deductibles, form numbers and names exactly as printed. Never estimate a figure that isn't in the documents or the notes.

${ readFileSync(INSTRUCTIONS_PATH, "utf8") }`
}

export type GapDocument = { filename: string; file: Buffer; pages: number }

export async function runCoverageGapAnalysis({ documents, notes }: { documents: GapDocument[]; notes?: string }): Promise<GapAnalysis> {
  const totalPages = documents.reduce((sum, d) => sum + d.pages, 0)
  if(totalPages > MAX_TOTAL_PAGES) {
    throw new DocToolError(`These documents total ${ totalPages } pages; a gap analysis can read ${ MAX_TOTAL_PAGES } at most. Upload the declarations, forms schedules and endorsements rather than full policy jackets.`)
  }

  const raw = await analyzeDocuments({
    groups: [{
      heading: "POLICY DOCUMENTS",
      documents: documents.map((d) => ({ title: `${ d.filename } (${ d.pages } pp.)`, filename: d.filename, file: d.file }))
    }],
    trailingText: [
      notes?.trim() ? `Account notes from the staff member (not from the documents):\n${ notes.trim() }` : "No account notes were given.",
      "Run the 11-step coverage gap review on this account."
    ].join("\n\n"),
    system: systemPrompt(),
    schema: GapSchema,
    logLabel: "coverage_gap"
  })
  return normalizeGapAnalysis(raw as Raw)
}
