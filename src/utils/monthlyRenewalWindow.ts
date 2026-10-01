import { runReadOnlyQuery } from "../db.js"

// Shared by the monthly CL batch scripts (scripts/monthlyRenewalPremiumSummaries.ts,
// scripts/monthlyRiskProfiles.ts) — Patrick, 2026-09-15: both run on the 1st of the month for every
// account renewing two calendar months out ("Oct 1 should create these for all accounts renewing in
// December"), so both must agree on the target month and on which accounts it covers.

// Mirrors the commercial "genuinely in force" filter used by both generateRenewalPremiumSummary's
// ACCOUNT_POLICIES_QUERY and clPolicyData's RESOLVE_POLICY_QUERY (typeofbus=2, polsubtype!='S',
// status!='D', poleffdate<=now()) exactly, so every custid this discovers actually produces a
// document — deliberately NOT upcoming_renewals' filter (renewalrptflag='A' + not-yet-renewed),
// which answers a different question. DISTINCT because an account can have more than one
// commercial policy expiring in the same target month.
const DISCOVERY_QUERY = `
  SELECT DISTINCT p.custid,
    COALESCE(c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''), c.firmnamecust) AS customer_name
  FROM afw_basicpolinfo p
  LEFT JOIN afw_customer c ON c.custid = p.custid
  WHERE p.typeofbus = 2
    AND p.polsubtype != 'S'
    AND p.status != 'D'
    AND p.poleffdate <= now()
    AND p.polexpdate BETWEEN $1::date AND $2::date
  ORDER BY customer_name
`

export type DiscoveredAccount = { custid: string; customer_name: string | null }

export type TargetMonthWindow = {
  startDate: string
  endDate: string
  // Sized so every renewal through the end of the target month falls inside a "renewing within N
  // days from today" window — the generators' own windows are relative to today, not the month.
  renewalWithinDays: number
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// current month + 2, with year rollover (e.g. run in November → target January of next year).
// monthArg (YYYY-MM) overrides it for manual/backtesting runs.
function resolveTargetMonth(monthArg: string | undefined): { year: number; month: number } {
  if(monthArg) {
    const match = monthArg.match(/^(\d{4})-(\d{2})$/)
    if(!match) throw new Error(`--month must be YYYY-MM, got "${ monthArg }"`)
    return { year: Number(match[1]), month: Number(match[2]) - 1 }
  }

  const now = new Date()
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1))
  return { year: target.getUTCFullYear(), month: target.getUTCMonth() }
}

// +1 day of buffer against any time-of-day component on polexpdate so the last day of the month is
// never clipped by the cutoff comparison.
function renewalWithinDaysThrough(endDate: string): number {
  const now = new Date()
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const endUtc = new Date(`${ endDate }T00:00:00Z`).getTime()
  return Math.max(1, Math.ceil((endUtc - todayUtc) / (24 * 60 * 60 * 1000)) + 1)
}

export function resolveTargetMonthWindow(monthArg: string | undefined): TargetMonthWindow {
  const { year, month } = resolveTargetMonth(monthArg)
  const startDate = toDateString(new Date(Date.UTC(year, month, 1)))
  const endDate = toDateString(new Date(Date.UTC(year, month + 1, 0))) // day 0 of next month = last day of this one
  return { startDate, endDate, renewalWithinDays: renewalWithinDaysThrough(endDate) }
}

export function monthArgFromArgv(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith("--month="))?.split("=")[1]
}

// Also used by scripts/dailyClRenewalSummaries.ts with its rolling window instead of a month.
export async function discoverCommercialAccounts({ startDate, endDate }: { startDate: string; endDate: string }): Promise<DiscoveredAccount[]> {
  return await runReadOnlyQuery(DISCOVERY_QUERY, [startDate, endDate]) as DiscoveredAccount[]
}
