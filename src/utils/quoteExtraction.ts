import Anthropic from "@anthropic-ai/sdk"
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import * as z from "zod"

// Reads an uploaded carrier quote PDF into structured, per-line-of-business fields — the "option to
// upload pdf for separate policies" on the CL Renewal Summary (Patrick, 2026-09-29). Deliberately
// template-agnostic: this returns what the quote says, and clQuoteMerge.ts decides where it goes in
// whichever document layout is current (Patrick's insurance-proposal format is still pending), so
// the extraction survives a template change untouched.
//
// The fields mirror the insurance-proposal skill's references/coverage-fields.md (Patrick's own spec
// for what a proposal shows per line). Every extracted value carries its PDF page so the document
// can point a reviewer at the source — each section built from a quote gets a Word comment saying
// so (Andrew, 2026-10-01).

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
  premium_page: PageRef.nullable(),
  limits: z.array(z.object({
    coverage: z.string(),
    limit: z.string().describe("As printed, e.g. \"$1,000,000\", \"Statutory\", \"Included\""),
    deductible: z.string().nullable(),
    page: PageRef
  })),
  key_facts: z.array(z.object({
    label: z.string().describe("e.g. \"Covered Autos (Symbol)\", \"Coinsurance\", \"Experience Mod\", \"States Covered\""),
    value: z.string(),
    page: PageRef
  })).describe("Other top-line facts from coverage-fields for this line that aren't a limit/deductible pair"),
  enhancements: z.array(z.object({ text: z.string(), page: PageRef }))
    .describe("Notable endorsements/enhancements, one concise line each naming the enhancement and its key detail — never a premium"),
  bind_conditions: z.array(z.object({ text: z.string(), page: PageRef }))
    .describe("Subjectivities, conditions to bind, requote triggers, notable exclusions worth flagging"),
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
- Commercial auto: list each scheduled vehicle as a key_fact labeled "Vehicle <n>" with year/make/model and VIN, not as a limit.
- Umbrella: list the underlying schedule as key_facts labeled "Underlying: <line>".
- Every value carries the 1-indexed page of the PDF it was read from.`

let client: Anthropic | null = null

function anthropic(): Anthropic {
  client ??= new Anthropic()
  return client
}

export class QuoteExtractionError extends Error {}

export async function extractQuote(pdf: Buffer, filename: string): Promise<QuoteExtraction> {
  const response = await anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: betaZodOutputFormat(QuoteExtractionSchema) },
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") }, title: filename },
        { type: "text", text: "Extract every coverage line in this quote." }
      ]
    }]
  })

  if(response.stop_reason === "refusal") {
    throw new QuoteExtractionError("The quote couldn't be read (the request was declined). Try a different copy of the PDF.")
  }

  if(response.stop_reason === "max_tokens") {
    throw new QuoteExtractionError("This quote has more detail than can be read in one pass — upload the lines as separate PDFs.")
  }

  if(!response.parsed_output) {
    throw new QuoteExtractionError("The quote was read but the result couldn't be parsed — try uploading it again.")
  }

  return response.parsed_output
}
