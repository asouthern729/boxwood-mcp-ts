import { runReadOnlyQuery } from "../db.js"
import { CUSTOMER_NAME_EXPR } from "./clPolicyData.js"
import { toNumber } from "./renewalPremiumSummaryPolicyValues.js"
import type { PlCalculatorLine, PlCalculatorLob, PlCalculatorTerm } from "./plRenewalPremiumChangeWorkbook.js"

// PL Renewal Premium Change: for personal-lines renewals a carrier downloaded (afw_policytransaction
// trantype='RWL', source='D'), the client's current vs renewal premium per line of business, grouped
// the way the PL team's Renewal Calculator workbook is filled in — one client, one renewal effective
// date, every PL policy renewing that day (Andrew, 2026-09-30). Shared by the MCP tool, the chat and
// the daily script; the workbook itself is plRenewalPremiumChangeWorkbook.ts.
//
// Premium rules (validated 2026-09-30 by the postgres peer against Patrick's own sample, the Acuity
// 10/18/2026 package — Homeowners 3,646→4,056, Auto 4,871→4,420, PA 1,365→1,356, Umbrella 659→593):
// - Both terms use fulltermpremium, never annualizedpremium (only populated on download rows since
//   ~Q1 2026, and truly annualized, so a 6-month auto reads ~2x). Prior term via priorpolid, falling
//   back to custid+polno only when priorpolid is missing (24 of 169 changed polno at renewal).
// - Per-line premium comes from afw_policytranpremium: each premium row belongs to the latest
//   transaction entered at or before it, and a line's value is the SUM of its rows from its latest
//   transaction (see LINE_PREMIUM_QUERY). That is the post-endorsement figure for the expiring term —
//   the fair like-for-like comparison. Per-line sums equal bp.fulltermpremium on every term checked.
// - Personal Articles is carved out of the HOME line (scheduled property priced inside the homeowners
//   policy) as the SPP summary premium, only when it's no larger than the HOME line itself. A
//   standalone Inland Marine (P) policy puts its whole premium on Personal Articles (its SPP rows go
//   stale on some Cincinnati terms, so they're not used there).
const PL_RENEWALS_QUERY = `
  SELECT DISTINCT ON (bp.polid)
    bp.polid, bp.custid::text AS custid, bp.polno, bp.poltypelob,
    to_char(bp.poleffdate, 'YYYY-MM-DD') AS poleffdate, to_char(bp.polexpdate, 'YYYY-MM-DD') AS polexpdate,
    bp.fulltermpremium AS renewal_premium,
    ${ CUSTOMER_NAME_EXPR } AS customer_name,
    co.name AS carrier_name,
    bp.csrcode AS csr_code,
    NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), '') AS csr_name,
    to_char(pt.entereddate, 'YYYY-MM-DD') AS downloaded_on,
    to_char(pt.synced_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS synced_at_utc,
    prior.polid AS prior_polid,
    prior.polno AS prior_polno,
    prior.fulltermpremium AS expiring_premium
  FROM afw_policytransaction pt
  JOIN afw_basicpolinfo bp ON bp.polid = pt.polid
  LEFT JOIN afw_customer c ON c.custid = bp.custid
  LEFT JOIN afw_company co ON co.cocode = bp.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = bp.csrcode
  LEFT JOIN LATERAL (
    SELECT p.polid, p.polno, p.fulltermpremium
    FROM afw_basicpolinfo p
    WHERE p.status != 'D'
      AND (
        p.polid = bp.priorpolid
        OR (bp.priorpolid IS NULL AND p.custid = bp.custid AND p.polno = bp.polno AND p.polexpdate <= bp.poleffdate)
      )
    ORDER BY (p.polid = bp.priorpolid) DESC, p.polexpdate DESC
    LIMIT 1
  ) prior ON true
  WHERE pt.source = 'D'
    AND pt.trantype = 'RWL'
    AND bp.typeofbus = 1
    AND bp.status != 'D'
    AND bp.polsubtype != 'S'
    -- Renewals that never took effect: cancelled at inception (an XLN/XLC effective on the renewal
    -- date, not later reinstated). NOT status='C' — that's set on ~40% of live renewals too.
    AND bp.polexpdate <> bp.poleffdate
    AND NOT EXISTS (
      SELECT 1 FROM afw_policytransaction x
      WHERE x.polid = bp.polid AND x.trantype IN ('XLN', 'XLC')
        AND x.effdate::date = bp.poleffdate::date
        AND NOT EXISTS (
          SELECT 1 FROM afw_policytransaction y
          WHERE y.polid = x.polid AND y.trantype = 'REI' AND y.entereddate > x.entereddate
        )
    )
    AND ($1::timestamp IS NULL OR pt.entereddate >= $1::timestamp)
    AND ($2::timestamp IS NULL OR pt.entereddate < $2::timestamp)
    AND ($3::timestamp IS NULL OR pt.synced_at > $3::timestamp)
    AND ($4::text IS NULL OR bp.custid::text = $4)
    AND ($5::text IS NULL OR ${ CUSTOMER_NAME_EXPR } ILIKE '%' || $5 || '%')
    AND ($6::text IS NULL OR bp.polno = $6)
    AND ($7::text[] IS NULL OR bp.custid::text = ANY($7::text[]))
  ORDER BY bp.polid, pt.entereddate DESC
`

// Per line of business, the SUM of the term's premium rows from its latest transaction. A premium
// row carries no transaction key, so it's assigned to the latest afw_policytransaction entered at or
// before it; ordering by effdate instead is wrong (carriers re-download with a backdated effdate),
// and taking one row per line is wrong too (Cincinnati writes a $0 companion row inside the same
// RWL). chargecatpoltp='1' is premium (2/4/5 are fees/taxes); includepremium is deliberately NOT
// filtered — Flood and some HO terms carry their only premium on 'N' rows.
const LINE_PREMIUM_QUERY = `
  SELECT y.polid, y.lineofbus, max(y.descriptionpoltp) AS lob_description, sum(y.fulltermpremium) AS fulltermpremium
  FROM (
    SELECT tp.polid, tp.lineofbus, tp.descriptionpoltp, tp.fulltermpremium,
           rank() OVER (PARTITION BY tp.polid, tp.lineofbus ORDER BY tk.tran_entered DESC) AS rk
    FROM afw_policytranpremium tp
    CROSS JOIN LATERAL (
      SELECT coalesce(max(pt.entereddate), tp.entereddate) AS tran_entered
      FROM afw_policytransaction pt
      WHERE pt.polid = tp.polid AND pt.entereddate <= tp.entereddate
    ) tk
    WHERE tp.polid = ANY($1::uuid[])
      AND tp.chargecatpoltp = '1'
  ) y
  WHERE y.rk = 1
  GROUP BY y.polid, y.lineofbus
`

// Scheduled personal property premium per policy line, from each schedule class's latest version
// (by entereddate) — dropped when that latest version is deleted, which filtering status first would
// get wrong by resurrecting an older version.
const SPP_PREMIUM_QUERY = `
  SELECT v.polid, l.lineofbus, sum(v.premium) AS spp_premium
  FROM (
    SELECT DISTINCT ON (s.polid, s.spsumid) s.polid, s.lobid, s.premium, s.status
    FROM afw_sppsummary s
    WHERE s.polid = ANY($1::uuid[])
    ORDER BY s.polid, s.spsumid, s.entereddate DESC, s.effdate DESC
  ) v
  LEFT JOIN afw_lineofbusiness l ON l.polid = v.polid AND l.lobid = v.lobid
  WHERE v.status <> 'D'
  GROUP BY v.polid, l.lineofbus
`

type Money = string | number | null

type PlRenewalRow = {
  polid: string
  custid: string
  polno: string
  poltypelob: string | null
  poleffdate: string
  polexpdate: string | null
  renewal_premium: Money
  customer_name: string | null
  carrier_name: string | null
  csr_code: string | null
  csr_name: string | null
  downloaded_on: string | null
  synced_at_utc: string | null
  prior_polid: string | null
  prior_polno: string | null
  expiring_premium: Money
}

type LinePremiumRow = { polid: string; lineofbus: string | null; lob_description: string | null; fulltermpremium: Money }
type SppPremiumRow = { polid: string; lineofbus: string | null; spp_premium: Money }

export type PlRenewalChangeLine = PlCalculatorLine & { polno: string }

export type PlRenewalChangeGroup = {
  custid: string
  client_name: string
  renewal_date: string // YYYY-MM-DD effective date
  renewal_date_label: string // M/D/YYYY
  carriers: string
  term: PlCalculatorTerm
  csr_code: string | null
  csr_name: string | null
  polnos: string[]
  lines: PlRenewalChangeLine[]
  // Policies/lines left out of the workbook, and why — never written in as a misleading change.
  excluded: { polno: string; reason: string }[]
}

export type PlRenewalFilters = {
  // Agency-local YYYY-MM-DD bounds on the RWL row's entereddate (end exclusive).
  enteredFrom?: string
  enteredUntil?: string
  // True-UTC ISO instant; only rows first synced after it. Drives the daily script's cursor.
  syncedAfter?: string
  custid?: string
  customerName?: string
  polno?: string
}

export type PlRenewalGroupsResult = {
  groups: PlRenewalChangeGroup[]
  // Latest synced_at among the matched download rows (true UTC ISO), for the daily script to persist.
  maxSyncedAt: string | null
}

// Template row per AMS360 line-of-business code (afw_lineofbusiness.lineofbus); anything else goes
// on a spare row under its own label.
const LOB_BY_CODE: Record<string, PlCalculatorLob> = {
  HOME: "HOME", AUTOP: "AUTO", INMRP: "PA", BOAT: "WATERCRAFT", PUMBR: "UMBRELLA", FLOOD: "FLOOD"
}
const LOB_LABEL: Record<PlCalculatorLob, string> = {
  HOME: "Homeowners", AUTO: "Automobile", PA: "Personal Articles", WATERCRAFT: "Watercraft", UMBRELLA: "Umbrella", FLOOD: "Flood"
}
const SPARE_LABEL: Record<string, string> = { DFIRE: "Dwelling Fire" }
// Only for a term with no premium rows at all — the policy type's single line.
const CODE_BY_POLTYPE: Record<string, string> = {
  "Homeowners": "HOME", "Private Passenger Auto": "AUTOP", "Inland Marine (P)": "INMRP", "Watercraft (small boat)": "BOAT",
  "Umbrella (P)": "PUMBR", "Flood": "FLOOD", "Dwelling Fire": "DFIRE"
}

const round2 = (v: number) => Math.round(v * 100) / 100

function termMonths(eff: string, exp: string | null): number | null {
  if(!exp) return null
  const [ey, em] = eff.slice(0, 7).split("-").map(Number)
  const [xy, xm] = exp.slice(0, 7).split("-").map(Number)
  const months = (xy - ey) * 12 + (xm - em)
  return months > 0 ? months : null
}

function dateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  return `${ m }/${ d }/${ y }`
}

type TermLines = Map<string, { premium: number; description: string | null }>

// One term's premium by line code, with the PA carve-out already applied to HOME (as a synthetic
// "SPP" code). Falls back to the policy-level premium as a single line when the term has no premium
// rows at all (placeholder prior shells), or null when there's nothing usable.
function termLines(polid: string, poltypelob: string | null, policyPremium: Money, lines: LinePremiumRow[], spp: SppPremiumRow[]): TermLines | null {
  const out: TermLines = new Map()

  for(const row of lines.filter((l) => l.polid === polid)) {
    const code = row.lineofbus?.trim() || "OTHER"
    out.set(code, { premium: toNumber(row.fulltermpremium) ?? 0, description: row.lob_description?.trim() || null })
  }

  if(out.size === 0) {
    const premium = toNumber(policyPremium)
    if(!premium) return null
    out.set(CODE_BY_POLTYPE[poltypelob?.trim() ?? ""] ?? "OTHER", { premium, description: poltypelob })
  }

  const home = out.get("HOME")
  const homeSpp = toNumber(spp.find((s) => s.polid === polid && s.lineofbus?.trim() === "HOME")?.spp_premium ?? null) ?? 0
  if(home && homeSpp > 0 && homeSpp <= home.premium) {
    home.premium = round2(home.premium - homeSpp)
    out.set("SPP", { premium: homeSpp, description: "Personal Articles" })
  }

  return out
}

function lineIdentity(code: string, description: string | null): { lob: PlCalculatorLob | null; label: string } {
  if(code === "SPP") return { lob: "PA", label: LOB_LABEL.PA }
  const lob = LOB_BY_CODE[code] ?? null
  return { lob, label: lob ? LOB_LABEL[lob] : SPARE_LABEL[code] ?? description ?? code }
}

function buildGroups(rows: PlRenewalRow[], lines: LinePremiumRow[], spp: SppPremiumRow[]): PlRenewalChangeGroup[] {
  const byKey = new Map<string, PlRenewalRow[]>()
  for(const row of rows) {
    const key = `${ row.custid }|${ row.poleffdate }`
    byKey.set(key, [...(byKey.get(key) ?? []), row])
  }

  const groups: PlRenewalChangeGroup[] = []

  for(const policies of byKey.values()) {
    policies.sort((a, b) => a.polno.localeCompare(b.polno))
    const first = policies[0]
    const groupLines: PlRenewalChangeLine[] = []
    const excluded: PlRenewalChangeGroup["excluded"] = []
    const seenLobs = new Map<string, number>()

    for(const policy of policies) {
      if((toNumber(policy.renewal_premium) ?? 0) < 0 || (toNumber(policy.expiring_premium) ?? 0) < 0) {
        excluded.push({ polno: policy.polno, reason: "Negative premium on file (cancellation/return premium) — change not calculated" })
        continue
      }

      const renewal = termLines(policy.polid, policy.poltypelob, policy.renewal_premium, lines, spp)
      if(!renewal) {
        excluded.push({ polno: policy.polno, reason: "Renewal premium unavailable" })
        continue
      }

      const prior = policy.prior_polid ? termLines(policy.prior_polid, policy.poltypelob, policy.expiring_premium, lines, spp) : null
      if(!prior) {
        excluded.push({ polno: policy.polno, reason: policy.prior_polid ? "Expiring premium unavailable" : "Prior term not found" })
        continue
      }

      // A prior shell recorded as one unsplit line against a multi-line renewal can't be compared
      // line by line.
      const codes = [...new Set([...renewal.keys(), ...prior.keys()])]
      if(prior.size === 1 && renewal.size > 1 && !renewal.has([...prior.keys()][0])) {
        excluded.push({ polno: policy.polno, reason: "Expiring premium isn't broken out by line — compare by hand" })
        continue
      }

      for(const code of codes) {
        const current = prior.get(code)?.premium ?? 0
        const renewed = renewal.get(code)?.premium ?? 0
        if(current === 0 && renewed === 0) continue
        if(current < 0 || renewed < 0) {
          excluded.push({ polno: policy.polno, reason: `Negative ${ code } premium on file — line not included` })
          continue
        }

        const identity = lineIdentity(code, renewal.get(code)?.description ?? prior.get(code)?.description ?? null)
        const key = identity.lob ?? identity.label
        const count = (seenLobs.get(key) ?? 0) + 1
        seenLobs.set(key, count)
        // A second policy of the same line (two homes) gets its own row, told apart by policy number.
        const label = count > 1 ? `${ identity.label } (${ policy.polno })` : identity.label

        groupLines.push({ lob: identity.lob, label, current: round2(current), renewal: round2(renewed), polno: policy.polno })
      }
    }

    const sixMonthAuto = policies.some((p) => termMonths(p.poleffdate, p.polexpdate) === 6
      && groupLines.some((l) => l.polno === p.polno && l.lob === "AUTO"))
    const carriers = [...new Set(policies.map((p) => p.carrier_name?.trim()).filter((c): c is string => Boolean(c)))]

    groups.push({
      custid: first.custid,
      client_name: first.customer_name?.trim() ?? "",
      renewal_date: first.poleffdate,
      renewal_date_label: dateLabel(first.poleffdate),
      carriers: carriers.join(" / ") || "Carrier",
      term: sixMonthAuto ? "six_month" : "annual",
      csr_code: first.csr_code,
      csr_name: first.csr_name,
      polnos: [...new Set(policies.map((p) => p.polno))],
      lines: groupLines,
      excluded
    })
  }

  return groups.sort((a, b) => a.client_name.localeCompare(b.client_name) || a.renewal_date.localeCompare(b.renewal_date))
}

function queryParams(filters: PlRenewalFilters, custids: string[] | null): unknown[] {
  return [
    filters.enteredFrom ?? null,
    filters.enteredUntil ?? null,
    filters.syncedAfter ?? null,
    filters.custid ?? null,
    filters.customerName ?? null,
    filters.polno ?? null,
    custids
  ]
}

// Finds the client/renewal-date groups the filters touch, then re-reads each of those clients'
// renewals with no download-date filter, so a group is always COMPLETE — a home that downloaded last
// week still sits next to the auto that downloaded today.
export async function fetchPlRenewalChangeGroups(filters: PlRenewalFilters): Promise<PlRenewalGroupsResult> {
  const matched = await runReadOnlyQuery(PL_RENEWALS_QUERY, queryParams(filters, null)) as PlRenewalRow[]
  if(matched.length === 0) return { groups: [], maxSyncedAt: null }

  const maxSyncedAt = matched.reduce<string | null>((max, r) => (r.synced_at_utc && (!max || r.synced_at_utc > max) ? r.synced_at_utc : max), null)
  const keys = new Set(matched.map((r) => `${ r.custid }|${ r.poleffdate }`))
  const custids = [...new Set(matched.map((r) => r.custid))]

  const all = (await runReadOnlyQuery(PL_RENEWALS_QUERY, queryParams({}, custids)) as PlRenewalRow[])
    .filter((r) => keys.has(`${ r.custid }|${ r.poleffdate }`))

  const polids = [...new Set(all.flatMap((r) => [r.polid, r.prior_polid]).filter((id): id is string => Boolean(id)))]
  const [lines, spp] = await Promise.all([
    runReadOnlyQuery(LINE_PREMIUM_QUERY, [polids]) as Promise<LinePremiumRow[]>,
    runReadOnlyQuery(SPP_PREMIUM_QUERY, [polids]) as Promise<SppPremiumRow[]>
  ])

  return { groups: buildGroups(all, lines, spp), maxSyncedAt }
}

const DEFAULT_WINDOW_DAYS = 30

// start/end are agency-local YYYY-MM-DD download dates, end inclusive; default is the last 30 days.
export function downloadWindow(startDate?: string, endDate?: string): { enteredFrom: string; enteredUntil?: string } {
  const from = new Date()
  from.setDate(from.getDate() - DEFAULT_WINDOW_DAYS)

  let enteredUntil: string | undefined
  if(endDate) {
    const until = new Date(`${ endDate }T00:00:00Z`)
    until.setUTCDate(until.getUTCDate() + 1)
    enteredUntil = until.toISOString().slice(0, 10)
  }

  return { enteredFrom: startDate ?? from.toISOString().slice(0, 10), enteredUntil }
}
