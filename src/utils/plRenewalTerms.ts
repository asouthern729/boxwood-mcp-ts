import { runReadOnlyQuery } from "../db.js"
import { CUSTOMER_NAME_EXPR } from "./clPolicyData.js"
import type { ResolvedPolicy } from "./clPolicyData.js"

// PL Renewal Summary shows the RENEWAL term for any policy whose renewal has already downloaded
// (Andrew, 2026-09-30): the summary is built at renewal — often triggered by that very download — so
// the client should see what they're renewing into, not the expiring term. Every other policy keeps
// its current in-force term. Applied after resolveClPolicies (the lookup shared with the commercial
// tools, which is untouched).
//
// A successor qualifies when: it's the next term (priorpolid), personal lines, not deleted or a
// submission; the carrier has downloaded its renewal (an RWL download row); it wasn't cancelled at
// inception (same predicate as pl_renewal_premium_change); and it carries real coverage detail (≥1
// active coverage row with a limit or deductible) — otherwise the current term is kept. Checked by
// the postgres peer (2026-09-30): 181 of 3,065 in-force PL policies have a downloaded successor, and
// all 181 arrive with full coverage/vehicle/location/scheduled-item detail, so the completeness
// check is insurance rather than a common fallback.
const DOWNLOADED_SUCCESSOR_QUERY = `
  SELECT DISTINCT ON (cur.polid)
    cur.polid AS current_polid,
    s.polid, s.polno, s.poleffdate, s.polexpdate, s.custid, s.csrcode,
    ${ CUSTOMER_NAME_EXPR } AS customer_name,
    co.name AS carrier_name,
    COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), s.csrcode) AS csr_name,
    s.fulltermpremium,
    NULLIF(TRIM(prod.email), '') AS producer_email
  FROM afw_basicpolinfo cur
  JOIN afw_basicpolinfo s ON s.priorpolid = cur.polid
  LEFT JOIN afw_customer c ON c.custid = s.custid
  LEFT JOIN afw_company co ON co.cocode = s.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = s.csrcode
  LEFT JOIN afw_employee prod ON prod.empcode = s.execcode
  WHERE cur.polid = ANY($1::uuid[])
    AND s.typeofbus = 1
    AND s.status != 'D'
    AND s.polsubtype != 'S'
    AND EXISTS (
      SELECT 1 FROM afw_policytransaction pt
      WHERE pt.polid = s.polid AND pt.source = 'D' AND pt.trantype = 'RWL'
    )
    AND s.polexpdate <> s.poleffdate
    AND NOT EXISTS (
      SELECT 1 FROM afw_policytransaction x
      WHERE x.polid = s.polid AND x.trantype IN ('XLN', 'XLC')
        AND x.effdate::date = s.poleffdate::date
        AND NOT EXISTS (
          SELECT 1 FROM afw_policytransaction y
          WHERE y.polid = x.polid AND y.trantype = 'REI' AND y.entereddate > x.entereddate
        )
    )
    AND EXISTS (
      SELECT 1 FROM afw_coverage cv
      WHERE cv.polid = s.polid AND cv.status <> 'D' AND (cv.limit1 IS NOT NULL OR cv.deduct1 IS NOT NULL)
    )
  ORDER BY cur.polid, s.poleffdate DESC, s.entereddate DESC
`

type SuccessorRow = ResolvedPolicy & { current_polid: string }

export async function withDownloadedRenewalTerms(policies: ResolvedPolicy[]): Promise<{ policies: ResolvedPolicy[]; renewedPolids: Set<string> }> {
  if(policies.length === 0) return { policies, renewedPolids: new Set() }

  const successors = await runReadOnlyQuery(DOWNLOADED_SUCCESSOR_QUERY, [policies.map((p) => p.polid)]) as SuccessorRow[]
  const byCurrent = new Map(successors.map((s) => [s.current_polid, s]))
  const renewedPolids = new Set<string>()

  const swapped = policies.map((p) => {
    const next = byCurrent.get(p.polid)
    if(!next) return p
    renewedPolids.add(next.polid)
    const { current_polid: _currentPolid, ...successor } = next
    return successor
  })

  // When a policy's old and new terms overlap (renewal day, or a carrier's too-long expiration), the
  // lookup returns both and the swap turns the old one into the new one — keep each term once.
  const seen = new Set<string>()
  const unique = swapped.filter((p) => (seen.has(p.polid) ? false : (seen.add(p.polid), true)))

  return { policies: unique, renewedPolids }
}

// The same policy number can come back in force more than once on a personal account — never two
// real policies (postgres peer, 2026-09-30: 22 such groups across 21 accounts). It's an agency-entered
// placeholder shell next to the carrier's real term ($0, "Monoline", no coverage, no carrier download
// — Kimbra Morris's 6835594207), a carrier cancel + reissue, or leftover renewal-quote terms. Showing
// both would double a section on the summary, so per polno: drop a term with no carrier download when
// a sibling has one, a term cancelled with no later reinstatement, and a quote-only term; then keep
// the one with the most recent carrier download (then latest effective date). Anything the rules
// can't separate is reported back so a rep can clean it up in AMS360.
const TERM_EVIDENCE_QUERY = `
  SELECT b.polid,
    EXISTS (SELECT 1 FROM afw_policytransaction p WHERE p.polid = b.polid AND p.source = 'D') AS has_download,
    EXISTS (
      SELECT 1 FROM afw_policytransaction x
      WHERE x.polid = b.polid AND x.trantype IN ('XLN', 'XLC')
        AND NOT EXISTS (SELECT 1 FROM afw_policytransaction y WHERE y.polid = x.polid AND y.trantype = 'REI' AND y.entereddate > x.entereddate)
    ) AS cancelled,
    NOT EXISTS (SELECT 1 FROM afw_policytransaction p WHERE p.polid = b.polid AND p.trantype <> 'RWQ') AS quote_only,
    (SELECT max(p.entereddate) FROM afw_policytransaction p WHERE p.polid = b.polid AND p.source = 'D') AS last_download,
    b.entereddate
  FROM afw_basicpolinfo b
  WHERE b.polid = ANY($1::uuid[])
`

type TermEvidence = { polid: string; has_download: boolean; cancelled: boolean; quote_only: boolean; last_download: string | null; entereddate: string | null }

export async function dedupeSamePolicyNumber(policies: ResolvedPolicy[]): Promise<{ policies: ResolvedPolicy[]; unresolvedPolnos: string[] }> {
  const groups = new Map<string, ResolvedPolicy[]>()
  for(const p of policies) groups.set(`${ p.custid }|${ p.polno }`, [...(groups.get(`${ p.custid }|${ p.polno }`) ?? []), p])
  const duplicated = [...groups.values()].filter((g) => g.length > 1)
  if(duplicated.length === 0) return { policies, unresolvedPolnos: [] }

  const evidence = new Map(
    (await runReadOnlyQuery(TERM_EVIDENCE_QUERY, [duplicated.flat().map((p) => p.polid)]) as TermEvidence[]).map((e) => [e.polid, e])
  )
  const time = (v: string | null | undefined) => (v ? new Date(v).getTime() : 0)
  const dropped = new Set<string>()
  const unresolvedPolnos: string[] = []

  for(const group of duplicated) {
    let keep = group
    const narrow = (test: (e: TermEvidence) => boolean) => {
      const survivors = keep.filter((p) => { const e = evidence.get(p.polid); return !e || !test(e) })
      if(survivors.length > 0) keep = survivors
    }
    if(keep.some((p) => evidence.get(p.polid)?.has_download)) narrow((e) => !e.has_download)
    narrow((e) => e.cancelled)
    narrow((e) => e.quote_only)

    if(keep.length > 1) unresolvedPolnos.push(group[0].polno)
    const winner = [...keep].sort((a, b) =>
      time(evidence.get(b.polid)?.last_download) - time(evidence.get(a.polid)?.last_download)
      || time(b.poleffdate) - time(a.poleffdate)
      || time(evidence.get(b.polid)?.entereddate) - time(evidence.get(a.polid)?.entereddate))[0]
    for(const p of group) if(p.polid !== winner.polid) dropped.add(p.polid)
  }

  return { policies: policies.filter((p) => !dropped.has(p.polid)), unresolvedPolnos }
}
