import { runReadOnlyQuery } from "../db.js"

// Single source of truth for "what's this policy's Current/Renewal premium right now," shared by
// renewal_premium_summary's full generation (renewalPremiumSummary.ts) and the Refresh path
// (renewalPremiumSummaryRefresh.ts) — both need the exact same fallback rules (see comments below,
// carried over verbatim from the original tool) so a refreshed cell can never disagree with what a
// fresh full regeneration would have written for the same policy. Only the columns Current/Renewal
// actually depend on — Refresh never touches Carrier, coverage, or row layout, so nothing else
// (customer/company/employee joins, premium_as_of) is pulled here.
export const ACCOUNT_POLICY_PREMIUMS_QUERY = `
  SELECT p.polno,
    p.fulltermpremium,
    -- 2026-09-19 finding: a real, non-trivial share of "current" commercial terms carry
    -- fulltermpremium=0/null at the header even though their own bind/renewal transaction already
    -- recorded a real premium (confirmed against real data — see ams360-etl's trace on
    -- FSF1838131A 001: annualizedpremium=1056.00 on its one RWL transaction, header still 0.00
    -- sixteen days later). Not AMS360 catching up later — cprem (the detailed coverage-line rating
    -- table) shows the same gap, so there's nothing else in the synced schema to prefer over this.
    -- Used as a flagged Current fallback below, never silently swapped in.
    lasttxn.annualizedpremium AS last_written_premium,
    -- Andrew's finding, same date: a term nearing its own renewal can already have a bound successor
    -- term (new polid, priorpolid pointing back here) sitting in the data — and that successor's own
    -- fulltermpremium is sometimes already real/priced. That's not a better Current figure — it's
    -- the client's actual, already-known Renewal premium, which the template otherwise always
    -- leaves blank for hand entry. Only ever the most recently effective successor, in the rare case
    -- more than one somehow exists.
    successor.fulltermpremium AS successor_fulltermpremium
  FROM afw_basicpolinfo p
  LEFT JOIN LATERAL (
    SELECT t.annualizedpremium
    FROM afw_policytransaction t
    -- != 0, not just IS NOT NULL (boxwood-mcp-ts-0d review, 2026-09-19): a later $0 administrative
    -- endorsement would otherwise win this ORDER BY over an earlier RWL/NBS transaction that
    -- actually carries the real premium.
    WHERE t.polid = p.polid AND t.annualizedpremium IS NOT NULL AND t.annualizedpremium != 0
    ORDER BY t.effdate DESC, t.changeddate DESC
    LIMIT 1
  ) lasttxn ON true
  LEFT JOIN LATERAL (
    SELECT s.fulltermpremium
    FROM afw_basicpolinfo s
    WHERE s.priorpolid = p.polid AND s.status != 'D'
    ORDER BY s.poleffdate DESC
    LIMIT 1
  ) successor ON true
  WHERE p.typeofbus = 2
    AND p.polsubtype != 'S'
    AND p.status != 'D'
    AND p.poleffdate <= now()
    AND p.polexpdate >= now()
    AND p.custid = $1
  LIMIT 30
`

export type AccountPolicyPremiums = {
  polno: string
  fulltermpremium: string | number | null
  last_written_premium: string | number | null
  successor_fulltermpremium: string | number | null
}

// AMS360's synced money-shaped fields are inconsistently text vs. numeric — returns a real number
// (for an Excel SUM formula / numFmt) rather than a formatted display string.
export function toNumber(raw: string | number | null | undefined): number | null {
  if(raw === null || raw === undefined || raw === "") return null
  if(typeof raw === "number") return Number.isFinite(raw) ? raw : null

  const cleaned = raw.replace(/[$,]/g, "").trim()
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : null
}

export type PolicyCurrentRenewal = {
  current: number | null
  renewal: number | null
  usedFallback: boolean
  fallbackAmount: number | null
}

// Same Current/Renewal derivation as the full-generation tool (fulltermpremium, falling back to the
// last real transaction premium when the header itself reads 0/null; Renewal only ever comes from an
// already-bound successor term's own fulltermpremium, never invented).
export function computeCurrentRenewal(policy: AccountPolicyPremiums): PolicyCurrentRenewal {
  const rawCurrent = toNumber(policy.fulltermpremium)
  const fallbackCurrent = toNumber(policy.last_written_premium)
  const usedFallback = (rawCurrent === null || rawCurrent === 0) && fallbackCurrent !== null && fallbackCurrent !== 0
  const current = usedFallback ? fallbackCurrent : rawCurrent
  const renewal = toNumber(policy.successor_fulltermpremium) || null

  return { current, renewal, usedFallback, fallbackAmount: usedFallback ? fallbackCurrent : null }
}

// Fetches every current, in-force commercial policy on the account and keys its Current/Renewal
// values by polno — the shape Refresh needs to look up "what should policy X's Current/Renewal read
// right now," without re-running any of the line-of-business/row-layout logic that only full
// generation cares about.
export async function fetchCurrentRenewalByPolno(custid: string): Promise<Map<string, PolicyCurrentRenewal>> {
  const policies = await runReadOnlyQuery(ACCOUNT_POLICY_PREMIUMS_QUERY, [custid]) as AccountPolicyPremiums[]
  return new Map(policies.map((p) => [p.polno, computeCurrentRenewal(p)]))
}
