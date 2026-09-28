import { runReadOnlyQuery } from "../db.js"
import { CUSTOMER_NAME_EXPR } from "./clPolicyData.js"
import { toNumber } from "./renewalPremiumSummaryPolicyValues.js"

// PL Renewal Premium Change (roadmap #11): for every personal-lines renewal a carrier downloads
// (afw_policytransaction trantype='RWL', source='D'), compare the renewal term's premium against the
// term it replaces, and render one tab-delimited line per policy for pasting into an AMS activity
// note. Shared by the pl_renewal_premium_change MCP tool, the dashboard route, and the daily script.
//
// Premium rules below come from a data check against 171 real PL RWL downloads (2026-09-24):
// - Expiring premium = the PRIOR term's bp.fulltermpremium. On 77 of 80 endorsed prior terms it
//   equals the latest tranpremium, i.e. it's the post-endorsement, at-expiration figure, which is the
//   fair like-for-like comparison since the renewal carries those endorsements forward.
// - Renewal premium = the renewal term's bp.fulltermpremium (0 on only 1 of 171).
// - NOT annualizedpremium on either side: it's missing on 134 of 171 prior terms (only populated on
//   download rows since ~Q1 2026) and is truly annualized, so a 6-month auto term reads ~2x.
// - Prior term via priorpolid first (169 of 171). The custid+polno fallback only exists for the rare
//   renewal with no priorpolid (seen on Flood) — polno alone is NOT a safe primary key across terms,
//   24 of 169 changed polno at renewal (e.g. HO252129001 -> HO252129002).
const PL_RENEWALS_QUERY = `
  SELECT DISTINCT ON (bp.polid)
    bp.polno, bp.poltypelob AS line_of_business, bp.poleffdate, bp.polexpdate,
    bp.fulltermpremium AS renewal_premium,
    ${ CUSTOMER_NAME_EXPR } AS customer_name,
    co.name AS carrier_name,
    NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), '') AS csr_name,
    pt.entereddate AS downloaded_on,
    to_char(pt.synced_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS synced_at_utc,
    prior.polno AS prior_polno,
    prior.fulltermpremium AS expiring_premium
  FROM afw_policytransaction pt
  JOIN afw_basicpolinfo bp ON bp.polid = pt.polid
  LEFT JOIN afw_customer c ON c.custid = bp.custid
  LEFT JOIN afw_company co ON co.cocode = bp.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = bp.csrcode
  LEFT JOIN LATERAL (
    SELECT p.polno, p.fulltermpremium
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
    AND ($1::timestamp IS NULL OR pt.entereddate >= $1::timestamp)
    AND ($2::timestamp IS NULL OR pt.entereddate < $2::timestamp)
    AND ($3::timestamp IS NULL OR pt.synced_at > $3::timestamp)
    AND ($4::text IS NULL OR bp.custid::text = $4)
    AND ($5::text IS NULL OR ${ CUSTOMER_NAME_EXPR } ILIKE '%' || $5 || '%')
    AND ($6::text IS NULL OR bp.polno = $6)
  ORDER BY bp.polid, pt.entereddate DESC
`

// Cap on how many renewals one call returns — a normal day is a handful; 30 days is ~170.
const MAX_RENEWALS = 500

type PlRenewalRow = {
  polno: string
  line_of_business: string | null
  poleffdate: string | null
  polexpdate: string | null
  renewal_premium: string | number | null
  customer_name: string | null
  carrier_name: string | null
  csr_name: string | null
  downloaded_on: string | null
  synced_at_utc: string | null
  prior_polno: string | null
  expiring_premium: string | number | null
}

export type PlRenewalPremiumChange = {
  customer_name: string
  policy_no: string
  prior_policy_no: string | null
  carrier: string
  line_of_business: string
  renewal_effective: string
  term_months: number | null
  expiring_premium: number | null
  renewal_premium: number | null
  change_amount: number | null
  change_percent: number | null
  csr_name: string | null
  downloaded_on: string
  // Why change_amount/change_percent are null, when they are — e.g. a Flood renewal whose prior
  // term carries $0 (NFIP-style downloads), so no misleading +∞% is ever printed.
  note: string | null
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

export type PlRenewalResult = {
  renewals: PlRenewalPremiumChange[]
  // Latest synced_at among the rows returned (true UTC ISO), for the daily script to persist.
  maxSyncedAt: string | null
  truncated: boolean
}

function dateOnly(value: string | null): string {
  return value ? value.slice(0, 10) : ""
}

// Whole months between effective and expiration — PL auto is often 6-month, everything else 12.
function termMonths(eff: string | null, exp: string | null): number | null {
  if(!eff || !exp) return null
  const [ey, em] = eff.slice(0, 7).split("-").map(Number)
  const [xy, xm] = exp.slice(0, 7).split("-").map(Number)
  const months = (xy - ey) * 12 + (xm - em)
  return months > 0 ? months : null
}

function toChange(row: PlRenewalRow): PlRenewalPremiumChange {
  const expiring = toNumber(row.expiring_premium)
  const renewal = toNumber(row.renewal_premium)

  let note: string | null = null
  if(!row.prior_polno) note = "Prior term not found"
  else if(!expiring && !renewal) note = "Premiums unavailable"
  else if(!expiring) note = "Expiring premium unavailable"
  else if(!renewal) note = "Renewal premium unavailable"

  const comparable = note === null && expiring !== null && renewal !== null
  const changeAmount = comparable ? Math.round((renewal - expiring) * 100) / 100 : null
  const changePercent = comparable ? Math.round(((renewal - expiring) / expiring) * 1000) / 10 : null

  return {
    customer_name: row.customer_name ?? "",
    policy_no: row.polno,
    prior_policy_no: row.prior_polno,
    carrier: row.carrier_name ?? "",
    line_of_business: row.line_of_business ?? "",
    renewal_effective: dateOnly(row.poleffdate),
    term_months: termMonths(row.poleffdate, row.polexpdate),
    expiring_premium: expiring || null,
    renewal_premium: renewal || null,
    change_amount: changeAmount,
    change_percent: changePercent,
    csr_name: row.csr_name,
    downloaded_on: dateOnly(row.downloaded_on),
    note
  }
}

export async function fetchPlRenewalPremiumChanges(filters: PlRenewalFilters): Promise<PlRenewalResult> {
  const rows = await runReadOnlyQuery(PL_RENEWALS_QUERY, [
    filters.enteredFrom ?? null,
    filters.enteredUntil ?? null,
    filters.syncedAfter ?? null,
    filters.custid ?? null,
    filters.customerName ?? null,
    filters.polno ?? null
  ]) as PlRenewalRow[]

  const maxSyncedAt = rows.reduce<string | null>((max, r) => (r.synced_at_utc && (!max || r.synced_at_utc > max) ? r.synced_at_utc : max), null)
  const renewals = rows
    .map(toChange)
    .sort((a, b) => a.customer_name.localeCompare(b.customer_name) || a.policy_no.localeCompare(b.policy_no))

  return {
    renewals: renewals.slice(0, MAX_RENEWALS),
    maxSyncedAt,
    truncated: renewals.length > MAX_RENEWALS
  }
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

function formatMoney(v: number | null): string {
  return v === null ? "" : `$${ v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }`
}

function formatSignedMoney(v: number | null): string {
  if(v === null) return ""
  return `${ v < 0 ? "-" : v > 0 ? "+" : "" }${ formatMoney(Math.abs(v)) }`
}

function formatPercent(v: number | null): string {
  return v === null ? "" : `${ v > 0 ? "+" : "" }${ v.toFixed(1) }%`
}

// PLACEHOLDER LAYOUT — the real column order for the AMS activity note is still pending from
// Patrick (the working-concept chat he shared is no longer viewable). Change only this array once
// he confirms; every consumer (tool, dashboard route, daily email) renders through it.
const ACTIVITY_LINE_COLUMNS: { header: string; value: (r: PlRenewalPremiumChange) => string }[] = [
  { header: "Client", value: (r) => r.customer_name },
  { header: "Policy #", value: (r) => r.policy_no },
  { header: "Carrier", value: (r) => r.carrier },
  { header: "LOB", value: (r) => r.line_of_business },
  { header: "Renewal Eff", value: (r) => r.renewal_effective },
  { header: "Term", value: (r) => (r.term_months ? `${ r.term_months } mo` : "") },
  { header: "Expiring Premium", value: (r) => formatMoney(r.expiring_premium) },
  { header: "Renewal Premium", value: (r) => formatMoney(r.renewal_premium) },
  { header: "$ Change", value: (r) => formatSignedMoney(r.change_amount) },
  { header: "% Change", value: (r) => r.note ?? formatPercent(r.change_percent) }
]

// Tabs/newlines inside a value would split it across columns when pasted.
function clean(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim()
}

export function activityLineHeader(): string {
  return ACTIVITY_LINE_COLUMNS.map((c) => c.header).join("\t")
}

export function formatActivityLine(row: PlRenewalPremiumChange): string {
  return ACTIVITY_LINE_COLUMNS.map((c) => clean(c.value(row))).join("\t")
}
