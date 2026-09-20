import { publicBaseUrl } from "../config/config.js"
import { runReadOnlyQuery } from "../db.js"
import { archiveRenewalPremiumSummary } from "./renewalPremiumSummaryArchive.js"
import { computeCurrentRenewal } from "./renewalPremiumSummaryPolicyValues.js"
import { fetchPolicyLobInfo } from "./policyLineOfBusiness.js"
import { sanitizeForFilename } from "./riskProfileArchive.js"
import { sendMailWithAttachment } from "./mailer.js"
import { storeDownload } from "./downloadStore.js"
import type { ExtraRow, KnownLobCode, LobRowFill, OtherPolicyRow, PremiumFallbackNote } from "./renewalPremiumSummaryWorkbook.js"
import { LOB_ROW_ORDER, buildRenewalPremiumSummaryWorkbook } from "./renewalPremiumSummaryWorkbook.js"

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

// Placeholder recipient until reports are published to a OneDrive-based file system CSRs browse
// directly instead of being emailed individually (Andrew, 2026-09-16) — send_email is for review in
// the meantime, not a real distribution path, so it never resolves/sends to an actual CSR.
const DEFAULT_TEST_RECIPIENT = "andrew@tyneside.io"

const CUSTOMER_NAME_EXPR = "COALESCE(c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''), c.firmnamecust)"

// Same "genuinely in force today" filter risk_profile/policy_query/upcoming_renewals
// all standardize on. Unlike risk_profile, this always pulls EVERY current commercial
// policy on the account (not just ones matching a polno) — the whole point of this tool is splitting
// that set into "renewing soon" (main table) vs. "everything else" (the account's other current
// policies), per Patrick's own spec (see renewalPremiumSummary.ts's tool description).
//
// Deliberately does NOT filter on renewalrptflag='A' (client-corrected 2026-09-14, Defatta Custom
// Homes LLC — see riskProfile.ts's RESOLVE_POLICY_QUERY comment for the full story):
// AMS360 can flip a term's flag to 'R' the moment its successor is bound, weeks before that successor
// actually starts, so the flag alone can miss the term that's genuinely in force today. The
// poleffdate/polexpdate bounds below already do all the real work of defining "in force."
const ACCOUNT_POLICIES_QUERY = `
  SELECT p.polid, p.polno, p.polexpdate, p.custid, p.csrcode,
    ${ CUSTOMER_NAME_EXPR } AS customer_name,
    co.name AS carrier_name,
    COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), p.csrcode) AS csr_name,
    p.fulltermpremium,
    COALESCE(
      (SELECT MAX(t.entereddate) FROM afw_policytransaction t WHERE t.polid = p.polid),
      p.changeddate
    ) AS premium_as_of,
    lasttxn.annualizedpremium AS last_written_premium,
    successor.fulltermpremium AS successor_fulltermpremium
  FROM afw_basicpolinfo p
  LEFT JOIN afw_customer c ON c.custid = p.custid
  LEFT JOIN afw_company co ON co.cocode = p.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = p.csrcode
  LEFT JOIN LATERAL (
    SELECT t.annualizedpremium
    FROM afw_policytransaction t
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
  ORDER BY p.polexpdate
  LIMIT 30
`

type AccountPolicy = {
  polid: string
  polno: string
  polexpdate: string
  custid: string
  csrcode: string | null
  customer_name: string | null
  carrier_name: string | null
  csr_name: string | null
  fulltermpremium: string | number | null
  premium_as_of: string | null
  last_written_premium: string | number | null
  successor_fulltermpremium: string | number | null
}

function formatDate(value: string | null): string {
  return value ? value.slice(0, 10) : ""
}

export class NoCommercialPoliciesError extends Error {}

export type GenerateRenewalPremiumSummaryParams = {
  custid: string
  renewalWithinDays: number
  // Optional lower bound (YYYY-MM-DD, inclusive) on top of the renewalWithinDays cutoff above — when
  // set, only policies expiring on/after this date land in the main table; everything else (earlier
  // OR later) falls to the "other current policies" table instead. The interactive tool never sets
  // this (renewalWithinDays alone, a rolling window from today, is exactly what it wants). The
  // monthly batch script (scripts/monthlyRenewalPremiumSummaries.ts) does set it, pinned to the
  // target month's first day — without it, renewalWithinDays sized to reach the end of a
  // two-months-out target month would also sweep in that account's own sooner renewals (e.g. next
  // month's) into the same report, which isn't what "generate December's renewal summaries" means.
  windowStartDate?: string
  sendEmail: boolean
  cc?: string[]
  overrideRecipient?: string
}

export type GenerateRenewalPremiumSummaryResult =
  | {
      status: "no_policies_in_window"
      clientName: string
      totalPolicies: number
      soonestRenewalDate: string
      policies: { polno: string; renewal_date: string; carrier_name: string | null }[]
    }
  | {
      status: "generated"
      custid: string
      clientName: string
      includedCount: number
      otherCount: number
      filename: string
      downloadUrl: string
      emailStatus: string
      includedPolicies: { coverage: string; current_premium: number | null; carrier: string }[]
      otherPolicies: OtherPolicyRow[]
    }

// Extracted from the renewal_premium_summary MCP tool (src/tools/policies/renewalPremiumSummary.ts)
// so a batch/cron job can call the exact same build+archive logic directly — no MCP transport, no
// Agent SDK/LLM turn — while the tool itself stays the single interactive entry point that wraps
// this in an MCP result envelope. Keep both callers' behavior identical: any change here changes
// what the interactive tool returns too.
export async function generateRenewalPremiumSummary(params: GenerateRenewalPremiumSummaryParams): Promise<GenerateRenewalPremiumSummaryResult> {
  const { custid, renewalWithinDays, windowStartDate, sendEmail, cc, overrideRecipient } = params

  const policies = await runReadOnlyQuery(ACCOUNT_POLICIES_QUERY, [custid]) as AccountPolicy[]

  if(policies.length === 0) {
    throw new NoCommercialPoliciesError("No current, in-force commercial policies found for this customer. Check custid is correct and the account actually carries commercial lines (typeofbus=2).")
  }

  const clientName = policies[0].customer_name?.trim() || "[NOT PROVIDED — PLEASE CONFIRM]"

  const cutoff = new Date(Date.now() + renewalWithinDays * 24 * 60 * 60 * 1000)
  const windowStart = windowStartDate ? new Date(`${ windowStartDate }T00:00:00Z`) : null
  const isInWindow = (p: AccountPolicy) => {
    const exp = new Date(p.polexpdate)
    return exp <= cutoff && (!windowStart || exp >= windowStart)
  }
  const included = policies.filter(isInWindow)
  const other = policies.filter((p) => !isInWindow(p))

  if(included.length === 0) {
    return {
      status: "no_policies_in_window",
      clientName,
      totalPolicies: policies.length,
      soonestRenewalDate: formatDate(policies[0].polexpdate),
      policies: policies.map((p) => ({ polno: p.polno, renewal_date: formatDate(p.polexpdate), carrier_name: p.carrier_name }))
    }
  }

  const lobInfo = await Promise.all(policies.map((p) => fetchPolicyLobInfo(p.polid)))
  const lobByPolid = new Map(policies.map((p, i) => [p.polid, lobInfo[i]]))

  const lobRows: Partial<Record<KnownLobCode, LobRowFill>> = {}
  const extraRows: ExtraRow[] = []
  const premiumFallbackNotes: PremiumFallbackNote[] = []

  for(const policy of included) {
    const { lobDescriptions, lobCodes } = lobByPolid.get(policy.polid)!
    const primaryCode = LOB_ROW_ORDER.find((code) => lobCodes.includes(code))
    const carrier = policy.carrier_name?.trim() || "—"

    const { current, renewal, usedFallback, fallbackAmount } = computeCurrentRenewal(policy)
    if(usedFallback) premiumFallbackNotes.push({ polno: policy.polno, amount: fallbackAmount! })

    const primaryIdx = primaryCode ? lobCodes.indexOf(primaryCode) : -1
    const orderedDescriptions = primaryIdx > 0
      ? [lobDescriptions[primaryIdx], ...lobDescriptions.filter((_, i) => i !== primaryIdx)]
      : lobDescriptions
    const coverage = orderedDescriptions.length > 0 ? orderedDescriptions.join(", ") : "—"

    if(primaryCode) {
      const existing = lobRows[primaryCode]
      lobRows[primaryCode] = existing
        ? {
            current: existing.current !== null || current !== null ? (existing.current ?? 0) + (current ?? 0) : null,
            renewal: existing.renewal !== null || renewal !== null ? (existing.renewal ?? 0) + (renewal ?? 0) : null,
            carrier: existing.carrier.split("; ").includes(carrier) ? existing.carrier : `${ existing.carrier }; ${ carrier }`,
            coverage: existing.coverage.split("; ").includes(coverage) ? existing.coverage : `${ existing.coverage }; ${ coverage }`,
            policyNos: existing.policyNos.split(", ").includes(policy.polno) ? existing.policyNos : `${ existing.policyNos }, ${ policy.polno }`
          }
        : { current, renewal, carrier, coverage, policyNos: policy.polno }
    } else {
      extraRows.push({ coverage, policyNos: policy.polno, current, renewal, carrier })
    }
  }

  const otherPolicies: OtherPolicyRow[] = other.map((policy) => {
    const { classification } = lobByPolid.get(policy.polid)!
    return {
      coveragePolicy: `${ policy.polno } — ${ classification || "Policy" } (${ policy.carrier_name?.trim() || "—" })`,
      expirationDate: formatDate(policy.polexpdate)
    }
  })

  const renewalDates = [...new Set(included.map((p) => formatDate(p.polexpdate)))]
  const renewalDateLabel = renewalDates.length === 1 ? renewalDates[0] : `${ renewalDates[0] } – ${ renewalDates[renewalDates.length - 1] }`

  const premiumAsOfNotes = included
    .map((p) => ({ polno: p.polno, date: formatDate(p.premium_as_of) }))
    .filter((n) => n.date)

  const { buffer, cellMap } = await buildRenewalPremiumSummaryWorkbook({ clientName, renewalDateLabel, lobRows, extraRows, otherPolicies, premiumAsOfNotes, premiumFallbackNotes })

  const filename = `${ clientName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Unknown" }_Renewal_Premium_Summary.xlsx`
  const token = storeDownload(buffer, filename, XLSX_MIME_TYPE)
  const downloadUrl = `${ publicBaseUrl }/downloads/${ token }`

  const earliestRenewalDate = included.reduce((earliest, p) => (p.polexpdate < earliest ? p.polexpdate : earliest), included[0].polexpdate)

  archiveRenewalPremiumSummary(buffer, {
    filename: `${ sanitizeForFilename(clientName) }_${ custid }.xlsx`,
    generated_at: new Date().toISOString(),
    custid,
    csr_code: included[0].csrcode,
    csr_name: included[0].csr_name,
    client_name: clientName,
    polnos: included.map((p) => p.polno).join(", "),
    renewal_date: formatDate(earliestRenewalDate),
    renewal_date_label: renewalDateLabel,
    cell_map: cellMap
  })

  let emailStatus = "Not sent (send_email=false)."

  if(sendEmail) {
    const recipient = overrideRecipient ?? DEFAULT_TEST_RECIPIENT

    await sendMailWithAttachment({
      to: cc && cc.length > 0 ? [recipient, ...cc] : recipient,
      subject: `Boxwood Renewal Premium Summary — ${ clientName }`,
      text: `Attached is the Renewal Premium Summary for ${ clientName } (${ included.length } polic${ included.length === 1 ? "y" : "ies" } renewing within ${ renewalWithinDays } days).`,
      attachment: { filename, content: buffer, contentType: XLSX_MIME_TYPE }
    })
    emailStatus = `Emailed to ${ recipient } (test recipient — no per-CSR send).`
  }

  return {
    status: "generated",
    custid,
    clientName,
    includedCount: included.length,
    otherCount: other.length,
    filename,
    downloadUrl,
    emailStatus,
    includedPolicies: [
      ...Object.entries(lobRows).map(([code, r]) => ({ coverage: code, current_premium: r!.current, carrier: r!.carrier })),
      ...extraRows.map((r) => ({ coverage: r.coverage, current_premium: r.current, carrier: r.carrier }))
    ],
    otherPolicies
  }
}
