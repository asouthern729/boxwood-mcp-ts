import { slotForLob, type LineSlot } from "./clCoverageData.js"
import type { PolicyData } from "./clPolicyData.js"
import { BOND_LOBS, type PolicyLobInfo } from "./policyLineOfBusiness.js"

// Patrick (2026-11-18, Kreager Community Property Trust): "Sometimes not all lines pull." A line of
// business on the policy whose section never made it into the document is reported back for the CSR
// only: in the tool's reply and on the document's archive entry (the dashboard flags it), never in
// the document itself, which goes to the client.
export type CoverageGap = {
  polno: string
  // AMS360's own name for the line (afw_lobsetup), e.g. "Businessowners Property".
  line: string
  // The section the document should have had for it.
  missing: string
}

type PolicyLines = { polno: string; lob: PolicyLobInfo }

// The Pre-Renewal Risk Profile only has exposure sections for these lines; umbrella, crime, cyber and
// similar lines have nothing to schedule there, so they're never reported missing.
const RISK_PROFILE_EXPECTED: Partial<Record<LineSlot, { section: string; present: (d: PolicyData) => boolean }>> = {
  property: { section: "Property Coverage", present: (d) => d.property.length > 0 },
  general_liability: { section: "General Liability Exposure", present: (d) => d.glExposure.length > 0 },
  commercial_auto: { section: "Vehicle List", present: (d) => d.vehicles.length > 0 },
  workers_comp: { section: "Workers' Compensation Exposure", present: (d) => d.wcExposure.length > 0 }
}

// Equipment comes only from contractors' equipment-style inland marine, not builders risk or EDP.
const EQUIPMENT_LOBS = new Set(["INMRC", "CONTR"])

export function riskProfileGaps(policies: (PolicyLines & { data: PolicyData })[]): CoverageGap[] {
  const gaps: CoverageGap[] = []

  for(const { polno, lob, data } of policies) {
    lob.lobCodes.forEach((code, i) => {
      const line = lob.lobDescriptions[i] ?? code
      if(EQUIPMENT_LOBS.has(code)) {
        if(!data.equipmentBlanket && data.equipmentItems.length === 0) gaps.push({ polno, line, missing: "Equipment List & Value" })
        return
      }
      const expected = RISK_PROFILE_EXPECTED[slotForLob(code)]
      if(expected && !expected.present(data)) gaps.push({ polno, line, missing: expected.section })
    })
  }

  return dedupe(gaps)
}

// Bonds never carry coverage records in AMS360 (Surety, Notary Bond: 20 of 32 flags in a 132-policy
// sample, 2026-11-19), so flagging them would be noise the CSR learns to ignore.
// The Renewal Summary gives every line of business its own section, so any other line on a printed
// term without one is a gap.
export function renewalSummaryGaps(policies: PolicyLines[], printed: { polno: string; slot: LineSlot }[]): CoverageGap[] {
  const have = new Set(printed.map((l) => `${ l.polno.trim() }|${ l.slot }`))
  const gaps: CoverageGap[] = []

  for(const { polno, lob } of policies) {
    lob.lobCodes.forEach((code, i) => {
      if(BOND_LOBS.has(code)) return
      const slot = slotForLob(code)
      if(!have.has(`${ polno.trim() }|${ slot }`)) gaps.push({ polno, line: lob.lobDescriptions[i] ?? code, missing: `${ lob.lobDescriptions[i] ?? code } section` })
    })
  }

  return dedupe(gaps)
}

// A package can list two LOB codes that land on the same section (BOPPR + PROP); report it once.
function dedupe(gaps: CoverageGap[]): CoverageGap[] {
  const seen = new Set<string>()
  return gaps.filter((g) => {
    const key = `${ g.polno }|${ g.missing }`
    return seen.has(key) ? false : (seen.add(key), true)
  })
}

export function describeGaps(gaps: CoverageGap[]): string {
  return gaps.map((g) => `${ g.polno.trim() } ${ g.line }: no ${ g.missing }`).join("; ")
}
