import type { CoverageSection, CoverageSectionSlot, RenewalSummaryInput } from "./riskProfileDoc.js"
import type { LineOfBusiness, QuoteExtraction, QuoteLineExtraction } from "./quoteExtraction.js"

// Puts uploaded-quote extractions (quoteExtraction.ts) into the CL Renewal Summary's CURRENT layout.
// This is the one template-specific piece of the quote-upload feature — when Patrick's
// insurance-proposal format replaces the layout, this mapping is what gets rewritten; extraction,
// storage, and the upload routes stay as they are.
//
// Rules:
//   - A quoted line replaces AMS360's limits section(s) in the same slot (property, liability, inland
//     marine, auto, WC, umbrella): the quote is the renewal, AMS360 is usually still the expiring
//     term. Exposure schedules (locations, vehicles, drivers, GL/WC exposure) stay — they're AMS360's
//     record of what's insured, not the quote's terms.
//   - Lines with no dedicated slot (liquor, EBL, D&O, cyber, EPLI, E&O, add-ons) are appended to
//     "other" without removing anything, since that slot mixes unrelated lines.
//   - When two uploads quote the same line, the later upload wins.
//   - Every section built from a quote carries a Word comment naming the file and pages, so the
//     account manager verifies it before the document goes to the client (Andrew, 2026-10-01).

const SLOT_BY_LINE: Record<LineOfBusiness, CoverageSectionSlot> = {
  property: "property",
  general_liability: "liability",
  liquor_liability: "other",
  inland_marine: "inlandMarine",
  commercial_auto: "auto",
  workers_comp: "workersComp",
  employee_benefits_liability: "other",
  umbrella_excess: "umbrella",
  directors_officers: "other",
  cyber: "other",
  epli: "other",
  professional_liability: "other",
  specialty_addon: "other",
  other: "other"
}

const REPLACEABLE_SLOTS = new Set<CoverageSectionSlot>(["property", "liability", "inlandMarine", "auto", "workersComp", "umbrella"])

export type QuoteSource = { filename: string; extraction: QuoteExtraction }

function money(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function pageLabel(pages: number[]): string {
  const sorted = [...new Set(pages)].filter((p) => p > 0).sort((a, b) => a - b)
  if(sorted.length === 0) return ""
  if(sorted.length === 1) return ` (page ${ sorted[0] })`

  // Collapse runs: 2,3,4,7 → "pages 2–4, 7"
  const runs: string[] = []
  let start = sorted[0]
  let prev = sorted[0]

  for(const page of [...sorted.slice(1), Number.NaN]) {
    if(page === prev + 1) {
      prev = page
      continue
    }
    runs.push(start === prev ? `${ start }` : `${ start }–${ prev }`)
    start = page
    prev = page
  }

  return ` (pages ${ runs.join(", ") })`
}

function quoteSection(line: QuoteLineExtraction, filename: string): CoverageSection {
  const keyFacts: [string, string][] = []
  if(line.carrier) keyFacts.push(["Carrier", line.carrier])
  if(line.am_best_rating) keyFacts.push(["A.M. Best Rating", line.am_best_rating])
  if(line.policy_form) keyFacts.push(["Policy Form", line.policy_form])
  if(line.retroactive_date) keyFacts.push(["Retroactive Date", line.retroactive_date])
  if(line.policy_period) keyFacts.push(["Policy Period", line.policy_period])
  // The current layout has no premium summary page, so the quoted premium rides here for now; the
  // insurance-proposal format moves it to its Premium Summary.
  if(line.annual_premium !== null) {
    keyFacts.push(["Annual Premium (Quoted)", line.premium_note ? `${ money(line.annual_premium) } — ${ line.premium_note }` : money(line.annual_premium)])
  }
  for(const fact of line.key_facts) keyFacts.push([fact.label, fact.value])

  return {
    title: line.title,
    rows: line.limits.map((l) => ({ coverage: l.coverage, limit: l.limit, deductible: l.deductible ?? "" })),
    keyFacts,
    bulletGroups: [
      { title: "Notable Enhancements & Endorsements", items: line.enhancements.map((e) => e.text) },
      { title: "Bind Conditions & Notes", items: line.bind_conditions.map((c) => c.text) }
    ],
    comment: `Added by Claude from uploaded quote "${ filename }"${ pageLabel(line.pages) }. Please verify against the quote before sending to the client.`
  }
}

export function mergeQuotesIntoRenewalSummary(input: RenewalSummaryInput, quotes: QuoteSource[]): RenewalSummaryInput {
  if(quotes.length === 0) return input

  // Later uploads win per line of business: keep only the last quote's entry for each line.
  const latestByLine = new Map<string, { line: QuoteLineExtraction; filename: string }>()
  for(const { filename, extraction } of quotes) {
    for(const line of extraction.lines) {
      const key = line.line_of_business === "other" || line.line_of_business === "specialty_addon"
        ? `${ line.line_of_business }:${ line.title.toLowerCase() }`
        : line.line_of_business
      latestByLine.set(key, { line, filename })
    }
  }

  const quoted = [...latestByLine.values()]
  const replacedSlots = new Set(quoted.map(({ line }) => SLOT_BY_LINE[line.line_of_business]).filter((slot) => REPLACEABLE_SLOTS.has(slot)))

  return {
    ...input,
    coverageSections: [
      ...input.coverageSections.filter((s) => !replacedSlots.has(s.key)),
      ...quoted.map(({ line, filename }) => ({ ...quoteSection(line, filename), key: SLOT_BY_LINE[line.line_of_business] }))
    ]
  }
}
