import Anthropic from "@anthropic-ai/sdk"
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import * as z from "zod"

// Reads an uploaded carrier quote PDF into structured, per-line-of-business fields — the "option to
// upload pdf for separate policies" on the CL Renewal Summary (Patrick, 2026-09-29). Deliberately
// template-agnostic: this returns what the quote says, and clQuoteMerge.ts decides where it goes in
// whichever document layout is current (since 2026-10-08, Patrick's insurance-proposal format), so
// the extraction survives a template change untouched.
//
// The fields mirror the insurance-proposal skill's references/coverage-fields.md (Patrick's own spec
// for what a proposal shows per line). Each line lists the PDF pages it came from so the document
// can point a reviewer at the source — each section built from a quote gets a Word comment saying
// so (Andrew, 2026-10-01). Per-value page numbers were dropped 2026-10-08: nothing read them, and
// the schema had to shrink to fit the schedules tables under the structured-output grammar limit.

export const LINES_OF_BUSINESS = [
  "property", "general_liability", "liquor_liability", "inland_marine", "commercial_auto",
  "workers_comp", "employee_benefits_liability", "umbrella_excess", "directors_officers", "cyber",
  "epli", "professional_liability", "specialty_addon", "other"
] as const

export type LineOfBusiness = typeof LINES_OF_BUSINESS[number]

const PageRef = z.number().int().describe("1-indexed PDF page number this value was read from")

const QuoteLine = z.object({
  line_of_business: z.enum(LINES_OF_BUSINESS),
  title: z.string().describe("The coverage line as the quote names it, e.g. \"Commercial General Liability\""),
  carrier: z.string().nullable(),
  am_best_rating: z.string().nullable().describe("Only if printed on the quote"),
  policy_form: z.string().nullable().describe("Coverage form or trigger, e.g. \"Occurrence\", \"Claims-Made\", \"Special Form\""),
  retroactive_date: z.string().nullable().describe("Claims-made lines only"),
  policy_period: z.string().nullable().describe("Effective – expiration as printed"),
  annual_premium: z.number().nullable().describe("Total annual premium for this line in dollars, including TRIA/fees only if the quote's line total includes them"),
  premium_note: z.string().nullable().describe("e.g. \"Includes TRIA $45\", \"Paid monthly\", \"Subject to audit\""),
  limits: z.array(z.object({
    coverage: z.string(),
    limit: z.string().describe("As printed, e.g. \"$1,000,000\", \"Statutory\", \"Included\""),
    deductible: z.string().nullable()
  })).describe("Policy-wide limits only — per-location, per-building, or per-dwelling limits go in schedules"),
  // Added 2026-10-08 so per-location limits come out as a table (Patrick's example: "Coverage Limits
  // by Location", "Coverage Limits by Dwelling") instead of one flat row per building and coverage.
  // Extractions stored before then lack it; readers default it (clQuoteMerge.ts).
  schedules: z.array(z.object({
    title: z.string().describe("e.g. \"Coverage Limits by Location\", \"Coverage Limits by Dwelling\""),
    // Headers and cells joined with " | " rather than arrays — nested arrays (and per-table page
    // lists) made the structured-output grammar too large for the API to compile (400, 2026-10-08).
    headers: z.string().describe("Column headings separated by \" | \", e.g. \"Loc. / Bldg. | Location Address | Building | Business Personal Property | Business Income / Extra Expense\""),
    rows: z.array(z.string()).describe("One row per location/building/dwelling: one cell per heading, in heading order, separated by \" | \", as printed; \"—\" where a column doesn't apply")
  })).describe("Tables of limits that vary by location, building, dwelling, or other scheduled item — never premiums or rates"),
  key_facts: z.array(z.object({
    label: z.string().describe("e.g. \"Covered Autos (Symbol)\", \"Coinsurance\", \"Experience Mod\", \"States Covered\""),
    value: z.string()
  })).describe("Other top-line facts from coverage-fields for this line that aren't a limit/deductible pair"),
  // enhancement_package_name and exclusions were added 2026-10-08; extractions stored before then
  // lack them, so readers default them (clQuoteMerge.ts).
  enhancement_package_name: z.string().nullable()
    .describe("The named endorsement/enhancement package, if the quote names one, e.g. \"CinciPlus Commercial Property XC+\", \"CGL Broadened Endorsement\""),
  enhancements: z.array(z.object({ text: z.string() }))
    .describe("Notable endorsements/enhancements, one concise line each naming the enhancement and its key detail — never a premium"),
  exclusions: z.array(z.object({ text: z.string() }))
    .describe("Notable exclusions worth flagging to the client, one concise line each"),
  bind_conditions: z.array(z.object({ text: z.string() }))
    .describe("Subjectivities, conditions to bind, requote triggers, quote-validity terms, and program-wide notes (e.g. coinsurance or ACV reminders) — not exclusions"),
  pages: z.array(PageRef).describe("Every page this line's information came from")
})

export const QuoteExtractionSchema = z.object({
  named_insured: z.string().nullable().describe("Exactly as printed on the quote"),
  quote_number: z.string().nullable(),
  quote_expiration_date: z.string().nullable(),
  lines: z.array(QuoteLine),
  unreadable_pages: z.array(PageRef).describe("Pages that were scanned/illegible and couldn't be read")
})

export type QuoteExtraction = z.infer<typeof QuoteExtractionSchema>
export type QuoteLineExtraction = QuoteExtraction["lines"][number]

const MODEL = "claude-opus-5-5"

const SYSTEM_PROMPT = `You extract coverage details from commercial insurance quote, binder, and renewal PDFs for Boxwood Insurance Group, an independent agency. What you extract is inserted into a client-facing renewal document, where account managers verify it against the PDF — so accuracy matters more than completeness.

- Report only what the document states. Copy names, limits, deductibles, and dates as printed; never infer, estimate, or fill a field from general knowledge. Leave a field null (or a list empty) when the quote doesn't show it.
- One entry in "lines" per coverage line (property, general liability, auto, workers' comp, umbrella, etc.). A package policy quoting several lines gets one entry per line. A stand-alone add-on that doesn't fit a standard line (e.g. a wind/hail deductible buy-back) is "specialty_addon".
- Never put a premium, rate, or rate-per-$100 figure into limits, key_facts, enhancements, or bind_conditions — premium belongs only in annual_premium (the line's total; convert a monthly premium to annual and say so in premium_note). Skip per-vehicle and per-class premiums entirely.
- When limits vary by location, building, or dwelling, put them in schedules as one table — one row per location/building/dwelling (cells separated by " | "), the location/building identifier and address first, then one column per coverage limit (e.g. Building, Business Personal Property, Business Income / Extra Expense; or Dwelling, Other Structures). Six columns at most. Add a non-limit column only when the value differs from row to row and matters to the client (e.g. a roof payout percentage); leave descriptive attributes (occupancy, construction, roof type, yes/no provisions) out of the table — a provision that applies to only some locations belongs in enhancements or exclusions, naming the locations. Keep deductibles, valuation, and coinsurance that apply to every row as key_facts, and don't repeat the table's rows in limits or key_facts.
- Commercial auto: list each scheduled vehicle as a key_fact labeled "Vehicle <n>" with year/make/model and VIN, not as a limit.
- Umbrella: list the underlying schedule as key_facts labeled "Underlying: <line>".
- Name the line's endorsement package in enhancement_package_name when the quote names one (e.g. "CinciPlus Commercial Property XC+"). Notable exclusions go in exclusions; bind_conditions is for subjectivities, requote triggers, quote validity, and program notes.
- List in pages every 1-indexed PDF page the line's information came from.`

let client: Anthropic | null = null

function anthropic(): Anthropic {
  client ??= new Anthropic()
  return client
}

export class QuoteExtractionError extends Error {}

const PDF_HEADER = Buffer.from("%PDF-")

// Some carrier portals wrap the download: American Modern's dec page (Patrick's TN Equine email,
// 2026-10-07) starts with a 22-byte Java serialization header before "%PDF-". Desktop viewers skip
// leading junk, but the API rejects the file as "not valid" — so anything before the header is cut.
function normalizedPdf(pdf: Buffer): Buffer {
  const start = pdf.indexOf(PDF_HEADER)
  if(start === -1 || start > 1024) throw new QuoteExtractionError("This file isn't a PDF — download the quote again as a PDF and upload that.")
  return start === 0 ? pdf : pdf.subarray(start)
}

const TOO_LONG = "This quote has more detail than can be read in one pass — upload the lines as separate PDFs."

// Streamed with a 64K output budget: a full carrier proposal (Cincinnati's 53-page TN Equine quote)
// plus high-effort thinking overran the previous 16K cap mid-JSON. Streaming is what lets max_tokens
// go that high without an HTTP timeout. When the structured output can't be parsed, the partial
// message's stop reason still says whether it was cut short.
export async function extractQuote(pdf: Buffer, filename: string): Promise<QuoteExtraction> {
  const stream = anthropic().beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: betaZodOutputFormat(QuoteExtractionSchema) },
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: normalizedPdf(pdf).toString("base64") }, title: filename },
        { type: "text", text: "Extract every coverage line in this quote." }
      ]
    }]
  })

  let response: Awaited<ReturnType<typeof stream.finalMessage>>
  try {
    response = await stream.finalMessage()
  } catch(error) {
    if(error instanceof Anthropic.APIError) throw error
    if(stream.currentMessage?.stop_reason === "max_tokens") throw new QuoteExtractionError(TOO_LONG)
    throw new QuoteExtractionError("The quote was read but the result couldn't be parsed — try uploading it again.")
  }

  if(response.stop_reason === "refusal") {
    throw new QuoteExtractionError("The quote couldn't be read (the request was declined). Try a different copy of the PDF.")
  }

  if(response.stop_reason === "max_tokens") throw new QuoteExtractionError(TOO_LONG)

  if(!response.parsed_output) {
    throw new QuoteExtractionError("The quote was read but the result couldn't be parsed — try uploading it again.")
  }

  return response.parsed_output
}
