import Anthropic from "@anthropic-ai/sdk"
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import ExcelJS from "exceljs"
import * as z from "zod"
import { PdfConverterUnavailableError, convertDocxToPdf } from "./docxToPdf.js"

// Reads an uploaded carrier quote PDF into structured, per-line-of-business fields — the "option to
// upload pdf for separate policies" on the CL Renewal Summary (Patrick, 2026-09-29). Deliberately
// template-agnostic: this returns what the quote says, and clQuoteMerge.ts decides where it goes in
// whichever document layout is current (since 2026-10-08, Patrick's insurance-proposal format), so
// the extraction survives a template change untouched.
//
// The fields mirror the insurance-proposal skill's references/coverage-fields.md (Patrick's own spec
// for what a proposal shows per line). Each line lists the PDF pages it came from so each section
// built from a quote records its source internally (it isn't written into the document). Per-value page numbers were dropped 2026-10-08: nothing read them, and
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
    // "Exposure: " titles carry what's insured (GL classes, vehicles, drivers) — added 2026-10-20 for
    // Patrick's Landon feedback, in this field because a separate one made the grammar too large again.
    title: z.string().describe("e.g. \"Coverage Limits by Location\", \"Coverage Limits by Dwelling\"; an exposure table's title starts with \"Exposure: \""),
    // Headers and cells joined with " | " rather than arrays — nested arrays (and per-table page
    // lists) made the structured-output grammar too large for the API to compile (400, 2026-10-08).
    headers: z.string().describe("Column headings separated by \" | \", e.g. \"Loc. / Bldg. | Location Address | Building | Business Personal Property | Business Income / Extra Expense\""),
    rows: z.array(z.string()).describe("One row per location/building/dwelling: one cell per heading, in heading order, separated by \" | \", as printed; \"—\" where a column doesn't apply")
  })).describe("Tables of limits that vary by location, building, dwelling, or other scheduled item, plus the exposure tables (titles starting \"Exposure: \") — never premiums or rates"),
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
    .describe("Subjectivities, conditions to bind, requote triggers, and program-wide notes (e.g. coinsurance or ACV reminders), about six at most, one concise line each — not exclusions, not the quote's expiration date (that's quote_expiration_date)"),
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
- Exposures go in schedules as their own tables, titled with an "Exposure: " prefix — not in key_facts. General liability: one "Exposure: Classification & Exposure Schedule" table — Class Code | Description | Basis | Estimated Exposure (basis in words, e.g. "Payroll", "Subcontracted Cost", "Gross Sales"; exposure as a dollar amount or count, e.g. "$20,000,000"). Commercial auto: an "Exposure: Scheduled Vehicle Coverage" table — Veh. No. | Vehicle Description (year make model, plus stated amount or ACV and any attached-equipment amount) | VIN — and, when the quote lists rated drivers, an "Exposure: Scheduled Drivers" table — Driver | License State (blank if not shown). Never a driver's date of birth, license number, points or violations, and never a per-class or per-vehicle premium.
- Umbrella: list the underlying schedule as key_facts labeled "Underlying: <line>".
- Name the line's endorsement package in enhancement_package_name when the quote names one (e.g. "CinciPlus Commercial Property XC+"). Notable exclusions go in exclusions; bind_conditions is for subjectivities, requote triggers, quote validity, and program notes.
- Keep enhancements and exclusions short enough to read at a glance: about eight lines each at most. Give the ones that matter most to the client a line of their own, in plain words with the form number in parentheses (e.g. "Bodily injury to contractors or subcontractors is excluded (CSGA3177)"); group related forms into one line (e.g. "The definition of \"insured contract\" is amended (CG 24 26) and the duties-in-the-event-of-occurrence condition is amended (CSGA439)"); and finish with one line naming the remaining routine exclusions together (e.g. "Other exclusions include EIFS, fungi or bacteria, silica, total pollution, communicable disease, war"). Leave out standard boilerplate (nuclear energy, the policy jacket, state amendatory endorsements).
- key_facts are for what a client would want to know about the coverage. Leave out administrative details — carrier admitted/non-admitted status, the premises address, UMR or quote reference numbers, number of employees, payment plans, premium discounts, Lloyd's syndicate participation — except put minimum premium and audit terms in bind_conditions.
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
export function normalizedPdf(pdf: Buffer): Buffer {
  const start = pdf.indexOf(PDF_HEADER)
  if(start === -1 || start > 1024) throw new QuoteExtractionError("This file isn't a PDF — download the quote again as a PDF and upload that.")
  return start === 0 ? pdf : pdf.subarray(start)
}

// Streamed with a 64K output budget: a full carrier proposal (Cincinnati's 53-page TN Equine quote)
// plus high-effort thinking overran the previous 16K cap mid-JSON. Streaming is what lets max_tokens
// go that high without an HTTP timeout. When the structured output can't be parsed, the partial
// message's stop reason still says whether it was cut short.
export async function extractQuote(file: Buffer, filename: string): Promise<QuoteExtraction> {
  const opts = { schema: QuoteExtractionSchema, system: SYSTEM_PROMPT, instruction: "Extract every coverage line in this quote.", noun: "quote" }
  const kind = quoteFileKind(file)

  if(kind === "xlsx") {
    return readStructured(
      { type: "document", source: { type: "text", media_type: "text/plain", data: await workbookText(file) }, title: filename },
      { ...opts, instruction: `${ opts.instruction }\n\n${ XLSX_NOTE }` }
    )
  }
  if(kind === "png" || kind === "jpeg") {
    if(file.length > MAX_IMAGE_BYTES) throw new QuoteExtractionError("This image is over 5 MB. Upload a screenshot or a smaller photo, or save the quote as a PDF.")
    return readStructured(
      { type: "image", source: { type: "base64", media_type: kind === "png" ? "image/png" : "image/jpeg", data: file.toString("base64") } },
      { ...opts, instruction: `${ opts.instruction }\n\nThis quote is an image (a screenshot or photo); its page number is 1.` }
    )
  }
  // A Word quote becomes a PDF first, so it's read (and its pages cited) exactly like a PDF quote.
  if(kind === "docx") return readPdfStructured(await docxQuoteToPdf(file), filename, opts)

  return readPdfStructured(file, filename, opts)
}

// ---------- Quotes that aren't PDFs ----------
// .xlsx (2026-11-25): the workbook is turned into plain text, one block per sheet with each non-empty
// row's cells joined by " | ". .docx and images (also 2026-11-25): a Word quote is converted to PDF
// with LibreOffice; a PNG or JPEG screenshot/photo is sent as an image. All are read with the same
// schema and prompt as a PDF, so the merge into the renewal summary or proposal doesn't know the
// difference.

export type QuoteFileKind = "pdf" | "xlsx" | "docx" | "png" | "jpeg" | "xls"

// From the bytes, since browsers label Office files inconsistently. .xlsx and .docx are zips whose
// entry names (stored as plain text) include xl/workbook.xml or word/document.xml; an old binary
// .xls is an OLE file.
export function quoteFileKind(file: Buffer): QuoteFileKind | null {
  const pdfAt = file.indexOf(PDF_HEADER)
  if(pdfAt !== -1 && pdfAt <= 1024) return "pdf"
  if(file.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    if(file.includes("xl/workbook")) return "xlsx"
    if(file.includes("word/document")) return "docx"
    return null
  }
  if(file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png"
  if(file.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpeg"
  if(file.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "xls"
  return null
}

// The API's per-image limit.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

async function docxQuoteToPdf(docx: Buffer): Promise<Buffer> {
  try {
    return await convertDocxToPdf(docx)
  } catch(error) {
    if(error instanceof PdfConverterUnavailableError) throw new QuoteExtractionError("Word quotes can't be read on this server yet. Save the quote as a PDF and upload that.")
    throw new QuoteExtractionError("This Word file couldn't be opened. Save it as a PDF and upload that.")
  }
}

const XLSX_NOTE = "This quote is an Excel workbook converted to text: each sheet starts with a \"## Sheet N\" heading and each row reads \"R<row>: cell | cell | ...\". In pages, list the sheet numbers the line came from instead of PDF pages. Numbers appear unformatted (e.g. 1000000 for $1,000,000; 0.02 may be 2%), so format limits and premiums as the quote evidently means them."

// About 100k tokens; a quote workbook bigger than this is almost certainly a rating export, not a quote.
const MAX_WORKBOOK_CHARS = 400_000

function cellText(value: ExcelJS.CellValue): string {
  if(value === null || value === undefined) return ""
  if(value instanceof Date) return value.toISOString().slice(0, 10)
  if(typeof value !== "object") return String(value)
  if("richText" in value) return value.richText.map((r) => r.text).join("")
  if("formula" in value || "sharedFormula" in value) return "result" in value && value.result !== undefined ? cellText(value.result as ExcelJS.CellValue) : ""
  if("text" in value) return String(value.text)
  if("error" in value) return ""
  return ""
}

export async function workbookText(file: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(file as unknown as ArrayBuffer)
  } catch {
    throw new QuoteExtractionError("This Excel file couldn't be opened. Save it again as .xlsx and upload that.")
  }

  const sheets: string[] = []
  workbook.worksheets.forEach((sheet, i) => {
    const rows: string[] = []
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: string[] = []
      for(let c = 1; c <= row.cellCount; c++) {
        const cell = row.getCell(c)
        // A merged range repeats its value in every cell; keep it in the first one only.
        cells.push(cell.isMerged && cell.master.address !== cell.address ? "" : cellText(cell.value).replace(/\s+/g, " ").trim())
      }
      while(cells.length && !cells[cells.length - 1]) cells.pop()
      if(cells.some(Boolean)) rows.push(`R${ rowNumber }: ${ cells.join(" | ") }`)
    })
    if(rows.length) sheets.push(`## Sheet ${ i + 1 }: ${ sheet.name }${ sheet.state === "visible" ? "" : " (hidden)" }\n${ rows.join("\n") }`)
  })

  const text = sheets.join("\n\n")
  if(!text) throw new QuoteExtractionError("This Excel file is empty.")
  if(text.length > MAX_WORKBOOK_CHARS) throw new QuoteExtractionError("This Excel file has more detail than can be read in one pass — remove sheets that aren't part of the quote and upload it again.")
  return text
}

// One structured read of a PDF — shared with the Proposal Builder's AMS360 proposal reader
// (amsProposalExtraction.ts). `noun` names the document in the errors staff see.
type StructuredRead<T extends z.ZodType> = { schema: T; system: string; instruction: string; noun: string }

export async function readPdfStructured<T extends z.ZodType>(pdf: Buffer, filename: string, opts: StructuredRead<T>): Promise<z.infer<T>> {
  return readStructured({ type: "document", source: { type: "base64", media_type: "application/pdf", data: normalizedPdf(pdf).toString("base64") }, title: filename }, opts)
}

async function readStructured<T extends z.ZodType>(
  document: Anthropic.Beta.BetaRequestDocumentBlock | Anthropic.Beta.BetaImageBlockParam, { schema, system, instruction, noun }: StructuredRead<T>
): Promise<z.infer<T>> {
  const tooLong = `This ${ noun } has more detail than can be read in one pass — upload the lines as separate files.`
  const unparsed = `The ${ noun } was read but the result couldn't be parsed — try uploading it again.`

  const stream = anthropic().beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: betaZodOutputFormat(schema) },
    system,
    messages: [{
      role: "user",
      content: [
        document,
        { type: "text", text: instruction }
      ]
    }]
  })

  let response: Awaited<ReturnType<typeof stream.finalMessage>>
  try {
    response = await stream.finalMessage()
  } catch(error) {
    if(error instanceof Anthropic.APIError) throw error
    if(stream.currentMessage?.stop_reason === "max_tokens") throw new QuoteExtractionError(tooLong)
    throw new QuoteExtractionError(unparsed)
  }

  if(response.stop_reason === "refusal") {
    throw new QuoteExtractionError(`The ${ noun } couldn't be read (the request was declined). Try a different copy of the file.`)
  }

  if(response.stop_reason === "max_tokens") throw new QuoteExtractionError(tooLong)

  if(!response.parsed_output) throw new QuoteExtractionError(unparsed)

  return response.parsed_output as z.infer<T>
}
