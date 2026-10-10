import * as z from "zod"
import { LINES_OF_BUSINESS, readPdfStructured } from "./quoteExtraction.js"

// Reads an AMS360-generated proposal (Patrick's sample, "franksandfranks out of ams.docx",
// 2026-10-09) for the Proposal Builder: service team, named insureds, locations, one entry per
// coverage section (GL limits and classes, Umbrella and its underlying schedule, Business Auto
// coverages/symbols/vehicles/drivers, Property premises and subjects of insurance, Inland Marine
// equipment), the Premium Summary and the "Subject To" conditions. The boilerplate after them
// (Suggested Coverages, signature pages, Coverage Definitions) is skipped.
//
// A .docx upload is converted to PDF first (docxToPdf.ts) so its tables keep their layout.
// proposalBuilderGenerate.ts maps the result into the CL Renewal Summary's proposal layout.

// The structured-output grammar has a size limit the first, fully nested version of this schema
// overran (400 "compiled grammar is too large", 2026-10-10), so the schema is flat — plain strings
// ("" when absent) and " | "-joined rows — and parseAms() turns it back into typed fields.
const RawLine = z.object({
  line_of_business: z.enum(LINES_OF_BUSINESS),
  title: z.string().describe("The section heading as printed, e.g. \"General Liability\", \"Business Auto\", \"Commercial Property\""),
  carrier: z.string().describe("\"Coverage Provided By\" for this section"),
  writing_company: z.string().describe("The Writing company for this section's policy (Policy Information table)"),
  policy_number: z.string().describe("This section's policy number (Policy Information table)"),
  policy_period: z.string().describe("\"Policy Term\" as printed"),
  limits: z.array(z.string()).describe("Policy-wide coverages, one per entry: \"coverage | limit | deductible\" (deductible blank when none). Auto symbols go in key_facts"),
  key_facts: z.array(z.string()).describe("Other single facts as \"label: value\", e.g. \"Covered Autos (Symbol), Combined single limit: 1 – Any Auto\", \"Retention: $10,000\""),
  tables: z.array(z.object({
    kind: z.enum(["limits", "schedule"]).describe("limits: limits that vary by location/building/item (Subjects of Insurance, Equipment Summary amounts). schedule: what's insured (Liability Classification without any premium column, Premise Information, Garage Locations, Vehicle Schedule, Driver Schedule with Driver #, Name and License State ONLY, Inland Marine locations, Underlying Liability)"),
    title: z.string(),
    headers: z.string().describe("Column headings separated by \" | \""),
    rows: z.array(z.string()).describe("One per printed row, cells separated by \" | \" in heading order")
  })),
  endorsements: z.array(z.string()).describe("\"Included Options and Endorsements\", one per entry"),
  pages: z.array(z.number().int())
})

const AmsRawSchema = z.object({
  named_insured: z.string(),
  additional_named_insureds: z.array(z.string()).describe("Every other distinct named insured, each once"),
  mailing_address: z.string().describe("Only if printed"),
  service_team: z.array(z.string()).describe("\"role | name | email | phone\", e.g. \"Account Manager | Jill Holzen | jill@boxwoodins.com | (615)245-5851\""),
  locations: z.array(z.string()).describe("Each distinct address once (repeated per policy in the proposal; \"Rd\"/\"Road\" at the same number are one place): \"loc# | address | city | state | zip\""),
  lines: z.array(RawLine).describe("One entry per coverage section, in printed order"),
  expiring_premiums: z.array(z.string()).describe("Premium Summary rows: \"line of business | expiring premium | company\" — stored, never printed"),
  subject_to: z.array(z.string()).describe("The \"Subject To\" conditions")
})

type Table = { title: string; headers: string; rows: string[] }

export type AmsLineExtraction = {
  line_of_business: typeof LINES_OF_BUSINESS[number]
  title: string
  carrier: string | null
  writing_company: string | null
  policy_number: string | null
  policy_period: string | null
  limits: { coverage: string; limit: string; deductible: string | null }[]
  key_facts: { label: string; value: string }[]
  limit_schedules: Table[]
  exposure_schedules: Table[]
  endorsements: { text: string }[]
  pages: number[]
}

export type AmsProposalExtraction = {
  named_insured: string | null
  additional_named_insureds: string[]
  mailing_address: string | null
  service_team: { role: string; name: string; email: string | null; phone: string | null }[]
  locations: { loc_no: string; address: string; city: string; state: string; zip: string }[]
  lines: AmsLineExtraction[]
  expiring_premiums: { line: string; premium: string | null; company: string | null }[]
  subject_to: { text: string }[]
}

const orNull = (value: string | undefined) => value?.trim() || null
const cells = (row: string) => row.split("|").map((c) => c.trim())

function parseAms(raw: z.infer<typeof AmsRawSchema>): AmsProposalExtraction {
  return {
    named_insured: orNull(raw.named_insured),
    additional_named_insureds: raw.additional_named_insureds.map((n) => n.trim()).filter(Boolean),
    mailing_address: orNull(raw.mailing_address),
    service_team: raw.service_team.map(cells).filter((c) => c[1]).map(([role, name, email, phone]) => ({ role, name, email: orNull(email), phone: orNull(phone) })),
    locations: raw.locations.map(cells).filter((c) => c[1]).map(([loc_no, address, city, state, zip]) => ({ loc_no, address, city: city ?? "", state: state ?? "", zip: zip ?? "" })),
    lines: raw.lines.map((l) => ({
      line_of_business: l.line_of_business,
      title: l.title,
      carrier: orNull(l.carrier),
      writing_company: orNull(l.writing_company),
      policy_number: orNull(l.policy_number),
      policy_period: orNull(l.policy_period),
      limits: l.limits.map(cells).filter((c) => c[0]).map(([coverage, limit, deductible]) => ({ coverage, limit: limit ?? "", deductible: orNull(deductible) })),
      key_facts: l.key_facts.map((f) => {
        const at = f.indexOf(":")
        return at > 0 ? { label: f.slice(0, at).trim(), value: f.slice(at + 1).trim() } : { label: f.trim(), value: "" }
      }).filter((f) => f.label && f.value),
      limit_schedules: l.tables.filter((t) => t.kind === "limits"),
      exposure_schedules: l.tables.filter((t) => t.kind === "schedule"),
      endorsements: l.endorsements.map((text) => ({ text: text.trim() })).filter((e) => e.text),
      pages: l.pages
    })),
    expiring_premiums: raw.expiring_premiums.map(cells).map(([line, premium, company]) => ({ line, premium: orNull(premium), company: orNull(company) })),
    subject_to: raw.subject_to.map((text) => ({ text: text.trim() })).filter((c) => c.text)
  }
}

const SYSTEM_PROMPT = `You extract an AMS360-generated commercial insurance proposal for Boxwood Insurance Group, an independent agency. What you extract is rebuilt into a branded client proposal, where account managers verify it against the original — accuracy matters more than completeness.

- Report only what the document states; copy names, limits, deductibles, dates and identifiers as printed. Leave a field null (or a list empty) when the proposal doesn't show it. Never infer.
- One entry in "lines" per coverage section (General Liability, Umbrella, Business Auto, Commercial Property, Inland Marine, Flood, Watercraft, ...). Use the Policy Information table to fill each section's policy_number and writing_company.
- Never copy a driver's date of birth or driver's license number anywhere — the Driver Schedule keeps only Driver #, Name and License State.
- Never put a premium in limits, key_facts or any table (drop a "Premium" column). Premium appears only in expiring_premiums, read from the Premium Summary's Expiring Premium column.
- Use "" for a value the proposal doesn't show.
- Skip the symbol definitions list, Suggested Coverages, Acknowledgment of Coverage Recommendations, Disclaimer and Disclosure, Notice of Review and Acceptance, signature lines, and Coverage Definitions — they're boilerplate.
- Tables: one row per printed row, cells separated by " | ". Skip a table that has no rows.`

export async function extractAmsProposal(pdf: Buffer, filename: string): Promise<AmsProposalExtraction> {
  return parseAms(await readPdfStructured(pdf, filename, {
    schema: AmsRawSchema,
    system: SYSTEM_PROMPT,
    instruction: "Extract this AMS360 proposal.",
    noun: "proposal"
  }))
}
