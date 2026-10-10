import { runReadOnlyQuery } from "../db.js"
import { CUSTOMER_NAME_EXPR } from "./clPolicyData.js"
import { CUSTOMER_SORT_NAME_EXPR } from "./customerNames.js"
import type { ResolvedPolicy } from "./clPolicyData.js"

// The CL Renewal Summary is a renewal proposal (Andrew, 2026-09-30), so once a policy's renewal term
// is in AMS360 the document shows that term — its limits, schedules and dates — rather than the
// expiring one. Same idea as plRenewalTerms.ts, with a different test for "the renewal is in":
//   - No RWL download required. CL renewals are often entered by hand (postgres peer, 2026-10-01:
//     manual renewals land a median 6 days early), and of the 71 CL terms expiring in the next 60
//     days with a filled-in successor on 2026-10-08, 16 had no downloaded RWL.
//   - Instead the successor must carry active afw_cprem rows — that's where every CL limit lives
//     (clCoverageData.ts); a successor without them would print an empty proposal. 3 of those 74
//     successors had none (2026-10-08) and keep the expiring term.
// Not cancelled at inception — same predicate as plRenewalTerms.ts / pl_renewal_premium_change.
const CL_SUCCESSOR_QUERY = `
  SELECT DISTINCT ON (cur.polid)
    cur.polid AS current_polid,
    s.polid, s.polno, s.poleffdate, s.polexpdate, s.custid, s.csrcode,
    ${ CUSTOMER_NAME_EXPR } AS customer_name,
    ${ CUSTOMER_SORT_NAME_EXPR } AS customer_sort_name,
    co.name AS carrier_name,
    COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), s.csrcode) AS csr_name,
    NULLIF(TRIM(prod.email), '') AS producer_email
  FROM afw_basicpolinfo cur
  JOIN afw_basicpolinfo s ON s.priorpolid = cur.polid
  LEFT JOIN afw_customer c ON c.custid = s.custid
  LEFT JOIN afw_company co ON co.cocode = s.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = s.csrcode
  LEFT JOIN afw_employee prod ON prod.empcode = s.execcode
  WHERE cur.polid = ANY($1::uuid[])
    AND s.typeofbus = 2
    AND s.status != 'D'
    AND s.polsubtype != 'S'
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
      SELECT 1 FROM (
        SELECT cp.status, ROW_NUMBER() OVER (PARTITION BY cp.polid, cp.lobid, cp.cpremid ORDER BY cp.effdate DESC) AS rn
        FROM afw_cprem cp
        WHERE cp.polid = s.polid
      ) cp
      WHERE cp.rn = 1 AND cp.status != 'D'
    )
  ORDER BY cur.polid, s.poleffdate DESC, s.entereddate DESC
`

// `current` is the in-force term the document is keyed and archived under (resolution, quote
// uploads and rebuilds all go by it); `data` is the term whose contents are printed — the renewal
// when it qualifies, otherwise the current term itself.
export type ClDocumentTerm = { current: ResolvedPolicy; data: ResolvedPolicy; isRenewal: boolean }

export async function withClRenewalTerms(policies: ResolvedPolicy[]): Promise<ClDocumentTerm[]> {
  if(policies.length === 0) return []

  const successors = await runReadOnlyQuery(CL_SUCCESSOR_QUERY, [policies.map((p) => p.polid)]) as (ResolvedPolicy & { current_polid: string })[]
  const byCurrent = new Map(successors.map(({ current_polid, ...successor }) => [current_polid, successor as ResolvedPolicy]))

  return policies.map((current) => {
    const next = byCurrent.get(current.polid)
    return next ? { current, data: next, isRenewal: true } : { current, data: current, isRenewal: false }
  })
}

// Which of these current terms now have a qualifying renewal term — the daily job rebuilds a
// document once one lands (scripts/dailyClRenewalSummaries.ts). The query only reads polid.
export async function polidsWithRenewal(polids: string[]): Promise<Set<string>> {
  if(polids.length === 0) return new Set()
  const rows = await runReadOnlyQuery(CL_SUCCESSOR_QUERY, [polids]) as { current_polid: string }[]
  return new Set(rows.map((r) => r.current_polid))
}
