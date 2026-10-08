import { carrierKey, joinList } from "./clProposalLines.js"
import type { SlotLine } from "./clProposalLines.js"

// The proposal's narrative paragraphs — fixed wording filled from data (Andrew, 2026-10-08: no LLM
// pass for now; revisit once Patrick has seen real output). The Executive Summary follows the
// skill's references/default-intro-letter.md; "Why Boxwood" adapts the closing of Patrick's
// TN Equine example, with the client-specific details limited to what AMS360 actually knows.

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "the District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming"
}

// How each line reads inside a sentence ("covers the company's property, general liability, ...").
const LINE_PHRASES: Record<string, string> = {
  property: "commercial property",
  general_liability: "general liability",
  liquor_liability: "liquor liability",
  inland_marine: "inland marine",
  commercial_auto: "commercial auto",
  workers_comp: "workers' compensation",
  employee_benefits_liability: "employee benefits liability",
  umbrella_excess: "umbrella liability",
  directors_officers: "directors and officers liability",
  cyber: "cyber liability",
  epli: "employment practices liability",
  professional_liability: "professional liability",
  crime: "crime"
}

export type NarrativeFacts = {
  clientName: string
  lines: SlotLine[]
  policyPeriod: string
  policyPeriodsDiffer: boolean
  isRenewal: boolean
  locationStates: string[]
  locationCount: number
  vehicleCount: number
  namedInsuredCount: number
}

function plural(count: number, noun: string): string {
  return `${ count } ${ noun }${ count === 1 ? "" : "s" }`
}

// One name per carrier — AMS360 and a quote spell the same company differently; the fuller name wins.
function carriers(lines: SlotLine[]): string[] {
  const byKey = new Map<string, string>()
  for(const name of lines.map((l) => l.carrier).filter(Boolean)) {
    const existing = byKey.get(carrierKey(name))
    if(!existing || name.length > existing.length) byKey.set(carrierKey(name), name)
  }
  return [...byKey.values()]
}

export function executiveSummary(facts: NarrativeFacts): string[] {
  const states = [...new Set(facts.locationStates)].map((s) => STATE_NAMES[s] ?? s)
  const business = facts.locationCount > 0
    ? `, a business with ${ plural(facts.locationCount, "scheduled location") }${ states.length > 0 ? ` in ${ joinList(states) }` : "" }`
    : ""
  const carrierNames = carriers(facts.lines)
  const basis = facts.isRenewal ? "on a renewal basis" : "under its current policies"
  const period = facts.policyPeriodsDiffer ? "for the policy periods shown in each coverage section" : `for the policy period ${ facts.policyPeriod }`
  const placement = carrierNames.length === 0
    ? ""
    : carrierNames.length === 1
      ? ` All coverages are placed with ${ carrierNames[0] } ${ basis } ${ period }.`
      : ` Coverages are placed with ${ joinList(carrierNames) } ${ basis } ${ period }.`

  const phrases = [...new Set(facts.lines.map((l) => LINE_PHRASES[l.slot] ?? l.title.toLowerCase()))]

  return [
    `This proposal presents the ${ facts.isRenewal ? "renewal" : "current" } commercial insurance program for ${ facts.clientName }${ business }.${ placement }`,
    ...(phrases.length > 0 ? [`The program covers the company's ${ joinList(phrases) } exposures.`] : [])
  ]
}

export function whyBoxwood(facts: NarrativeFacts): string[] {
  const scope = [
    facts.locationCount > 1 ? plural(facts.locationCount, "location") : "",
    facts.namedInsuredCount > 1 ? plural(facts.namedInsuredCount, "named insured") : "",
    facts.vehicleCount > 0 ? `a fleet of ${ plural(facts.vehicleCount, "vehicle") }` : ""
  ].filter(Boolean)
  const carrierNames = carriers(facts.lines)

  const opening = scope.length > 0
    ? `A program with ${ joinList(scope) } does not fit an off-the-shelf package.`
    : `A commercial program like ${ facts.clientName }'s does not fit an off-the-shelf package.`
  const placement = carrierNames.length > 0
    ? ` Boxwood is an independent agency, so we build each program around how the business actually operates and place it with the carriers best suited to it — here, ${ joinList(carrierNames) }.`
    : " Boxwood is an independent agency, so we build each program around how the business actually operates and place it with the carriers best suited to it."

  return [
    opening + placement,
    "When a claim happens, our team stays involved from first notice through resolution rather than leaving you to navigate the carrier alone. We also review the program with you before each renewal, so payroll, vehicles, equipment, and locations stay accurate and the coverage keeps pace as the business grows."
  ]
}
