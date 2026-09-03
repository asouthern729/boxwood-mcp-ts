import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../config/config.js"
import { runReadOnlyQuery } from "../db.js"
import { categorizeTransaction, claimNextStep } from "../utils/downloadCategorization.js"
import { storeDownload } from "../utils/downloadStore.js"
import { systemEmployeeCondition } from "../utils/employeeClassification.js"
import { agencyWallClockParts, bindableAgencyDate, formatTimestampColumn, mostRecentAgencySyncWindow } from "../utils/localTime.js"
import { logger } from "../utils/logger.js"
import { errorResult, groupByKey, textResult } from "../utils/mcpHelpers.js"

const REPORT_JSON_MIME_TYPE = "application/json"

const RELATIVE_PATTERN = /^(\d+)(h|d)$/i
const ABSOLUTE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/

// afw_policytransaction.description on a source='D' row is usually "DNLD/<action>" (confirmed
// against live data) — that prefix is AMS360's own download-processing marker, not part of the
// actual action a rep needs to read, so it's stripped for the report's Detail column. Not every
// source='D' row actually carries it though (confirmed a handful of plain-text exceptions), so
// this only strips when present rather than assuming it.
function stripDownloadPrefix(description: string): string {
  return description.replace(/^DNLD\//i, "").trim()
}

// afw_transaction.commenttran on a real download-processing row is AMS360's own raw processing-log
// text, not client-facing content as-is — confirmed against real data it always leads with an
// AMS360-internal "Msg Date: ... Msg Seq#: ... TranSeq#: ..." header line, then one or more
// "   *** <narrative>" bullet lines padded to a fixed width. The header line and the generic
// "A current policy has been updated by a more current downloaded transaction." boilerplate (present
// on nearly every row here, since it's literally why this row has no afw_policytransaction match —
// see MISSING_DOWNLOAD_TRANSACTION_QUERY) are dropped; the remaining bullets are real content
// (confirmed real examples: "Download updated the writing company from Hartford Property & Casualty
// to Hartford Insurance Group", "GOOD STUDENT DISCOUNT ADDED" per vehicle, insured address changes)
// and kept as this item's detail.
const MISSING_DOWNLOAD_BOILERPLATE = "A current policy has been updated by a more current downloaded transaction."

function formatMissingDownloadDetail(commenttran: string | null): string {
  const lines = (commenttran ?? "")
    .split("\n")
    // AMS360 pads these bullets to a fixed column width with runs of spaces — collapsed here since
    // they're a formatting artifact, not meaningful content.
    .map((line) => line.replace(/^\s*\*\*\*\s?/, "").replace(/ {2,}/g, " ").trim())
    .filter((line) => line.length > 0 && !line.startsWith("Msg Date:") && line !== MISSING_DOWNLOAD_BOILERPLATE)

  return lines.length > 0 ? lines.join(" ") : "Carrier download landed with no other detail recorded in AMS360's processing log — review directly in AMS360."
}

// For a commercial/business customer, lastname/firstname/dba are often all null — firmnamecust
// carries the business name in that case (same fallback customer_lookup already documents/uses).
const CUSTOMER_NAME_EXPR = "COALESCE(c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''), c.firmnamecust)"
const REP_NAME_EXPR = "COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), c.csrcode)"

// afw_policytransaction/afw_claim store naive local wall-clock timestamps (see src/utils/localTime.ts),
// so a `since`/`until` bind value has to be built from the *intended* agency-local wall-clock digits,
// not a true UTC instant — activity_feed's since/until binds a true instant directly against these
// same columns, a known ~5-6 hour boundary bug (see the activity skill). For a report specifically
// about "overnight," getting this edge right matters, so this parses input independently rather than
// reusing resolveSince/resolveUntil.
function resolveWindowBound(value: string | undefined, fallback: () => Date): Date {
  if(!value) return fallback()

  const relative = value.match(RELATIVE_PATTERN)

  if(relative) {
    const amount = Number(relative[1])
    const unitMs = relative[2].toLowerCase() === "h" ? 3_600_000 : 86_400_000

    return bindableAgencyDate(agencyWallClockParts(new Date(Date.now() - amount * unitMs)))
  }

  const absolute = value.match(ABSOLUTE_PATTERN)

  if(!absolute) {
    throw new Error(`Invalid time value: "${ value }" — expected an ISO-ish agency-local timestamp ("2026-08-28T08:00"), or relative shorthand like "24h"/"7d"`)
  }

  const [, year, month, day, hour, minute, second] = absolute

  return bindableAgencyDate({
    year: Number(year), month: Number(month), day: Number(day),
    hour: hour ? Number(hour) : 0, minute: minute ? Number(minute) : 0, second: second ? Number(second) : 0
  })
}

const POLICY_TRANSACTION_QUERY = `
  SELECT
    pt.trantype, pt.description, pt.effdate, pt.changeddate, pt.polid,
    bp.polno AS policy_no, bp.poltypelob AS line_of_business,
    co.name AS carrier_name,
    c.csrcode, ${ REP_NAME_EXPR } AS rep_name,
    ${ CUSTOMER_NAME_EXPR } AS customer_name
  FROM afw_policytransaction pt
  JOIN afw_basicpolinfo bp ON bp.polid = pt.polid
  LEFT JOIN afw_customer c ON c.custid = bp.custid
  LEFT JOIN afw_company co ON co.cocode = bp.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = c.csrcode
  WHERE pt.source = 'D'
    AND pt.changeddate BETWEEN $1 AND $2
    AND ($3::text IS NULL OR c.csrcode = $3)
  ORDER BY c.csrcode NULLS LAST, customer_name, pt.effdate
`

const CLAIM_QUERY = `
  SELECT
    cl.claimno, cl.claimstatus, cl.causeofloss, cl.descriptioncl, cl.closeddate, cl.lossdate, cl.changeddate,
    bp.polno AS policy_no, bp.poltypelob AS line_of_business,
    co.name AS carrier_name,
    c.csrcode, ${ REP_NAME_EXPR } AS rep_name,
    ${ CUSTOMER_NAME_EXPR } AS customer_name
  FROM afw_claim cl
  JOIN afw_basicpolinfo bp ON bp.polid = cl.polid
  LEFT JOIN afw_customer c ON c.custid = bp.custid
  LEFT JOIN afw_company co ON co.cocode = bp.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = c.csrcode
  WHERE cl.changeddate BETWEEN $1 AND $2
    AND ($3::text IS NULL OR c.csrcode = $3)
    AND EXISTS (
      SELECT 1 FROM afw_employee e
      WHERE e.empcode = cl.changedby AND ${ systemEmployeeCondition("e") }
    )
  ORDER BY c.csrcode NULLS LAST, customer_name, cl.changeddate
`

// afw_policytransaction is a "latest value wins" table keyed on (polid, effdate) — confirmed
// against real data that when two carrier downloads land on that same key close together (the same
// effdate-nudging behavior clusterRepeats already works around), only the later one survives as its
// own row there. The earlier one's business content never shows up in POLICY_TRANSACTION_QUERY —
// AMS360's own afw_transaction.commenttran says why, on nearly every one of these rows: "*** A
// current policy has been updated by a more current downloaded transaction." Client-requested
// 2026-09-03 ("if a new row is inserted into afw_transaction by a carrier download we want to see
// that tx ... even if there is no policy change detected") after noticing these were invisible.
//
// `dbaction = 'Download'` is AMS360's own analog to afw_policytransaction.source='D' for this table,
// but it's overloaded — confirmed against real data it also fires for a staff member pulling a file
// via AMS360 Mobile (e.g. "AMS360 Mobile - File downloaded: Email.MSG."), which has nothing to do
// with carrier downloads; every one of those has `polid IS NULL`, so excluding null-polid rows
// cleanly removes them without a fragile text match on commenttran.
//
// The NOT EXISTS reuses REPEAT_GAP_MS's 10-minute tolerance (see clusterRepeats) rather than exact
// equality — an exact-effdate join would false-positive on rows that DO have a real
// afw_policytransaction match, just at a nudged effdate a second or two apart, undercounting real
// correspondence. Confirmed against real data this narrows a naive exact-match gap of ~5,500 rows
// down to the true ~54 genuinely-missing ones once the nudge is accounted for.
const MISSING_DOWNLOAD_TRANSACTION_QUERY = `
  SELECT
    tr.trantype, tr.commenttran, tr.effdate, tr.changeddate, tr.polid,
    bp.polno AS policy_no, bp.poltypelob AS line_of_business,
    co.name AS carrier_name,
    c.csrcode, ${ REP_NAME_EXPR } AS rep_name,
    ${ CUSTOMER_NAME_EXPR } AS customer_name
  FROM afw_transaction tr
  JOIN afw_basicpolinfo bp ON bp.polid = tr.polid
  LEFT JOIN afw_customer c ON c.custid = bp.custid
  LEFT JOIN afw_company co ON co.cocode = bp.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = c.csrcode
  WHERE tr.dbaction = 'Download'
    AND tr.polid IS NOT NULL
    AND tr.changeddate BETWEEN $1 AND $2
    AND ($3::text IS NULL OR c.csrcode = $3)
    AND NOT EXISTS (
      SELECT 1 FROM afw_policytransaction pt
      WHERE pt.polid = tr.polid AND pt.source = 'D'
        AND pt.effdate BETWEEN tr.effdate - interval '10 minutes' AND tr.effdate + interval '10 minutes'
    )
  ORDER BY c.csrcode NULLS LAST, customer_name, tr.effdate
`

type MissingDownloadTransactionRow = {
  trantype: string
  commenttran: string | null
  effdate: string
  changeddate: string
  polid: string
  policy_no: string
  line_of_business: string | null
  carrier_name: string | null
  csrcode: string | null
  rep_name: string | null
  customer_name: string | null
}

// Candidate prior staff activity for flagged items, batched across every flagged polid in one
// query rather than one query per item. Bounded to the widest window any flagged item could need
// (earliest possible lookback start through the report window's own upper bound); each item then
// filters/caps its own slice client-side against its own changeddate, since "prior" is relative to
// when that specific transaction downloaded, not a single report-wide cutoff.
const CANDIDATE_ACTIVITY_QUERY = `
  SELECT tr.polid, tr.changeddate, tr.commenttran
  FROM afw_transaction tr
  WHERE tr.polid = ANY($1::uuid[])
    AND tr.changeddate BETWEEN $2 AND $3
    AND EXISTS (
      SELECT 1 FROM afw_employee e
      WHERE e.empcode = tr.changedby AND NOT ${ systemEmployeeCondition("e") }
    )
  ORDER BY tr.polid, tr.changeddate DESC
`

const CANDIDATE_LIMIT_PER_ITEM = 5

// Vehicle-detail tables (afw_vehicle for Personal Auto, afw_127vehicle for Commercial Auto) carry
// a full Add/Change/Delete audit history keyed by (polid, lobid, veh(d)id, effdate) — confirmed
// against real data that a vehicle add/replace/delete transaction's own effdate lines up with the
// corresponding vehicle row(s)' effdate exactly, or within a few seconds when AMS360 batches
// several vehicle changes into one download event (the same effdate-nudging behavior
// clusterRepeats already works around) — REPEAT_GAP_MS is reused below as the same, already-
// vetted tolerance for that jitter, rather than inventing a new threshold.
//
// A fixed backward-looking window alone isn't enough, though: confirmed against real data that two
// genuinely separate transactions on the same policy can land just 1-2 seconds apart (e.g. "Add
// 2018 Lexus" at :01 immediately followed by an unrelated "Add 2017 Ford" at :03) — a naive window
// join would attribute the Lexus's vehicle-audit rows to BOTH transactions. The `NOT EXISTS`
// clause below excludes a (transaction, vehicle-row) match whenever a *closer* transaction on the
// same policy (among this same batch) also covers that vehicle row's effdate, so each vehicle
// change is attributed to exactly one transaction — the nearest one at or after it — never double-
// counted across neighboring transactions.
const VEHICLE_CHANGE_QUERY = `
  WITH txns AS (
    SELECT * FROM UNNEST($1::int[], $2::uuid[], $3::timestamp[], $4::timestamp[]) AS t(idx, polid, lower_bound, upper_bound)
  ), matches AS (
    SELECT txns.idx, txns.polid, txns.upper_bound, v.effdate, v.status, v.vin, v.make, v.model, v.vehyear
    FROM txns
    JOIN afw_vehicle v ON v.polid = txns.polid AND v.effdate BETWEEN txns.lower_bound AND txns.upper_bound
    UNION ALL
    SELECT txns.idx, txns.polid, txns.upper_bound, v.effdate, v.status, v.vin, v.make, v.model, v.vehyear
    FROM txns
    JOIN afw_127vehicle v ON v.polid = txns.polid AND v.effdate BETWEEN txns.lower_bound AND txns.upper_bound
  )
  SELECT m.idx, m.status, m.vin, m.make, m.model, m.vehyear
  FROM matches m
  WHERE NOT EXISTS (
    SELECT 1 FROM txns t2
    WHERE t2.polid = m.polid AND t2.upper_bound < m.upper_bound AND t2.upper_bound >= m.effdate
  )
`

type VehicleChangeRow = { idx: number; status: string; vin: string | null; make: string | null; model: string | null; vehyear: string | null }

// afw_coverage is the LOB-agnostic analog of afw_vehicle — every line of business (property, GL,
// umbrella, auto's own liability/physical-damage coverages, ...) writes its coverage/limit/
// deductible detail here, keyed by (polid, lobid, coverageid, effdate), same audit-history shape as
// afw_vehicle. Confirmed against real data it's NOT a per-field diff log though: AMS360 rewrites
// *every* currently-active coverage row (same coverageid, unchanged values included) at any
// coverageid's effdate, not just the one(s) that actually changed — so naively reporting every
// coverage row in a transaction's window would report the entire coverage list as "changed" on
// every single download. The LATERAL join below fetches each matched row's own immediately-prior
// state (same coverageid, latest effdate strictly before this row's) so only a genuine value diff on
// limit1-3/deduct1-3 is reported — confirmed against a real "DNLD/cvg chngs - inspection" transaction
// this way surfaces exactly the 3 fields that actually moved (Dwelling/Other Structures/Personal
// Property limits) out of 96 coverage rows in its window.
//
// Added/removed coverages use AMS360's own status='A'/'D' rather than the diff (a brand-new
// coverageid has no prior row to diff against; the same NOT EXISTS attribution pattern as
// VEHICLE_CHANGE_QUERY applies here too, for the same closely-spaced-transactions reason). Both A/D
// rows and diffed C rows are filtered to ones carrying an actual limit/deductible value — confirmed
// against real data that afw_coverage also holds premium-breakdown/administrative rows with no
// limit or deductible at all (e.g. "Fire Peril Premium", "Multi policy credit") that get added/
// removed as a side effect of any coverage rewrite; `iscoverage` looked like the natural filter for
// this but is inconsistent (the same coveragecode shows up as both 'Y' and 'N' on different rows),
// so filtering on "has a limit or deductible value" is what's actually reliable.
const COVERAGE_CHANGE_QUERY = `
  WITH txns AS (
    SELECT * FROM UNNEST($1::int[], $2::uuid[], $3::timestamp[], $4::timestamp[]) AS t(idx, polid, lower_bound, upper_bound)
  ), matches AS (
    SELECT txns.idx, txns.polid, txns.upper_bound, cov.coverageid, cov.effdate, cov.status,
      COALESCE(cov.descrcov, cov.coveragecode) AS coverage_name,
      cov.limit1, cov.limit2, cov.limit3, cov.deduct1, cov.deduct2, cov.deduct3
    FROM txns
    JOIN afw_coverage cov ON cov.polid = txns.polid AND cov.effdate BETWEEN txns.lower_bound AND txns.upper_bound
  ), attributed AS (
    SELECT m.* FROM matches m
    WHERE NOT EXISTS (
      SELECT 1 FROM txns t2
      WHERE t2.polid = m.polid AND t2.upper_bound < m.upper_bound AND t2.upper_bound >= m.effdate
    )
  )
  SELECT a.idx, a.status, a.coverage_name, a.limit1, a.limit2, a.limit3, a.deduct1, a.deduct2, a.deduct3,
    p.limit1 AS prev_limit1, p.limit2 AS prev_limit2, p.limit3 AS prev_limit3,
    p.deduct1 AS prev_deduct1, p.deduct2 AS prev_deduct2, p.deduct3 AS prev_deduct3
  FROM attributed a
  LEFT JOIN LATERAL (
    SELECT c2.limit1, c2.limit2, c2.limit3, c2.deduct1, c2.deduct2, c2.deduct3
    FROM afw_coverage c2
    WHERE c2.polid = a.polid AND c2.coverageid = a.coverageid AND c2.effdate < a.effdate
    ORDER BY c2.effdate DESC LIMIT 1
  ) p ON true
  WHERE (
    a.status IN ('A', 'D')
    AND (a.limit1 IS NOT NULL OR a.limit2 IS NOT NULL OR a.limit3 IS NOT NULL
      OR a.deduct1 IS NOT NULL OR a.deduct2 IS NOT NULL OR a.deduct3 IS NOT NULL)
  ) OR (
    a.limit1 IS DISTINCT FROM p.limit1 OR a.limit2 IS DISTINCT FROM p.limit2 OR a.limit3 IS DISTINCT FROM p.limit3
    OR a.deduct1 IS DISTINCT FROM p.deduct1 OR a.deduct2 IS DISTINCT FROM p.deduct2 OR a.deduct3 IS DISTINCT FROM p.deduct3
  )
`

type CoverageChangeRow = {
  idx: number
  status: string
  coverage_name: string
  limit1: number | null; limit2: number | null; limit3: number | null
  deduct1: number | null; deduct2: number | null; deduct3: number | null
  prev_limit1: number | null; prev_limit2: number | null; prev_limit3: number | null
  prev_deduct1: number | null; prev_deduct2: number | null; prev_deduct3: number | null
}

function formatMoney(value: number | null): string {
  return value === null ? "" : `$${ value.toLocaleString("en-US") }`
}

const MAX_REPORTED_COVERAGE_CHANGES = 6

// Mirrors summarizeVehicleChanges' "surface concrete specifics, cap the noise" shape, but each
// afw_coverage row can independently move more than one field (e.g. both limit1 and deduct1 in the
// same download), so this reports per-field rather than per-row.
function summarizeCoverageChanges(rows: CoverageChangeRow[]): string | null {
  if(rows.length === 0) return null

  const lines: string[] = []

  for(const row of rows) {
    if(row.status === "A") {
      lines.push(`Added coverage: ${ row.coverage_name }${ row.limit1 !== null ? ` (${ formatMoney(row.limit1) })` : "" }`)
      continue
    }

    if(row.status === "D") {
      lines.push(`Removed coverage: ${ row.coverage_name }${ row.limit1 !== null ? ` (${ formatMoney(row.limit1) })` : "" }`)
      continue
    }

    const fields: { label: string; current: number | null; prev: number | null }[] = [
      { label: "limit", current: row.limit1, prev: row.prev_limit1 },
      { label: "limit (2)", current: row.limit2, prev: row.prev_limit2 },
      { label: "limit (3)", current: row.limit3, prev: row.prev_limit3 },
      { label: "deductible", current: row.deduct1, prev: row.prev_deduct1 },
      { label: "deductible (2)", current: row.deduct2, prev: row.prev_deduct2 },
      { label: "deductible (3)", current: row.deduct3, prev: row.prev_deduct3 }
    ]

    for(const field of fields) {
      if(field.current === field.prev) continue
      lines.push(`${ row.coverage_name } ${ field.label }: ${ formatMoney(field.prev) || "none" } → ${ formatMoney(field.current) || "none" }`)
    }
  }

  if(lines.length === 0) return null

  return lines.length > MAX_REPORTED_COVERAGE_CHANGES
    ? `${ lines.length } coverage changes — too many to list here, review the coverage schedule directly in AMS360`
    : lines.join("; ")
}

// A single real-world vehicle add/replace/delete can leave more than one audit row behind for the
// *same* vin within one transaction's window — confirmed against real data: an "Add" is very often
// immediately followed by a same-second "Change" row for that identical vehicle (an AMS360
// processing artifact, not a second real event). Collapsing by vin and preferring Added/Removed
// over a bare Change avoids reporting that artifact as its own line. A vin with only Change rows in
// its window (also confirmed real — e.g. a sibling vehicle silently renumbered when another vehicle
// on the same policy was added/removed) is dropped entirely rather than surfaced as "Updated": there's
// no reliable way to tell that apart from real field-level edits without diffing every column, and
// the client's ask was specifically about vehicles being added/removed, not renumbered.
function summarizeVehicleChanges(rows: Omit<VehicleChangeRow, "idx">[]): string | null {
  if(rows.length === 0) return null

  const byVin = new Map<string, Omit<VehicleChangeRow, "idx">[]>()

  for(const row of rows) {
    const key = row.vin ?? `${ row.make }|${ row.model }|${ row.vehyear }`
    const group = byVin.get(key)

    if(group) group.push(row)
    else byVin.set(key, [row])
  }

  const lines: string[] = []

  for(const group of byVin.values()) {
    const added = group.find((r) => r.status === "A")
    const removed = group.find((r) => r.status === "D")

    if(!added && !removed) continue

    const winner = (added ?? removed)!
    const action = added ? "Added" : "Removed"
    const vehicleLabel = [winner.vehyear, winner.make, winner.model].filter(Boolean).join(" ")

    lines.push(`${ action }: ${ vehicleLabel || "vehicle" }${ winner.vin ? ` (VIN ${ winner.vin })` : "" }`)
  }

  if(lines.length === 0) return null

  // A real single client-driven change (a swap, an add, an occasional 2-4 vehicle fleet update)
  // never touches more than a handful of vehicles at once — confirmed against real data that a
  // double-digit count here means the correlation window caught a bulk vehicle-schedule reload
  // (e.g. an old AMS360-internal reprocessing event that only touched the parent transaction row's
  // changeddate, not a same-night change) rather than anything from this specific transaction. A
  // wall of dozens of VINs would also just be useless in a report cell either way, so this is
  // reported as a count instead of listed out.
  const MAX_REPORTED_VEHICLES = 6

  return lines.length > MAX_REPORTED_VEHICLES
    ? `${ lines.length } vehicles added/removed — too many to list here, review the vehicle schedule directly in AMS360`
    : lines.join("; ")
}

type PolicyTransactionRow = {
  trantype: string
  description: string
  effdate: string
  changeddate: string
  polid: string
  policy_no: string
  line_of_business: string | null
  carrier_name: string | null
  csrcode: string | null
  rep_name: string | null
  customer_name: string | null
  // Set only for a row synthesized from MISSING_DOWNLOAD_TRANSACTION_QUERY (afw_transaction, not
  // afw_policytransaction) — lets the item-building step add a note explaining why this item has no
  // backing policy-transaction record, without a second parallel code path through clusterRepeats/
  // foldStaleReplays/the vehicle-coverage change_detail correlation, all of which apply just as well
  // to these rows since they carry a real polid/effdate too.
  missingRecord?: boolean
}

type ClaimRow = {
  claimno: string | null
  claimstatus: string
  causeofloss: string
  descriptioncl: string | null
  closeddate: string | null
  lossdate: string
  changeddate: string
  policy_no: string
  line_of_business: string | null
  carrier_name: string | null
  csrcode: string | null
  rep_name: string | null
  customer_name: string | null
}

type CandidateActivityRow = { polid: string; changeddate: string; commenttran: string | null }

export type ReportItem = {
  item_id: number
  customer_name: string | null
  policy_no: string
  carrier_name: string | null
  line_of_business: string | null
  domain: "policy_transaction" | "claim"
  what_happened: string
  effective_date: string | null
  detail: string | null
  change_detail: string | null
  next_step: string
  flagged: boolean
  repeat_count?: number
  stale_replay_count?: number
  missing_transaction_record?: boolean
  candidate_prior_activity?: { date: string; note: string }[]
}

// AMS360's download processor sometimes re-writes the exact same transaction several times in one
// batch instead of once, nudging effdate by ~1s per repeat to dodge afw_policytransaction's
// (polid, effdate) primary key — confirmed systemic via manual research (~7% of source='D' rows,
// 597 policies, 19 carriers, every year since 2021, still ongoing). Cluster on (polid, trantype,
// description) with a gap threshold rather than a calendar-day cutoff, since a repeat run can
// straddle midnight; 10 minutes comfortably covers the worst observed real case (350 rows / ~6
// minutes) while still splitting genuinely distinct same-day repeats (a rare real second request)
// apart. Two rows this close together is common enough (78% of all clusters, per that research) to
// be unremarkable — an immediate one-time follow-up isn't inherently suspicious — so only 3+ is
// surfaced to the rep as a repeat_count worth a second look; 2 still merges into one item, quietly.
const REPEAT_GAP_MS = 10 * 60_000
const MIN_REPORTED_REPEAT_COUNT = 3

function clusterRepeats(rows: PolicyTransactionRow[]): { row: PolicyTransactionRow; repeatCount: number }[] {
  const groups = new Map<string, PolicyTransactionRow[]>()

  for(const row of rows) {
    const key = `${ row.polid }||${ row.trantype }||${ row.description }`
    const group = groups.get(key)

    if(group) group.push(row)
    else groups.set(key, [row])
  }

  const clusters: { row: PolicyTransactionRow; repeatCount: number }[] = []

  for(const group of groups.values()) {
    const sorted = [...group].sort((a, b) => new Date(a.effdate).getTime() - new Date(b.effdate).getTime())
    let clusterStart = 0

    for(let i = 1; i <= sorted.length; i++) {
      const gap = i < sorted.length
        ? new Date(sorted[i].effdate).getTime() - new Date(sorted[i - 1].effdate).getTime()
        : Infinity

      if(gap > REPEAT_GAP_MS) {
        clusters.push({ row: sorted[clusterStart], repeatCount: i - clusterStart })
        clusterStart = i
      }
    }
  }

  return clusters
}

// A second, distinct AMS360-side glitch from clusterRepeats' exact-duplicate rewrite, discovered
// from client feedback (2026-09-03: "it looks like it's pulling ALL the changes for that policy
// throughout the policy year — not just what came through overnight") and confirmed against real
// data: when a policy's term closes out (a renewal/rewrite/new-business event downloads), AMS360
// re-stamps `changeddate` — the field this report's WHERE clause uses to decide "did this come down
// overnight" — on every OTHER transaction from that closing term's history too, not just the actual
// new event. Confirmed via 1,001+ real (polid, changeddate) batches where a single download event
// carries multiple differently-described transactions (up to 24 in one batch) whose own `effdate`
// values are spread across nearly the whole prior year; a histogram of (changeddate - effdate)
// across ~12k real policy-change rows shows the expected smooth decay for legitimately late-
// processed changes (0-100 days) plus a distinct anomalous spike right at the 1-year mark — the
// renewal-replay artifact layered on top. Left alone, every one of these stale replayed
// transactions gets reported and flagged as if fresh, and checked against only the last
// `lookback_days` of staff notes (default 60) — which can't find the real conversation from months
// ago — producing exactly the "why is this flagged, nothing matches" confusion the client reported.
//
// Fix mirrors clusterRepeats' own "collapse quietly, note count on survivor" shape rather than
// dropping data: within a batch (same polid + exact changeddate — batches share changeddate down to
// the millisecond, confirmed against real data, unlike clusterRepeats' effdate-nudged duplicates),
// the row with the smallest changeddate-minus-effdate gap is treated as the batch's own anchor (most
// likely the genuinely fresh event, or at least the least-stale one). Any sibling whose own gap
// exceeds the anchor's by more than STALE_REPLAY_THRESHOLD_MS is folded into the anchor instead of
// reported as its own item — comfortably past normal legitimate backdating variance (per the same
// research, ~70% of real policy-change rows land within 30 days of their own effective date) while
// safely excluding the ~1-year-old replay spike. A single isolated old transaction (no batch-mate to
// compare against) is left untouched either way — this only fires when a batch actually mixes a
// fresher and a much-older sibling, the specific pattern confirmed in the data.
const STALE_REPLAY_THRESHOLD_MS = 30 * 86_400_000

type StaleReplayInfo = { count: number; earliestEffdate: string; latestEffdate: string }

function foldStaleReplays(rows: PolicyTransactionRow[]): { keptRows: PolicyTransactionRow[]; staleReplayByKey: Map<string, StaleReplayInfo> } {
  const batches = new Map<string, PolicyTransactionRow[]>()

  for(const row of rows) {
    const key = `${ row.polid }||${ row.changeddate }`
    const batch = batches.get(key)

    if(batch) batch.push(row)
    else batches.set(key, [row])
  }

  const keptRows: PolicyTransactionRow[] = []
  const staleReplayByKey = new Map<string, StaleReplayInfo>()

  for(const batch of batches.values()) {
    if(batch.length === 1) {
      keptRows.push(batch[0])
      continue
    }

    const withGap = batch.map((row) => ({
      row,
      gap: new Date(row.changeddate).getTime() - new Date(row.effdate).getTime()
    }))

    const anchor = withGap.reduce((a, b) => (b.gap < a.gap ? b : a))
    const stale = withGap.filter((r) => r !== anchor && r.gap - anchor.gap > STALE_REPLAY_THRESHOLD_MS)

    keptRows.push(anchor.row)
    for(const { row } of withGap) {
      if(row !== anchor.row && !stale.some((s) => s.row === row)) keptRows.push(row)
    }

    if(stale.length > 0) {
      const effdates = stale.map((s) => s.row.effdate).sort()

      staleReplayByKey.set(`${ anchor.row.polid }||${ anchor.row.effdate }`, {
        count: stale.length,
        earliestEffdate: effdates[0],
        latestEffdate: effdates[effdates.length - 1]
      })
    }
  }

  return { keptRows, staleReplayByKey }
}

type InternalItem = Omit<ReportItem, "item_id"> & { csrcode: string | null; rep_name: string | null; polid?: string }

export function registerDownloadReportTool(server: McpServer) {
  server.registerTool(
    "download_report",
    {
      description: "Boxwood's daily \"Download Report\" — the overnight carrier-download review each rep does every morning, rebuilt from synced AMS360 data instead of AMS360's own exported report. Returns policy transactions and claims that came down from carriers overnight, normalized into plain-language action items and grouped by representative (CSR). RESPONSE SHAPE — this returns a compact result, not the full dataset: the full item list (every rep's routine AND flagged items, with every field) is written to a 24h link (`report_url`) instead of being embedded inline, to keep this response small on a busy day. The inline `reps[].flagged_items` only includes items where `flagged: true`, trimmed to just what judging accuracy requires (`item_id`, `customer_name`, `policy_no`, `what_happened`, `repeat_count`, and up to 3 most-recent `candidate_prior_activity` notes, each capped to 240 characters) — routine items are represented solely by `reps[].summary` counts, and flagged items' other fields (carrier_name, detail, next_step, ...) live only in the full dataset behind the link. Save `report_token` (the same value as the last path segment of `report_url`): pass it to `download_report_workbook` to build the finished worksheet from the *full* dataset (not just the flagged subset you saw here). IMPORTANT — this is a data-synthesis step only, not the finished worksheet: (1) `flagged` means \"this category is one a client could plausibly have requested something about\" (policy change/cancellation/rewrite/reinstatement/reissue/new business) — it is NOT AMS360's native [WARNING]/GROUP REJECT flag from its live download-processing log, which isn't replicated into any table this MCP can query and so cannot be reproduced here; (2) flagged items include `candidate_prior_activity` (recent staff notes on that policy) but NO verdict — deciding whether the download actually matches a documented client request requires reading those notes and judging, which is a separate reasoning step, not something this tool computes; (3) claims reflect only their current state — AMS360's own report can show a claim re-downloaded multiple times in one night (an \"x2/x3 overnight\" note), but that per-event history isn't stored in these tables, so no repeat-count is reported for claims; (4) policy transactions ARE collapsed when AMS360's download processor writes the same transaction (same policy/type/description) several times in quick succession — a confirmed, ongoing AMS360-side glitch, not a client action — into one item, so 12 identical rows read as 1 client-relevant event, not 12 separate requests; a 2-row repeat merges quietly (common enough — ~78% of these — to be unremarkable on its own), but 3+ is surfaced via `repeat_count` and called a repeated transaction, since that pattern is rare enough to be worth a second look. It is NOT necessarily harmless: no synced table records whether a transaction actually applied (isposted/isuploaded were checked and don't track this), so a repeated transaction can equally mean AMS360 kept retrying something that kept failing (e.g. a GROUP REJECT loop) — `next_step` calls this out for any item with a `repeat_count` and the rep should verify directly in AMS360 rather than assume it's cosmetic. (5) `change_detail` (client-requested 2026-09-02, broadened 2026-09-02 from a vehicle-only field per follow-up feedback) spells out the concrete specifics of what changed on a policy transaction, across every line of business — not just AMS360's terse transaction description. Two independent signals are merged into this one field, semicolon-joined when both fire on the same transaction: vehicle adds/removals with VIN (e.g. \"Added: 2019 FORD F-150 SUPERCREW RAPTOR (VIN 1FTFW1RG5KFC53281); Removed: 2013 FORD F-150 SUPERCREW (VIN 1FTFW1ET3DKE56229)\" for a vehicle replacement — Personal and Commercial Auto, `afw_vehicle`/`afw_127vehicle`), and coverage/limit/deductible adds, removals, and value changes for any line of business (e.g. \"Dwelling limit: $850,000 → $899,000; Other Structures limit: $170,000 → $179,800\" for a homeowners coverage bump, or \"Added coverage: Water Backup of Sewers & Drains ($50,000)\" for a new endorsement — `afw_coverage`). Both are correlated to the specific transaction (not just the policy) even when several related transactions land seconds apart on the same policy in one overnight batch. Null whenever a transaction has neither kind of activity — most transactions, including ones with `detail` text that already mentions a vehicle or coverage (e.g. a plain premium change), will have this as null; don't read null as \"nothing changed,\" only as \"nothing this field tracks changed on this specific transaction.\" Deliberately does not report a vehicle that was merely edited in place (e.g. renumbered when a sibling vehicle was added/removed) or a coverage row rewritten with identical values (AMS360 rewrites every active coverage on any coverage-related download, not just the one that changed) — only clear adds/removals/value-changes, since AMS360's audit trail can't reliably distinguish a real edit from an incidental side-effect touch. (6) `effective_date` on a policy_transaction item is that specific transaction's own effdate (when the change took effect), not the policy's own poleffdate/polexpdate — always null on a claim item, since claims have no equivalent field. (7) `stale_replay_count` (client-requested 2026-09-03: reports appeared to be \"pulling ALL the changes for that policy throughout the policy year\") covers a second, distinct AMS360 glitch from the repeat_count one above: when a policy's term closes out (renewal/rewrite/new-business), AMS360 re-stamps `changeddate` on every OTHER transaction from that closing term's history too, not just the new event, so a whole year of already-actioned changes can otherwise look freshly downloaded overnight. When a download batch mixes one clearly-fresher transaction with much older siblings from the same policy, the older ones are folded into the fresher one (same policy) rather than reported as their own items — `stale_replay_count` says how many, and `next_step` names the date range they were originally effective across. A single old transaction with no fresher batch-mate is left exactly as-is; this only fires on the specific mixed-batch pattern confirmed in real data. (8) `missing_transaction_record` (client-requested 2026-09-03: \"if a new row is inserted into afw_transaction by a carrier download we want to see that tx ... even if there is no policy change detected\") surfaces a carrier download that never got its own row in AMS360's policy-transaction table at all — afw_policytransaction only keeps the latest write per (policy, effective date), so when two downloads land on the same key close together, the earlier one's content is otherwise invisible to this report. These items are built from afw_transaction's own raw processing-log text instead (its `detail` is AMS360's cleaned-up commenttran narrative, e.g. \"Download updated the writing company from Hartford Property & Casualty to Hartford Insurance Group\" or a vehicle's discount change) — `categorized`/`flagged`/`change_detail`/`repeat_count`/`stale_replay_count` all still apply normally on top, since these items carry a real policy and effective date same as any other. `next_step` names this explicitly so a rep isn't confused why an item has unusual detail text.",
      inputSchema: {
        since: z.string().describe('Start of window: agency-local timestamp ("2026-08-28T08:00") or relative shorthand ("24h", "7d"). Defaults to the most recent 8am agency-local sync cutoff, minus 24h — i.e. the 8am-to-8am span ending at the last completed overnight sync').optional(),
        until: z.string().describe("End of window, same format as since. Defaults to the most recent 8am agency-local sync cutoff (or yesterday's 8am, if today's hasn't happened yet) — a firm boundary, not \"now\", since the AMS360 ETL sync doesn't reliably finish pulling overnight carrier activity until shortly after 7:30am, and the report script itself doesn't run until 8am").optional(),
        csr_code: z.string().describe("Scope to one representative (exact match against afw_customer.csrcode, the customer's header CSR — not afw_basicpolinfo's per-policy CSR field, which can diverge)").optional(),
        lookback_days: z.number().int().min(1).max(365).default(60).describe("How far back to search for candidate staff activity notes on flagged items")
      }
    },
    async ({ since, until, csr_code, lookback_days }) => {
      try {
        const defaultWindow = mostRecentAgencySyncWindow()
        const sinceDate = resolveWindowBound(since, () => defaultWindow.since)
        const untilDate = resolveWindowBound(until, () => defaultWindow.until)
        const csrParam = csr_code ?? null

        const [transactionRows, claimRows, missingDownloadRows] = await Promise.all([
          runReadOnlyQuery(POLICY_TRANSACTION_QUERY, [sinceDate, untilDate, csrParam]) as Promise<PolicyTransactionRow[]>,
          runReadOnlyQuery(CLAIM_QUERY, [sinceDate, untilDate, csrParam]) as Promise<ClaimRow[]>,
          runReadOnlyQuery(MISSING_DOWNLOAD_TRANSACTION_QUERY, [sinceDate, untilDate, csrParam]) as Promise<MissingDownloadTransactionRow[]>
        ])

        // Reshaped into PolicyTransactionRow so every downstream step (repeat clustering, stale-
        // replay folding, vehicle/coverage change_detail correlation, categorization, flagging) just
        // works on these the same as a real afw_policytransaction row — they carry a real
        // polid/effdate, the only things that machinery actually needs.
        const missingDownloadAsTransactionRows: PolicyTransactionRow[] = missingDownloadRows.map((row) => ({
          trantype: row.trantype,
          description: formatMissingDownloadDetail(row.commenttran),
          effdate: row.effdate,
          changeddate: row.changeddate,
          polid: row.polid,
          policy_no: row.policy_no,
          line_of_business: row.line_of_business,
          carrier_name: row.carrier_name,
          csrcode: row.csrcode,
          rep_name: row.rep_name,
          customer_name: row.customer_name,
          missingRecord: true
        }))

        const { keptRows, staleReplayByKey } = foldStaleReplays([...transactionRows, ...missingDownloadAsTransactionRows])
        const transactionClusters = clusterRepeats(keptRows)
        const canonicalRows = transactionClusters.map((c) => c.row)

        const transactionItems: InternalItem[] = transactionClusters.map(({ row, repeatCount }) => {
          const { category, flagged, nextStep } = categorizeTransaction(row.trantype)
          const isReportedRepeat = repeatCount >= MIN_REPORTED_REPEAT_COUNT

          // afw_policytransaction has no field that confirms a transaction actually applied —
          // isposted/isuploaded were checked and don't track it (isposted is 'N' on confirmed-
          // successful transactions just as often as on repeat rows; isuploaded is 'N' on every
          // row in the table). So a repeat can't be assumed harmless: it may be AMS360 retrying a
          // transaction that kept failing (e.g. a GROUP REJECT loop), not just redundant logging.
          const nextStepWithRepeatWarning = isReportedRepeat
            ? `${ nextStep } AMS360 logged this transaction ${ repeatCount }x in a row — verify directly in AMS360 that it actually took effect; a repeat like this can mean a failed/retried transaction, not just harmless duplicate logging.`
            : nextStep

          const staleReplay = staleReplayByKey.get(`${ row.polid }||${ row.effdate }`)
          const nextStepWithStaleWarning = staleReplay
            ? `${ nextStepWithRepeatWarning } AMS360 also redelivered ${ staleReplay.count } older transaction(s) from earlier in this policy's term in the same download batch (originally effective ${ staleReplay.earliestEffdate.slice(0, 10) } to ${ staleReplay.latestEffdate.slice(0, 10) }) — that's very likely AMS360 re-syncing already-actioned history, not new client activity, so no action is needed on those unless something looks off.`
            : nextStepWithRepeatWarning

          // See MISSING_DOWNLOAD_TRANSACTION_QUERY — this item has no backing afw_policytransaction
          // row at all (a later download reused its exact key first), so its detail comes from
          // AMS360's raw processing log instead; worth telling the rep that up front.
          const finalNextStep = row.missingRecord
            ? `${ nextStepWithStaleWarning } This download has no corresponding entry in AMS360's policy-transaction table — a later download reused the same effective date before this one could be recorded on its own, so the detail above comes from AMS360's raw processing log. Verify directly in AMS360 if anything here needs action.`
            : nextStepWithStaleWarning

          return {
            customer_name: row.customer_name,
            policy_no: row.policy_no,
            carrier_name: row.carrier_name,
            line_of_business: row.line_of_business,
            domain: "policy_transaction",
            what_happened: category,
            // pt.effdate — the transaction's own effective date, not the policy's poleffdate/
            // polexpdate — already localized/offset-suffixed by runReadOnlyQuery.
            effective_date: row.effdate,
            detail: stripDownloadPrefix(row.description),
            change_detail: null,
            next_step: finalNextStep,
            flagged,
            repeat_count: isReportedRepeat ? repeatCount : undefined,
            stale_replay_count: staleReplay?.count,
            missing_transaction_record: row.missingRecord || undefined,
            csrcode: row.csrcode,
            rep_name: row.rep_name,
            polid: row.polid
          }
        })

        if(canonicalRows.length > 0) {
          const idxs = canonicalRows.map((_, i) => i)
          const polids = canonicalRows.map((row) => row.polid)
          // row.effdate arrives here as an offset-suffixed string (runReadOnlyQuery's
          // localizeTimestamps already ran) — round-tripping through agencyWallClockParts recovers
          // the original naive agency-local wall-clock value needed to bind against these tables'
          // `timestamp without time zone` effdate columns, same pattern resolveWindowBound uses.
          const upperBounds = canonicalRows.map((row) => bindableAgencyDate(agencyWallClockParts(new Date(row.effdate))))
          const lowerBounds = upperBounds.map((d) => new Date(d.getTime() - REPEAT_GAP_MS))

          const [vehicleChangeRows, coverageChangeRows] = await Promise.all([
            runReadOnlyQuery(VEHICLE_CHANGE_QUERY, [idxs, polids, lowerBounds, upperBounds]) as Promise<VehicleChangeRow[]>,
            runReadOnlyQuery(COVERAGE_CHANGE_QUERY, [idxs, polids, lowerBounds, upperBounds]) as Promise<CoverageChangeRow[]>
          ])

          const vehicleChangesByIdx = new Map<number, Omit<VehicleChangeRow, "idx">[]>()
          for(const row of vehicleChangeRows) {
            const group = vehicleChangesByIdx.get(row.idx)
            if(group) group.push(row)
            else vehicleChangesByIdx.set(row.idx, [row])
          }

          const coverageChangesByIdx = new Map<number, CoverageChangeRow[]>()
          for(const row of coverageChangeRows) {
            const group = coverageChangesByIdx.get(row.idx)
            if(group) group.push(row)
            else coverageChangesByIdx.set(row.idx, [row])
          }

          // Vehicle adds/removes (with VIN) and coverage adds/removes/limit changes are two
          // independent signals about the same underlying transaction — merged into one field since
          // the client's ask ("specifics of what changed") doesn't distinguish between them, and a
          // single vehicle-replacement-plus-coverage-bump download should read as one combined line,
          // not force a rep to check two columns.
          for(const [index, item] of transactionItems.entries()) {
            const vehicleSummary = summarizeVehicleChanges(vehicleChangesByIdx.get(index) ?? [])
            const coverageSummary = summarizeCoverageChanges(coverageChangesByIdx.get(index) ?? [])

            item.change_detail = [vehicleSummary, coverageSummary].filter((s): s is string => s !== null).join("; ") || null
          }
        }

        const flaggedTransactions = canonicalRows.filter((_, i) => transactionItems[i].flagged)

        let candidatesByPolid = new Map<string, CandidateActivityRow[]>()

        if(flaggedTransactions.length > 0) {
          const polids = [...new Set(flaggedTransactions.map((row) => row.polid))]
          const earliestNeeded = new Date(Math.min(...flaggedTransactions.map((row) => new Date(row.changeddate).getTime())) - lookback_days * 86_400_000)
          const latestNeeded = new Date(Math.max(...flaggedTransactions.map((row) => new Date(row.changeddate).getTime())))

          const candidateRows = await runReadOnlyQuery(CANDIDATE_ACTIVITY_QUERY, [polids, earliestNeeded, latestNeeded]) as CandidateActivityRow[]

          candidatesByPolid = groupByKey(candidateRows, "polid")
        }

        for(const [index, row] of canonicalRows.entries()) {
          const item = transactionItems[index]

          if(!item.flagged) continue

          const windowStart = new Date(row.changeddate).getTime() - lookback_days * 86_400_000
          const windowEnd = new Date(row.changeddate).getTime()

          const candidates = (candidatesByPolid.get(row.polid) ?? [])
            .filter((c) => {
              const t = new Date(c.changeddate).getTime()
              return t >= windowStart && t <= windowEnd
            })
            .slice(0, CANDIDATE_LIMIT_PER_ITEM)
            .map((c) => ({ date: c.changeddate, note: c.commenttran ?? "" }))

          item.candidate_prior_activity = candidates
        }

        const claimItems: InternalItem[] = claimRows.map((row) => ({
          customer_name: row.customer_name,
          policy_no: row.policy_no,
          carrier_name: row.carrier_name,
          line_of_business: row.line_of_business,
          domain: "claim",
          what_happened: "Claim downloaded",
          // Claims have no analog to a policy transaction's effdate — lossdate/closeddate are
          // already surfaced in `detail` and mean something different.
          effective_date: null,
          detail: [row.claimno ? `Claim #${ row.claimno }` : null, row.claimstatus, row.causeofloss, row.descriptioncl].filter(Boolean).join(" — "),
          change_detail: null,
          next_step: claimNextStep(row.claimstatus),
          flagged: false,
          csrcode: row.csrcode,
          rep_name: row.rep_name
        }))

        // item_id is assigned once, across the whole report, after every item is otherwise final —
        // it's the join key download_report_workbook uses to reattach a verdict to the right item
        // in the *stored* full dataset, since only flagged items (a subset) travel back through the
        // caller's context.
        const allItems: (InternalItem & { item_id: number })[] = [...transactionItems, ...claimItems]
          .map((item, i) => ({ ...item, item_id: i + 1 }))

        const grouped = groupByKey(allItems, "csrcode")

        const reps = [...grouped.entries()].map(([csrcode, items]) => ({
          csr_code: csrcode === "null" ? null : csrcode,
          rep_name: items[0].rep_name,
          summary: {
            item_count: items.length,
            flagged_count: items.filter((i) => i.flagged).length,
            claim_count: items.filter((i) => i.domain === "claim").length
          },
          items: items.map(({ csrcode: _c, rep_name: _r, polid: _p, ...item }): ReportItem => item)
        }))

        // sinceDate/untilDate are "bindable" Dates whose UTC digits are agency-local wall-clock
        // digits, not a true instant — formatTimestampColumn's reinterpret path (used for every
        // other agency-local timestamp this MCP returns) renders that correctly with a real offset
        // suffix, instead of a bare toISOString() misleadingly implying true UTC.
        const window = { since: formatTimestampColumn(sinceDate, "since"), until: formatTimestampColumn(untilDate, "until") }

        // The full dataset (every item, not just flagged) is what download_report_workbook needs to
        // render every row of the finished worksheet — stored here and handed back as a link rather
        // than returned inline, since a busy day's full item list can exceed the MCP tool-result size
        // cap on its own (confirmed: 119 policy-transaction rows + 5 claims produced a 114,907-
        // character response). Reusing storeDownload/getDownload — the same mechanism
        // download_report_workbook already uses for the finished .xlsx.
        const dateSlug = window.until.slice(0, 10)
        const reportToken = storeDownload(Buffer.from(JSON.stringify({ window, reps })), `download-report-${ dateSlug }.json`, REPORT_JSON_MIME_TYPE)

        // The inline flagged_items view carries only what judging accuracy actually requires — the
        // full item (carrier_name, detail, next_step, ...) is workbook-rendering content that lives
        // in the stored full dataset and never needs to enter the caller's context. Notes are capped
        // to the 3 most recent and trimmed to JUDGMENT_NOTE_MAX_CHARS: a day with enough flagged
        // items and long staff notes can still exceed the MCP tool-result size cap otherwise
        // (confirmed: dropping unflagged items alone cut a 114,907-character response to only
        // 90,392 — candidate_prior_activity note text, not the unflagged items, is the real driver).
        const JUDGMENT_NOTES_MAX = 3
        const JUDGMENT_NOTE_MAX_CHARS = 240

        const toJudgmentItem = (item: ReportItem) => ({
          item_id: item.item_id,
          customer_name: item.customer_name,
          policy_no: item.policy_no,
          what_happened: item.what_happened,
          change_detail: item.change_detail,
          repeat_count: item.repeat_count,
          stale_replay_count: item.stale_replay_count,
          missing_transaction_record: item.missing_transaction_record,
          // A missing_transaction_record item has no afw_policytransaction row at all — its `detail`
          // (AMS360's cleaned-up commenttran text) is the only source of concrete specifics, unlike a
          // normal item where `detail` is just a short categorized label already implied by
          // `what_happened` and not worth the extra response size.
          detail: item.missing_transaction_record ? item.detail : undefined,
          candidate_prior_activity: item.candidate_prior_activity?.slice(0, JUDGMENT_NOTES_MAX).map(({ date, note }) => ({
            date,
            note: note.length > JUDGMENT_NOTE_MAX_CHARS ? `${ note.slice(0, JUDGMENT_NOTE_MAX_CHARS) }…` : note
          }))
        })

        return textResult({
          window,
          report_token: reportToken,
          report_url: `${ publicBaseUrl }/downloads/${ reportToken }`,
          reps: reps.map((rep) => ({
            csr_code: rep.csr_code,
            rep_name: rep.rep_name,
            summary: rep.summary,
            flagged_items: rep.items.filter((item) => item.flagged).map(toJudgmentItem)
          }))
        })
      } catch(error) {
        logger.error({ err: error, since, until, csr_code, lookback_days }, "download_report failed")
        return errorResult(error)
      }
    }
  )
}
