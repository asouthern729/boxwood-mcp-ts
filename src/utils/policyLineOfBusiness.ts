import { runReadOnlyQuery } from "../db.js"

// Not deduped/history-aware on purpose (no ROW_NUMBER()/status filter on afw_lineofbusiness itself)
// — matches policyQuery.ts's "premiums" include, which joins the same table the same way.
const LOB_QUERY = `
  SELECT DISTINCT l.lineofbus, lo.descriptionlobs
  FROM afw_lineofbusiness l
  LEFT JOIN afw_lobsetup lo ON l.lineofbus = lo.namelobs
  WHERE l.polid = $1
  ORDER BY l.lineofbus
`

function clean(value: string | null | undefined): string {
  return value?.trim() ?? ""
}

export type PolicyLobInfo = { lobCodes: string[]; lobDescriptions: string[]; classification: "Monoline" | "Package" | "" }

// afw_basicpolinfo.polsubtype is NOT a Monoline/Package indicator, despite reading that way from its
// name — confirmed against the real _code_lookup table (2026-09-11, investigating a "Policy" label
// bug in commercial_renewal_summary/renewal_premium_summary): it's a fixed 4-value record-type enum
// (A=Accounting, B=Service Agreement, P=Policy, S=Submission), hardcoded in the AMS360 Design Guide,
// not PRCode-backed. Every real in-force commercial policy just reads "Policy" — that's exactly what
// the `polsubtype != 'S'` filter elsewhere in this codebase excludes (submission shells), not a
// monoline/package distinction. The actual signal for that distinction is how many distinct lines of
// business the policy carries (afw_lineofbusiness): one is a monoline policy, two or more is a
// package blending them into one rated program.
export async function fetchPolicyLobInfo(polid: string): Promise<PolicyLobInfo> {
  const rows = await runReadOnlyQuery(LOB_QUERY, [polid]) as { lineofbus: string | null; descriptionlobs: string | null }[]

  const lobCodes = rows.map((r) => clean(r.lineofbus)).filter(Boolean)
  const lobDescriptions = rows.map((r) => clean(r.descriptionlobs) || clean(r.lineofbus)).filter(Boolean)
  const classification: PolicyLobInfo["classification"] = lobCodes.length === 0 ? "" : lobCodes.length === 1 ? "Monoline" : "Package"

  return { lobCodes, lobDescriptions, classification }
}
