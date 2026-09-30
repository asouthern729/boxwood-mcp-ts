import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../../config/config.js"
import { runReadOnlyQuery } from "../../db.js"
import { categorizeTransaction, claimNextStep } from "../../utils/downloadCategorization.js"
import { storeDownload } from "../../utils/downloadStore.js"
import { systemEmployeeCondition } from "../../utils/employeeClassification.js"
import { agencyWallClockParts, bindableAgencyDate, formatTimestampColumn, mostRecentAgencySyncWindow } from "../../utils/localTime.js"
import { logger } from "../../utils/logger.js"
import { errorResult, groupByKey, textResult } from "../../utils/mcpHelpers.js"

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

// "Last, First" for a person (Patrick, 2026-09-29: "Switch to customer last name, First name in first
// column"), otherwise the business name. Keyed on which name fields are filled rather than
// afw_customer.typename, which isn't reliable (~72 typename='I' customers are really LLCs/trusts/
// HOAs with only firmnamecust set). Checked against every customer with a carrier download in the
// prior 90 days (2026-09-30): no business has first+last without a firm name, all 6 individuals with
// a dba are real business DBAs, and joint households keep both names in firstname ("Carney, Addison &
// Grace"). A generational suffix kept in lastname ("Pratt Jr") moves after the first name ("Pratt,
// Paul Jr").
const NAME_SUFFIX_PATTERN = "[ ,]+((?:jr|sr)\\.?|ii|iii|iv)$"
const CUSTOMER_NAME_EXPR = `CASE
  WHEN NULLIF(TRIM(c.dba), '') IS NULL AND NULLIF(TRIM(c.firmnamecust), '') IS NULL
    AND NULLIF(TRIM(c.firstname), '') IS NOT NULL AND NULLIF(TRIM(c.lastname), '') IS NOT NULL
  THEN regexp_replace(TRIM(c.lastname), '${ NAME_SUFFIX_PATTERN }', '', 'i') || ', ' || TRIM(c.firstname)
    || COALESCE(' ' || substring(TRIM(c.lastname) FROM '(?i)${ NAME_SUFFIX_PATTERN }'), '')
  ELSE COALESCE(c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''), c.firmnamecust)
END`
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

// This report's window binds against `entereddate` (when a row was genuinely first written),
// not `changeddate` (when it was last touched) — a deliberate switch, 2026-09-11, from staff
// reporting that some transactions were "flagged as not on [today's] report" but had actually
// downloaded days earlier. Root cause, confirmed at scale (not just a handful of examples): AMS360
// re-touches `changeddate` on a huge share of `afw_policytransaction` rows well after real entry —
// 70.7% of all source='D' rows have `entereddate` earlier than `changeddate`, 38.4% by more than 30
// days, spread across 6,434 distinct policies (max observed gap ~3.3 years) — while `entereddate`
// itself never moves (0 nulls, and only 1 row out of 27,685 ever shows entereddate > changeddate,
// an outlier not a pattern). `changeddate`-based windowing meant a transaction's "report day" could
// silently drift to whatever day something unrelated last touched it, exactly matching the staff
// complaint. `entereddate` doesn't have this problem: it's set once, at genuine first capture, and
// stays put — confirmed the same way for `afw_claim.entereddate` (same NOT NULL shape). Note this
// is a distinct problem from `foldCrossTermEchoes`/the out-of-window vehicle/coverage-attribution
// guard/etc. above — those fix duplicate or miscounted content *within* an already-correctly-
// selected transaction; this fixes *which day a transaction is selected into at all*. Switching
// this out doesn't make any of that other work redundant — see this session's actual verification
// (e.g. Rooney's cross-term echo is two rows entered seconds apart in the same real batch, not a
// changeddate-drift artifact, so it still needs folding regardless of which column windows the
// report). One consequence: the `foldStaleReplays` mechanism that used to live in this file (fixed
// old rows whose `changeddate` got swept into a fresh batch) is gone — confirmed empirically dead
// under `entereddate` windowing (see the note where it used to be, just below `clusterRepeats`)
// before removing it.
const POLICY_TRANSACTION_QUERY = `
  SELECT
    pt.trantype, pt.description, pt.effdate, pt.changeddate, pt.entereddate, pt.polid,
    bp.custid, bp.polno AS policy_no, bp.poltypelob AS line_of_business,
    co.name AS carrier_name,
    c.csrcode, ${ REP_NAME_EXPR } AS rep_name,
    ${ CUSTOMER_NAME_EXPR } AS customer_name
  FROM afw_policytransaction pt
  JOIN afw_basicpolinfo bp ON bp.polid = pt.polid
  LEFT JOIN afw_customer c ON c.custid = bp.custid
  LEFT JOIN afw_company co ON co.cocode = bp.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = c.csrcode
  WHERE pt.source = 'D'
    AND pt.entereddate BETWEEN $1 AND $2
    AND ($3::text IS NULL OR c.csrcode = $3)
    AND ($4::timestamp IS NULL OR pt.synced_at >= $4)
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
  WHERE cl.entereddate BETWEEN $1 AND $2
    AND ($3::text IS NULL OR c.csrcode = $3)
    AND ($4::timestamp IS NULL OR cl.synced_at >= $4)
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
    tr.trantype, tr.commenttran, tr.effdate, tr.changeddate, tr.entereddate, tr.polid,
    bp.custid, bp.polno AS policy_no, bp.poltypelob AS line_of_business,
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
    AND tr.entereddate BETWEEN $1 AND $2
    AND ($3::text IS NULL OR c.csrcode = $3)
    AND ($4::timestamp IS NULL OR tr.synced_at >= $4)
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
  entereddate: string
  polid: string
  custid: string
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
// filters/caps its own slice client-side against its own entereddate, since "prior" is relative to
// when that specific transaction was genuinely entered, not a single report-wide cutoff. Binds
// against entereddate for the same reason the outer report window does (see POLICY_TRANSACTION_QUERY) —
// though afw_transaction's own entereddate/changeddate are essentially always identical (confirmed
// 99.993% match, unlike afw_policytransaction), so this is a consistency change, not a fix in itself.
//
// The activity date is trandate — the date staff set on the activity in AMS360, which they can backdate
// when logging past work late — falling back to entereddate. changeddate never differs from
// entereddate on this table (100% of 180 days checked 2026-09-30), so it carried no extra meaning.
// A note still has to have been ENTERED by the time the download was, so work logged afterwards but
// backdated can't masquerade as prior context.
const CANDIDATE_ACTIVITY_QUERY = `
  SELECT tr.polid, COALESCE(tr.trandate, tr.entereddate) AS activity_date, tr.entereddate, tr.commenttran
  FROM afw_transaction tr
  WHERE tr.polid = ANY($1::uuid[])
    AND COALESCE(tr.trandate, tr.entereddate) >= $2
    AND tr.entereddate <= $3
    AND EXISTS (
      SELECT 1 FROM afw_employee e
      WHERE e.empcode = tr.changedby AND NOT ${ systemEmployeeCondition("e") }
    )
  ORDER BY tr.polid, activity_date DESC
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
//
// A second `NOT EXISTS` guards a different failure found investigating client-requested duplicate-
// reduction work (2026-09-11): `txns` only ever contains transactions from *this report run's own
// window* — so if a vehicle/coverage row's true owning transaction was already downloaded (and
// reported) on an earlier day, that owner is invisible here, and the row silently defaults onto
// whatever unrelated transaction happens to be nearby *in this run* instead. Confirmed against real
// data: a policy's renewal (entered 5 days before a later report's window) never appeared in that
// later run's `txns`, so its entire coverage rewrite — nothing to do with the later transaction —
// misattributed onto an unrelated same-day endorsement one second after it, reading as "31 coverage
// changes" caused by that endorsement when none of them were. Checking against the real
// `afw_policytransaction` table directly (not just this run's own `txns`) catches this: if some
// *other* real `source='D'` transaction on the policy sits at or after the vehicle/coverage row's
// own effdate and strictly before the candidate's, a genuine closer owner exists somewhere (in or
// out of this run's window) and this candidate shouldn't claim the row, even though it's the only
// one currently in scope.
const VEHICLE_CHANGE_QUERY = `
  WITH txns AS (
    SELECT * FROM UNNEST($1::int[], $2::uuid[], $3::timestamp[], $4::timestamp[]) AS t(idx, polid, lower_bound, upper_bound)
  ), matches AS (
    SELECT txns.idx, txns.polid, txns.upper_bound, v.effdate, v.status, v.vin, v.make, v.model, v.vehyear, v.vehid AS unit_id,
      EXISTS (
        SELECT 1 FROM afw_vehicle v2 JOIN afw_basicpolinfo bp ON bp.polid = txns.polid
        WHERE v2.polid IN (bp.polid, bp.priorpolid) AND v2.vin = v.vin AND v2.status <> 'D' AND v2.effdate < txns.lower_bound
      ) AS seen_before,
      EXISTS (
        SELECT 1 FROM afw_vehicle v2
        WHERE v2.polid = v.polid AND v2.vin = v.vin AND v2.status <> 'D' AND v2.effdate > v.effdate AND v2.effdate <= txns.upper_bound
      ) AS still_active
    FROM txns
    JOIN afw_vehicle v ON v.polid = txns.polid AND v.effdate BETWEEN txns.lower_bound AND txns.upper_bound
    UNION ALL
    SELECT txns.idx, txns.polid, txns.upper_bound, v.effdate, v.status, v.vin, v.make, v.model, v.vehyear, v.vehdid AS unit_id,
      EXISTS (
        SELECT 1 FROM afw_127vehicle v2 JOIN afw_basicpolinfo bp ON bp.polid = txns.polid
        WHERE v2.polid IN (bp.polid, bp.priorpolid) AND v2.vin = v.vin AND v2.status <> 'D' AND v2.effdate < txns.lower_bound
      ) AS seen_before,
      EXISTS (
        SELECT 1 FROM afw_127vehicle v2
        WHERE v2.polid = v.polid AND v2.vin = v.vin AND v2.status <> 'D' AND v2.effdate > v.effdate AND v2.effdate <= txns.upper_bound
      ) AS still_active
    FROM txns
    JOIN afw_127vehicle v ON v.polid = txns.polid AND v.effdate BETWEEN txns.lower_bound AND txns.upper_bound
  )
  SELECT m.idx, m.effdate, m.status, m.vin, m.make, m.model, m.vehyear, m.unit_id, m.seen_before, m.still_active
  FROM matches m
  WHERE NOT EXISTS (
    SELECT 1 FROM txns t2
    WHERE t2.polid = m.polid AND t2.upper_bound < m.upper_bound AND t2.upper_bound >= m.effdate
  )
  AND NOT EXISTS (
    SELECT 1 FROM afw_policytransaction pt2
    WHERE pt2.polid = m.polid AND pt2.source = 'D'
      AND pt2.effdate >= m.effdate AND pt2.effdate < m.upper_bound
  )
`

type VehicleChangeRow = {
  idx: number; effdate: string; status: string; vin: string | null; make: string | null; model: string | null; vehyear: string | null
  unit_id: string | null
  // Whether this VIN was already active on the policy (this term or the prior one) before the
  // transaction, and whether it's re-written as active later within the same transaction window — carriers re-send an unchanged vehicle as
  // A/D rows on unrelated endorsements ("Paperless DSC Removed", driver re-rates), so status alone
  // doesn't mean a vehicle was really added or removed (2026-09-30 data check).
  seen_before: boolean; still_active: boolean
}

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
// Property limits) out of 96 coverage rows in its window. Also carries the same second `NOT EXISTS`
// guard as VEHICLE_CHANGE_QUERY (see its comment) against a coverage row's true owning transaction
// having already been reported on an earlier day and so being invisible to this run's own `txns` —
// confirmed real: a policy's renewal's entire coverage rewrite (26 rows) misattributed onto an
// unrelated same-day endorsement one second later, reading as "31 coverage changes" caused by that
// endorsement when none of them were, since the renewal itself was outside this run's window.
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
//
// The "previous state" LATERAL below is scoped to (custid, polno, coverageid) rather than the
// narrower (polid, coverageid) — found investigating client-requested duplicate-reduction work
// (2026-09-11): `coverageid` was confirmed to stay stable for the same real coverage line across a
// policy's renewal terms even though AMS360 mints a brand-new `polid` every term. A same-`polid`-only
// scope means a renewal's very first coverage snapshot under its new `polid` can never find its own
// prior row — even when a real, unchanged prior value exists under the *previous* term's `polid` —
// so every renewal would otherwise over-report "none → current" for coverage lines that never
// actually changed, confirmed real against Tiffany Fallon Rooney's coverage history (same
// coverageid present under both her old-term and new-term polid, same value, for a limit the report
// wrongly showed going from "none"). Joining through afw_basicpolinfo to resolve custid/polno keeps
// the lookup scoped to this same real policy (not just trusting coverageid's uniqueness alone)
// while still reaching across term/polid boundaries.
const COVERAGE_CHANGE_QUERY = `
  WITH txns AS (
    SELECT * FROM UNNEST($1::int[], $2::uuid[], $3::timestamp[], $4::timestamp[]) AS t(idx, polid, lower_bound, upper_bound)
  ), matches AS (
    SELECT txns.idx, txns.polid, txns.upper_bound, cov.coverageid, cov.effdate, cov.status,
      COALESCE(cov.descrcov, cov.coveragecode) AS coverage_name, cov.coveragecode, cov.attachid, cov.attachtype,
      cov.limit1, cov.limit2, cov.limit3, cov.deduct1, cov.deduct2, cov.deduct3,
      bp.custid, bp.polno
    FROM txns
    JOIN afw_coverage cov ON cov.polid = txns.polid AND cov.effdate BETWEEN txns.lower_bound AND txns.upper_bound
    JOIN afw_basicpolinfo bp ON bp.polid = txns.polid
  ), attributed AS (
    SELECT m.* FROM matches m
    WHERE NOT EXISTS (
      SELECT 1 FROM txns t2
      WHERE t2.polid = m.polid AND t2.upper_bound < m.upper_bound AND t2.upper_bound >= m.effdate
    )
    AND NOT EXISTS (
      SELECT 1 FROM afw_policytransaction pt2
      WHERE pt2.polid = m.polid AND pt2.source = 'D'
        AND pt2.effdate >= m.effdate AND pt2.effdate < m.upper_bound
    )
  )
  SELECT a.idx, a.status, a.coverage_name, a.coverageid, a.coveragecode, a.attachid, a.attachtype,
    (
      SELECT NULLIF(TRIM(CONCAT_WS(' ', v.vehyear, v.make, v.model)), '')
      FROM afw_vehicle v WHERE a.attachtype = 121 AND v.vehid = a.attachid
      ORDER BY v.effdate DESC LIMIT 1
    ) AS unit_label,
    a.limit1, a.limit2, a.limit3, a.deduct1, a.deduct2, a.deduct3,
    p.limit1 AS prev_limit1, p.limit2 AS prev_limit2, p.limit3 AS prev_limit3,
    p.deduct1 AS prev_deduct1, p.deduct2 AS prev_deduct2, p.deduct3 AS prev_deduct3,
    EXISTS (
      SELECT 1 FROM afw_coverage c3 JOIN afw_basicpolinfo bp3 ON bp3.polid = c3.polid
      WHERE bp3.custid = a.custid AND bp3.polno = a.polno AND c3.effdate < a.effdate
    ) AS chain_has_prior
  FROM attributed a
  LEFT JOIN LATERAL (
    SELECT c2.limit1, c2.limit2, c2.limit3, c2.deduct1, c2.deduct2, c2.deduct3
    FROM afw_coverage c2
    JOIN afw_basicpolinfo bp2 ON bp2.polid = c2.polid
    WHERE bp2.custid = a.custid AND bp2.polno = a.polno AND c2.effdate < a.effdate
      AND (
        c2.coverageid = a.coverageid
        -- Carriers re-send an unchanged coverage under a NEW coverageid (old id D, new id A + C, same
        -- values — e.g. "Added Apt. Number" = 14 such re-sends, zero real changes), so the same
        -- coverage on the same unit (coveragecode + attachid) on this term also counts as its prior.
        OR (c2.polid = a.polid AND c2.coveragecode = a.coveragecode AND c2.attachid IS NOT DISTINCT FROM a.attachid)
      )
    ORDER BY (c2.coverageid = a.coverageid) DESC, c2.effdate DESC LIMIT 1
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
  coverageid: string
  coveragecode: string | null
  attachid: string | null
  // afw_coverage attach level: 121 = a vehicle (attachid = afw_vehicle.vehid), 85 = line of
  // business, 86 = location, 578 = scheduled property; anything else is another per-unit schedule
  // (boats etc.).
  attachtype: number | null
  unit_label: string | null
  // False when the policy (this polno, any term) has no coverage rows at all before this one — the
  // carrier sending its coverage detail for the first time, not coverages being added.
  chain_has_prior: boolean
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
const COVERAGE_FIELDS = [
  { label: "limit", key: "limit1" as const, prevKey: "prev_limit1" as const },
  { label: "limit (2)", key: "limit2" as const, prevKey: "prev_limit2" as const },
  { label: "limit (3)", key: "limit3" as const, prevKey: "prev_limit3" as const },
  { label: "deductible", key: "deduct1" as const, prevKey: "prev_deduct1" as const },
  { label: "deductible (2)", key: "deduct2" as const, prevKey: "prev_deduct2" as const },
  { label: "deductible (3)", key: "deduct3" as const, prevKey: "prev_deduct3" as const }
]

// Coverage rows are grouped per real coverage line — the same coverage on the same unit
// (coveragecode + attachid) — rather than per coverageid. AMS360 sometimes writes a superseded
// placeholder ('D') immediately followed by the final value ('A') for one coverage within a rewrite
// (John Lynch's HO264928000: 25 raw rows, 7 real changes), and carriers also re-send an unchanged
// coverage under a brand-new coverageid ("Added Apt. Number": 14 re-sent coverages, zero real
// changes, 2026-09-30). An identical-value D+A pair nets to nothing; a different-value pair reads
// as one diff line instead of "Removed X; Added X".
//
// Coverages attached to a vehicle that was really added/removed are folded into that vehicle's own
// line instead of listed ("Removed: 2023 Lamborghini Huracan (and its 8 coverages)"), and a policy
// whose carrier is sending coverage detail for the first time reads as exactly that rather than as
// every coverage being "Added".
type CoverageSummary = { lines: string[]; firstImageCount: number; foldedByUnit: Map<string, number> }

function summarizeCoverageChanges(rows: CoverageChangeRow[], foldUnitIds: Set<string>): CoverageSummary {
  const lines: string[] = []
  const foldedByUnit = new Map<string, number>()
  let firstImageCount = 0
  const byLine = new Map<string, CoverageChangeRow[]>()

  // A re-sent coverage can also come back attached to a re-sent unit (a new location/boat id), so
  // identical remove+add pairs are cancelled by coverage code alone before grouping by unit.
  const valuesKey = (r: CoverageChangeRow) => `${ r.coveragecode ?? r.coverage_name }|${ COVERAGE_FIELDS.map((f) => r[f.key]).join("|") }`
  const removedByValues = new Map<string, CoverageChangeRow[]>()
  for(const row of rows) {
    if(row.status === "D") removedByValues.set(valuesKey(row), [...(removedByValues.get(valuesKey(row)) ?? []), row])
  }
  const cancelled = new Set<CoverageChangeRow>()
  for(const row of rows) {
    if(row.status !== "A") continue
    const match = removedByValues.get(valuesKey(row))?.find((d) => !cancelled.has(d))
    if(match) {
      cancelled.add(match)
      cancelled.add(row)
    }
  }

  for(const row of rows) {
    if(cancelled.has(row)) continue
    // A 'C' row with nothing earlier to diff against is a re-sent image, not a change.
    if(row.status !== "A" && row.status !== "D" && COVERAGE_FIELDS.every((f) => row[f.prevKey] === null)) continue
    if(row.attachid && foldUnitIds.has(row.attachid)) {
      foldedByUnit.set(row.attachid, (foldedByUnit.get(row.attachid) ?? 0) + 1)
      continue
    }
    if(row.status === "A" && !row.chain_has_prior) {
      firstImageCount++
      continue
    }
    const key = `${ row.attachid ?? "" }|${ row.coveragecode ?? row.coverageid }`
    const group = byLine.get(key)
    if(group) group.push(row)
    else byLine.set(key, [row])
  }

  // Every coverage on one vehicle/boat removed (or added) together is that unit being removed or
  // added, even when the unit's own schedule row didn't line up with this transaction — reported as
  // one line instead of one per coverage ("Removed Jeep" = 7 coverage lines before, 2026-09-30).
  const UNIT_LEVEL_EXCLUDED = new Set([85, 86, 578])
  const MIN_UNIT_COVERAGES = 3
  const byUnit = new Map<string, CoverageChangeRow[]>()
  for(const group of byLine.values()) {
    for(const row of group) {
      if(!row.attachid || row.attachtype === null || UNIT_LEVEL_EXCLUDED.has(row.attachtype)) continue
      byUnit.set(row.attachid, [...(byUnit.get(row.attachid) ?? []), row])
    }
  }
  const foldedUnitRows = new Set<CoverageChangeRow>()
  for(const unitRows of byUnit.values()) {
    const statuses = new Set(unitRows.map((r) => r.status))
    if(unitRows.length < MIN_UNIT_COVERAGES || statuses.size !== 1 || !(statuses.has("A") || statuses.has("D"))) continue
    const unit = unitRows[0].unit_label ?? (unitRows[0].attachtype === 121 ? "a vehicle" : "a scheduled unit (boat, trailer, etc.)")
    lines.push(`${ statuses.has("A") ? "Added coverages for" : "Removed coverages for" } ${ unit } (${ unitRows.length })`)
    unitRows.forEach((r) => foldedUnitRows.add(r))
  }

  for(const fullGroup of byLine.values()) {
    const group = fullGroup.filter((r) => !foldedUnitRows.has(r))
    if(group.length === 0) continue
    const added = group.filter((r) => r.status === "A").at(-1)
    const removed = group.find((r) => r.status === "D")

    if(added && removed) {
      for(const field of COVERAGE_FIELDS) {
        const beforeValue = removed[field.key]
        const afterValue = added[field.key]

        if(beforeValue === afterValue) continue
        lines.push(`${ added.coverage_name } ${ field.label }: ${ formatMoney(beforeValue) || "none" } → ${ formatMoney(afterValue) || "none" }`)
      }
      continue
    }

    for(const row of group) {
      if(row.status === "A") {
        // An 'A' row that matches an existing coverage line's prior values is a re-send, not an add.
        const unchanged = COVERAGE_FIELDS.every((f) => row[f.key] === row[f.prevKey]) && COVERAGE_FIELDS.some((f) => row[f.prevKey] !== null)
        if(!unchanged) lines.push(`Added coverage: ${ row.coverage_name }${ row.limit1 !== null ? ` (${ formatMoney(row.limit1) })` : "" }`)
        continue
      }

      if(row.status === "D") {
        lines.push(`Removed coverage: ${ row.coverage_name }${ row.limit1 !== null ? ` (${ formatMoney(row.limit1) })` : "" }`)
        continue
      }

      for(const field of COVERAGE_FIELDS) {
        const current = row[field.key]
        const prev = row[field.prevKey]

        if(current === prev) continue
        lines.push(`${ row.coverage_name } ${ field.label }: ${ formatMoney(prev) || "none" } → ${ formatMoney(current) || "none" }`)
      }
    }
  }

  return { lines: [...new Set(lines)], firstImageCount, foldedByUnit }
}

function coverageSummaryText({ lines, firstImageCount }: CoverageSummary): string | null {
  const parts: string[] = []

  // Past the cap, the most useful thing is still to show the first few real changes and say how
  // many more there are, rather than replace them all with a count.
  if(lines.length > MAX_REPORTED_COVERAGE_CHANGES) {
    parts.push(...lines.slice(0, MAX_REPORTED_COVERAGE_CHANGES), `+${ lines.length - MAX_REPORTED_COVERAGE_CHANGES } more coverage changes — review the coverage schedule in AMS360`)
  } else {
    parts.push(...lines)
  }

  if(firstImageCount > 0) parts.push(`Coverage detail first received from carrier (${ firstImageCount } coverage${ firstImageCount === 1 ? "" : "s" })`)

  return parts.length ? parts.join("; ") : null
}

// A single real-world vehicle add/replace/delete can leave more than one audit row behind for the
// *same* vin within one transaction's window — confirmed against real data: an "Add" is very often
// immediately followed by a same-second "Change" row for that identical vehicle (an AMS360
// processing artifact, not a second real event). Collapsing by vin and preferring Added/Removed
// over a bare Change avoids reporting that artifact as its own line. A vin with only Change rows in
// its window (also confirmed real — e.g. a sibling vehicle silently renumbered when another vehicle
// on the same policy was added/removed) is dropped entirely rather than surfaced as "Updated": there's
// no reliable way to tell that apart from real field-level edits without diffing every column, and
// the client's ask was specifically about vehicles being added/removed, not renumbered. An A/D row
// only counts when the VIN is really new to the policy / really gone from it (seen_before /
// still_active), since carriers re-send unchanged vehicles on unrelated endorsements.
type VehicleLine = { unitIds: string[]; text: string }

function summarizeVehicleChanges(rows: Omit<VehicleChangeRow, "idx">[]): VehicleLine[] {
  const byVin = new Map<string, Omit<VehicleChangeRow, "idx">[]>()

  for(const row of rows) {
    const key = row.vin ?? `${ row.make }|${ row.model }|${ row.vehyear }`
    const group = byVin.get(key)

    if(group) group.push(row)
    else byVin.set(key, [row])
  }

  const lines: VehicleLine[] = []

  for(const group of byVin.values()) {
    // The last add/remove in the window decides the direction ("Delt Bronco, Add Jeep" writes the
    // Bronco as A then D within seconds).
    const last = group
      .filter((r) => r.status === "A" || r.status === "D")
      .sort((a, b) => new Date(a.effdate).getTime() - new Date(b.effdate).getTime())
      .at(-1)
    if(!last) continue

    const real = last.status === "A" ? !last.vin || !last.seen_before : !last.vin || !last.still_active
    if(!real) continue

    const winner = last
    const action = last.status === "A" ? "Added" : "Removed"
    const vehicleLabel = [winner.vehyear, winner.make, winner.model].filter(Boolean).join(" ")

    lines.push({
      unitIds: [...new Set(group.map((r) => r.unit_id).filter((id): id is string => Boolean(id)))],
      text: `${ action }: ${ vehicleLabel || "vehicle" }${ winner.vin ? ` (VIN ${ winner.vin })` : "" }`
    })
  }

  return lines
}

// A real single client-driven change (a swap, an add, an occasional 2-4 vehicle fleet update)
// never touches more than a handful of vehicles at once — confirmed against real data that a
// double-digit count here means the correlation window caught a bulk vehicle-schedule reload
// rather than anything from this specific transaction. A wall of dozens of VINs would also just be
// useless in a report cell either way, so this is reported as a count instead of listed out.
const MAX_REPORTED_VEHICLES = 6

function vehicleSummaryText(lines: VehicleLine[], foldedByUnit: Map<string, number>): string | null {
  if(lines.length === 0) return null
  if(lines.length > MAX_REPORTED_VEHICLES) {
    return `${ lines.length } vehicles added/removed — too many to list here, review the vehicle schedule directly in AMS360`
  }

  return lines.map(({ unitIds, text }) => {
    const folded = unitIds.reduce((sum, id) => sum + (foldedByUnit.get(id) ?? 0), 0)
    return folded > 0 ? `${ text } (and its ${ folded } coverage${ folded === 1 ? "" : "s" })` : text
  }).join("; ")
}

// Premium impact of each downloaded transaction (Patrick, 2026-09-29: the Policy Changes column
// should say more), shown as the column's first line. afw_policytranpremium rows carry no
// transaction key, so each is assigned to the latest afw_policytransaction entered at or before it —
// the same rule validated for pl_renewal_premium_change. `premium` is the pro-rated amount charged
// for THIS endorsement; the full-term change is this transaction's fulltermpremium per line minus
// that line's latest earlier value. writtenpremium is always 0, and annualizedpremium is only
// populated since ~2026 (and doubled on 6-month terms), so neither is used. Checked against 10 real
// endorsements (2026-09-30), e.g. "Add 2nd Mortgagee" = +$58.34 pro-rated, full-term 5,349 → 5,417.
const TRANSACTION_PREMIUM_QUERY = `
  SELECT tp.polid, tk.tran_entered, tp.lineofbus, sum(tp.premium) AS premium, sum(tp.fulltermpremium) AS fulltermpremium
  FROM afw_policytranpremium tp
  CROSS JOIN LATERAL (
    SELECT coalesce(max(pt.entereddate), tp.entereddate) AS tran_entered
    FROM afw_policytransaction pt
    WHERE pt.polid = tp.polid AND pt.entereddate <= tp.entereddate
  ) tk
  WHERE tp.polid = ANY($1::uuid[])
    AND tp.chargecatpoltp = '1'
  GROUP BY tp.polid, tk.tran_entered, tp.lineofbus
`

// Additional interests (mortgagees, lienholders, loss payees, additional insureds) added, removed or
// with a changed loan number on each transaction — Patrick, 2026-09-29, wanting the Policy Changes
// column to say more; "Update Mortgagee Clause"/"Add 2nd Mortgagee" were blank before. A set diff of
// the active interests (interest label + name with punctuation stripped) just before vs just after
// the transaction's rows, NOT afw_commaddotherint.status: carriers re-send every existing interest as
// 'A' on unrelated endorsements. "Before" is this term's earlier state, else the prior term's final
// state; with neither, it's the first interest image the carrier ever sent ('on_file'). Same txns
// contract and ownership guards as COVERAGE_CHANGE_QUERY. Drafted and validated by the postgres peer
// against all 333 PCH downloads from the prior 30 days (2026-09-30): the known mortgagee/lienholder
// cases all come out right, and 46 of 71 unrelated endorsements that touch interest rows produce
// nothing (most of the rest are a lienholder moving with a replaced vehicle — a real change).
const ADDITIONAL_INTEREST_CHANGE_QUERY = String.raw`
  WITH txns AS (
    SELECT * FROM UNNEST($1::int[], $2::uuid[], $3::timestamp[], $4::timestamp[]) AS t(idx, polid, lower_bound, upper_bound)
  ), owned_rows AS (
    SELECT txns.idx, txns.polid, txns.upper_bound, x.effdate
    FROM txns
    JOIN afw_commaddotherint x ON x.polid = txns.polid AND x.effdate BETWEEN txns.lower_bound AND txns.upper_bound
  ), owned AS (
    SELECT m.idx, m.polid, min(m.effdate) AS first_eff, max(m.effdate) AS last_eff
    FROM owned_rows m
    WHERE NOT EXISTS (
      SELECT 1 FROM txns t2
      WHERE t2.polid = m.polid AND t2.upper_bound < m.upper_bound AND t2.upper_bound >= m.effdate
    )
    AND NOT EXISTS (
      SELECT 1 FROM afw_policytransaction pt2
      WHERE pt2.polid = m.polid AND pt2.source = 'D'
        AND pt2.effdate >= m.effdate AND pt2.effdate < m.upper_bound
    )
    GROUP BY m.idx, m.polid
  ), baseline AS (
    SELECT o.*, bp.priorpolid, st.has_same_term,
      st.has_same_term OR EXISTS (SELECT 1 FROM afw_commaddotherint p WHERE p.polid = bp.priorpolid) AS has_baseline
    FROM owned o
    JOIN afw_basicpolinfo bp ON bp.polid = o.polid
    CROSS JOIN LATERAL (
      SELECT EXISTS (SELECT 1 FROM afw_commaddotherint e WHERE e.polid = o.polid AND e.effdate < o.first_eff) AS has_same_term
    ) st
  ), states AS (
    SELECT b.idx, 'after' AS side, s.polid, s.interest, s.name1, s.attachtype, s.attachid, s.refno
    FROM baseline b
    CROSS JOIN LATERAL (
      SELECT DISTINCT ON (a.lobid, a.caoiid) a.polid, a.lobid, a.caoiid, a.effdate, a.status, a.interest, a.name1, a.attachtype, a.attachid, a.refno
      FROM afw_commaddotherint a
      WHERE a.polid = b.polid AND a.effdate <= b.last_eff
      ORDER BY a.lobid, a.caoiid, a.effdate DESC
    ) s
    WHERE s.status <> 'D'
    UNION ALL
    SELECT b.idx, 'before', s.polid, s.interest, s.name1, s.attachtype, s.attachid, s.refno
    FROM baseline b
    CROSS JOIN LATERAL (
      SELECT DISTINCT ON (a.lobid, a.caoiid) a.polid, a.lobid, a.caoiid, a.effdate, a.status, a.interest, a.name1, a.attachtype, a.attachid, a.refno
      FROM afw_commaddotherint a
      WHERE (b.has_same_term AND a.polid = b.polid AND a.effdate < b.first_eff)
         OR (NOT b.has_same_term AND a.polid = b.priorpolid)
      ORDER BY a.lobid, a.caoiid, a.effdate DESC
    ) s
    WHERE s.status <> 'D'
  ), keyed AS (
    SELECT st.*,
      coalesce(nullif(trim(st.interest), ''), 'Additional interest') AS interest_label,
      upper(regexp_replace(coalesce(st.name1, ''), '[^A-Za-z0-9]+', '', 'g')) AS name_key,
      CASE st.attachtype
        WHEN 121 THEN (SELECT concat_ws(' ', v.vehyear, v.make, v.model) FROM afw_vehicle v WHERE v.polid = st.polid AND v.vehid = st.attachid ORDER BY v.effdate DESC LIMIT 1)
        WHEN 336 THEN (SELECT concat_ws(' ', v.vehyear, v.make, v.model) FROM afw_127vehicle v WHERE v.polid = st.polid AND v.vehdid = st.attachid ORDER BY v.effdate DESC LIMIT 1)
        WHEN 311 THEN (SELECT concat_ws(' ', v.modelyear, v.makemodel) FROM afw_boat v WHERE v.polid = st.polid AND v.boatid = st.attachid ORDER BY v.effdate DESC LIMIT 1)
        WHEN 86 THEN (SELECT concat_ws(', ', l.addr1, l.city) FROM afw_location l WHERE l.polid = st.polid AND l.locid = st.attachid ORDER BY l.effdate DESC LIMIT 1)
      END AS attach_label
    FROM states st
    WHERE trim(coalesce(st.name1, '')) <> ''
  )
  SELECT a.idx,
    CASE WHEN a.side = 'before' THEN 'removed' WHEN b.has_baseline THEN 'added' ELSE 'on_file' END AS change,
    a.interest_label AS interest,
    a.name_key,
    min(trim(a.name1)) AS name,
    string_agg(DISTINCT a.attach_label, ' | ') AS attach_label,
    NULL::text AS detail
  FROM keyed a
  JOIN baseline b ON b.idx = a.idx
  WHERE NOT EXISTS (
    SELECT 1 FROM keyed o
    WHERE o.idx = a.idx AND o.side <> a.side AND o.name_key = a.name_key AND o.interest_label = a.interest_label
  )
  GROUP BY a.idx, a.side, b.has_baseline, a.interest_label, a.name_key
  UNION ALL
  SELECT a.idx, 'updated', a.interest_label, a.name_key, min(trim(a.name1)), string_agg(DISTINCT a.attach_label, ' | '),
    'Loan #: ' || coalesce(min(nullif(trim(o.refno), '')), '(none)') || ' → ' || coalesce(min(nullif(trim(a.refno), '')), '(none)')
  FROM keyed a
  JOIN keyed o ON o.idx = a.idx AND o.side = 'before' AND o.name_key = a.name_key AND o.interest_label = a.interest_label
  WHERE a.side = 'after'
  GROUP BY a.idx, a.interest_label, a.name_key
  HAVING string_agg(DISTINCT upper(regexp_replace(coalesce(a.refno, ''), '[^A-Za-z0-9]+', '', 'g')), ',' ORDER BY upper(regexp_replace(coalesce(a.refno, ''), '[^A-Za-z0-9]+', '', 'g')))
      IS DISTINCT FROM string_agg(DISTINCT upper(regexp_replace(coalesce(o.refno, ''), '[^A-Za-z0-9]+', '', 'g')), ',' ORDER BY upper(regexp_replace(coalesce(o.refno, ''), '[^A-Za-z0-9]+', '', 'g')))
  ORDER BY 1, 2, 3, 5
`

type AdditionalInterestChangeRow = {
  idx: number
  change: "added" | "removed" | "updated" | "on_file"
  interest: string
  name_key: string
  name: string
  attach_label: string | null
  detail: string | null
}

// Named insured / mailing address / email changes on each transaction, from afw_applicant (keyed
// (polid, appid, effdate); appid is stable across renewal terms, so "before" falls back to the prior
// term's version). afw_customer is current-state only, so this is the one historized source. Carriers
// rewrite the applicant on ~85% of endorsements, almost always unchanged, so values are compared as
// normalized word sets (case, punctuation, street abbreviations, zip5; for names also lone initials,
// AND and suffixes), and carrier truncation/cleanup is ignored. Drafted and validated by the postgres
// peer against the same 333 downloads (2026-09-30): 25 produce lines, all real (e.g. "chngd mailing
// address": 54 Shelton Rd, Fayetteville → 703 Forrest Dr, Tullahoma); "Zachary Blanton" → "Zachary T
// Blanton" and the 256 identical rewrites produce nothing.
// Columns are listed explicitly (never a.*): the app's read-only role has a column-level grant on
// afw_applicant that excludes ssn/dob/license, so a wildcard select is refused outright.
const APPLICANT_CHANGE_QUERY = String.raw`
  WITH txns AS (
    SELECT * FROM UNNEST($1::int[], $2::uuid[], $3::timestamp[], $4::timestamp[]) AS t(idx, polid, lower_bound, upper_bound)
  ), owned_rows AS (
    SELECT txns.idx, txns.polid, txns.upper_bound, a.appid, a.effdate
    FROM txns
    JOIN afw_applicant a ON a.polid = txns.polid AND a.effdate BETWEEN txns.lower_bound AND txns.upper_bound
  ), owned AS (
    SELECT m.idx, m.polid, m.appid, min(m.effdate) AS first_eff, max(m.effdate) AS last_eff
    FROM owned_rows m
    WHERE NOT EXISTS (
      SELECT 1 FROM txns t2
      WHERE t2.polid = m.polid AND t2.upper_bound < m.upper_bound AND t2.upper_bound >= m.effdate
    )
    AND NOT EXISTS (
      SELECT 1 FROM afw_policytransaction pt2
      WHERE pt2.polid = m.polid AND pt2.source = 'D'
        AND pt2.effdate >= m.effdate AND pt2.effdate < m.upper_bound
    )
    GROUP BY m.idx, m.polid, m.appid
  ), pairs AS (
    SELECT o.idx, n.*, coalesce(p_same.decnameapp, p_prior.decnameapp) AS decnameapp_before,
      coalesce(p_same.appid, p_prior.appid) AS before_appid,
      CASE WHEN p_same.appid IS NOT NULL THEN p_same.firstname ELSE p_prior.firstname END AS firstname_before,
      CASE WHEN p_same.appid IS NOT NULL THEN p_same.lastname ELSE p_prior.lastname END AS lastname_before,
      CASE WHEN p_same.appid IS NOT NULL THEN p_same.firmnameapp ELSE p_prior.firmnameapp END AS firmnameapp_before,
      CASE WHEN p_same.appid IS NOT NULL THEN p_same.mailaddr1 ELSE p_prior.mailaddr1 END AS mailaddr1_before,
      CASE WHEN p_same.appid IS NOT NULL THEN p_same.mailaddr2 ELSE p_prior.mailaddr2 END AS mailaddr2_before,
      CASE WHEN p_same.appid IS NOT NULL THEN p_same.mailcity ELSE p_prior.mailcity END AS mailcity_before,
      CASE WHEN p_same.appid IS NOT NULL THEN p_same.mailstate ELSE p_prior.mailstate END AS mailstate_before,
      CASE WHEN p_same.appid IS NOT NULL THEN p_same.mailzip ELSE p_prior.mailzip END AS mailzip_before,
      CASE WHEN p_same.appid IS NOT NULL THEN p_same.emailapp ELSE p_prior.emailapp END AS emailapp_before
    FROM owned o
    JOIN afw_basicpolinfo bp ON bp.polid = o.polid
    CROSS JOIN LATERAL (
      SELECT a.appid, a.polid, a.effdate, a.status, a.decnameapp, a.firstname, a.lastname, a.firmnameapp, a.mailaddr1, a.mailaddr2, a.mailcity, a.mailstate, a.mailzip, a.emailapp FROM afw_applicant a
      WHERE a.polid = o.polid AND a.appid = o.appid AND a.effdate <= o.last_eff
      ORDER BY a.effdate DESC LIMIT 1
    ) n
    LEFT JOIN LATERAL (
      SELECT a.appid, a.polid, a.effdate, a.status, a.decnameapp, a.firstname, a.lastname, a.firmnameapp, a.mailaddr1, a.mailaddr2, a.mailcity, a.mailstate, a.mailzip, a.emailapp FROM afw_applicant a
      WHERE a.polid = o.polid AND a.appid = o.appid AND a.effdate < o.first_eff
      ORDER BY a.effdate DESC LIMIT 1
    ) p_same ON true
    LEFT JOIN LATERAL (
      SELECT a.appid, a.polid, a.effdate, a.status, a.decnameapp, a.firstname, a.lastname, a.firmnameapp, a.mailaddr1, a.mailaddr2, a.mailcity, a.mailstate, a.mailzip, a.emailapp FROM afw_applicant a
      WHERE a.polid = bp.priorpolid AND a.appid = o.appid
      ORDER BY a.effdate DESC LIMIT 1
    ) p_prior ON true
    WHERE n.status <> 'D'
  ), vals AS (
    SELECT p.idx, p.appid, v.field, v.before_disp, v.after_disp, v.before_raw, v.after_raw
    FROM pairs p
    CROSS JOIN LATERAL (VALUES
      ('Named insured',
        regexp_replace(regexp_replace(trim(coalesce(nullif(trim(p.decnameapp_before), ''), nullif(trim(p.firmnameapp_before), ''), concat_ws(' ', p.firstname_before, p.lastname_before))), '\s{3,}', ' / ', 'g'), '\s{2}', ' ', 'g'),
        regexp_replace(regexp_replace(trim(coalesce(nullif(trim(p.decnameapp), ''), nullif(trim(p.firmnameapp), ''), concat_ws(' ', p.firstname, p.lastname))), '\s{3,}', ' / ', 'g'), '\s{2}', ' ', 'g'),
        coalesce(nullif(trim(p.decnameapp_before), ''), nullif(trim(p.firmnameapp_before), ''), concat_ws(' ', p.firstname_before, p.lastname_before)),
        coalesce(nullif(trim(p.decnameapp), ''), nullif(trim(p.firmnameapp), ''), concat_ws(' ', p.firstname, p.lastname))),
      ('Mailing address',
        concat_ws(', ', nullif(trim(regexp_replace(p.mailaddr1_before, '\s+', ' ', 'g')), ''), nullif(nullif(trim(regexp_replace(p.mailaddr2_before, '\s+', ' ', 'g')), ''), trim(regexp_replace(p.mailaddr1_before, '\s+', ' ', 'g'))), nullif(trim(p.mailcity_before), ''))
          || coalesce(' ' || nullif(trim(p.mailstate_before), ''), '') || coalesce(' ' || left(nullif(trim(p.mailzip_before), ''), 5), ''),
        concat_ws(', ', nullif(trim(regexp_replace(p.mailaddr1, '\s+', ' ', 'g')), ''), nullif(nullif(trim(regexp_replace(p.mailaddr2, '\s+', ' ', 'g')), ''), trim(regexp_replace(p.mailaddr1, '\s+', ' ', 'g'))), nullif(trim(p.mailcity), ''))
          || coalesce(' ' || nullif(trim(p.mailstate), ''), '') || coalesce(' ' || left(nullif(trim(p.mailzip), ''), 5), ''),
        concat_ws(' ', p.mailaddr1_before, p.mailaddr2_before, p.mailcity_before, p.mailstate_before, left(p.mailzip_before, 5)),
        concat_ws(' ', p.mailaddr1, p.mailaddr2, p.mailcity, p.mailstate, left(p.mailzip, 5))),
      ('Email', lower(trim(p.emailapp_before)), lower(trim(p.emailapp)), lower(trim(p.emailapp_before)), lower(trim(p.emailapp)))
    ) v(field, before_disp, after_disp, before_raw, after_raw)
    WHERE p.before_appid IS NOT NULL
  ), tokens AS (
    SELECT v.idx, v.appid, v.field, side.side,
      array(
        SELECT DISTINCT coalesce(m.abbr, u.tok)
        FROM unnest(regexp_split_to_array(trim(regexp_replace(regexp_replace(upper(coalesce(side.raw, '')), 'P\s*\.?\s*O\.?\s*BOX', 'POBOX', 'g'), '[^A-Z0-9]+', ' ', 'g')), ' ')) u(tok)
        LEFT JOIN (VALUES ('AVENUE','AVE'),('STREET','ST'),('DRIVE','DR'),('ROAD','RD'),('LANE','LN'),('COURT','CT'),
          ('CIRCLE','CIR'),('BOULEVARD','BLVD'),('PLACE','PL'),('TRACE','TRCE'),('PARKWAY','PKWY'),('HIGHWAY','HWY'),
          ('TERRACE','TER'),('SQUARE','SQ'),('POINT','PT'),('NORTH','N'),('SOUTH','S'),('EAST','E'),('WEST','W'),
          ('APARTMENT','APT'),('SUITE','STE'),('UNIT','APT')) m(full_word, abbr)
          ON m.full_word = u.tok AND v.field = 'Mailing address'
        WHERE u.tok <> ''
          AND NOT (v.field = 'Named insured' AND (length(u.tok) = 1 OR u.tok IN ('AND', 'JR', 'SR', 'II', 'III', 'IV')))
      ) AS words
    FROM vals v
    CROSS JOIN LATERAL (VALUES ('before', v.before_raw), ('after', v.after_raw)) side(side, raw)
  )
  SELECT v.idx, v.field, v.before_disp AS before, v.after_disp AS after
  FROM vals v
  JOIN tokens tb ON tb.idx = v.idx AND tb.appid = v.appid AND tb.field = v.field AND tb.side = 'before'
  JOIN tokens ta ON ta.idx = v.idx AND ta.appid = v.appid AND ta.field = v.field AND ta.side = 'after'
  CROSS JOIN LATERAL (
    SELECT upper(regexp_replace(coalesce(v.before_raw, ''), '[^A-Za-z0-9]+', '', 'g')) AS b,
           upper(regexp_replace(coalesce(v.after_raw, ''), '[^A-Za-z0-9]+', '', 'g')) AS a
  ) flat
  WHERE NOT (tb.words @> ta.words AND ta.words @> tb.words)
    AND (v.field <> 'Email' OR coalesce(v.after_raw, '') <> '')
    AND NOT (v.field = 'Named insured' AND abs(length(flat.a) - length(flat.b)) <= 4
             AND (flat.a LIKE flat.b || '%' OR flat.b LIKE flat.a || '%'))
    AND NOT (v.field = 'Mailing address' AND tb.words @> ta.words
             AND NOT EXISTS (SELECT 1 FROM unnest(tb.words) w WHERE w <> ALL (ta.words) AND w ~ '[0-9]'))
  ORDER BY v.idx, v.field
`

type ApplicantChangeRow = { idx: number; field: "Named insured" | "Mailing address" | "Email"; before: string | null; after: string | null }

// An interest that was already on file before this term's first interest image isn't "added" — it's
// only worth showing when the carrier's own description is about an interest (about half of these
// first images are "Added Trust"/"lienholder added"; the rest ride along on "Enrolled in Paperless").
const INTEREST_DESCRIPTION_PATTERN = /mort|mtg|lien|loss ?payee|\bai\b|add'?l|additional|interest|trust|escrow|lender|bank/i

function summarizeInterestChanges(rawRows: Omit<AdditionalInterestChangeRow, "idx">[], description: string): string | null {
  // Carriers pad interest names with runs of spaces ("Pennymac Loan Services LLC    Its Successors").
  const tidy = (v: string | null) => (v === null ? null : v.replace(/\s+/g, " ").trim())
  const rows = rawRows.map((r) => ({ ...r, name: tidy(r.name) ?? "", interest: tidy(r.interest) ?? "", attach_label: tidy(r.attach_label) }))
  const lines: string[] = []
  const on = (r: { attach_label: string | null }) => (r.attach_label ? ` on ${ r.attach_label }` : "")
  const removed = rows.filter((r) => r.change === "removed")
  const usedRemovals = new Set<typeof rows[number]>()

  for(const row of rows) {
    if(row.change === "added") {
      // Only the interest label changed ("Loss payee" → "Loss Payee & Addl Insured") — one line, not add + remove.
      const relabel = removed.find((r) => r.name_key === row.name_key && !usedRemovals.has(r))
      if(relabel) {
        usedRemovals.add(relabel)
        lines.push(`${ row.name }: ${ relabel.interest } → ${ row.interest }${ on(row) }`)
      } else {
        lines.push(`Added ${ row.interest }: ${ row.name }${ on(row) }`)
      }
    } else if(row.change === "updated") {
      lines.push(`${ row.interest } ${ row.name }${ on(row) }: ${ row.detail }`)
    } else if(row.change === "on_file" && INTEREST_DESCRIPTION_PATTERN.test(description)) {
      lines.push(`${ row.interest } on file: ${ row.name }${ on(row) }`)
    }
  }
  for(const row of removed) {
    if(!usedRemovals.has(row)) lines.push(`Removed ${ row.interest }: ${ row.name }${ on(row) }`)
  }

  return lines.length ? lines.join("; ") : null
}

function summarizeApplicantChanges(rows: Omit<ApplicantChangeRow, "idx">[]): string | null {
  const lines = rows.map((r) => `${ r.field }: ${ r.before || "none" } → ${ r.after || "none" }`)
  return lines.length ? [...new Set(lines)].join("; ") : null
}

// Only endorsement-style downloads get a premium line. A renewal, renewal quote, new business,
// rewrite or reissue is a whole-term image (a renewal compared against its own renewal-quote rows
// read "+$536.00 (full-term -$62.00)", 2026-09-30), and a sync carries no client-facing change.
const PREMIUM_LINE_TRANTYPES = new Set(["PCH", "XLC", "REI", "PAB"])

type TransactionPremiumRow = { polid: string; tran_entered: string; lineofbus: string | null; premium: string | number | null; fulltermpremium: string | number | null }

function signedMoney(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return `${ rounded < 0 ? "-" : "+" }$${ Math.abs(rounded).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }`
}

// Null when the transaction has no premium rows, or none earlier on this term to compare against
// (a new business/renewal/rewrite first image — its premium is the whole term, not a change).
function summarizePremiumChange(polidRows: TransactionPremiumRow[], enteredAt: string): string | null {
  const at = new Date(enteredAt).getTime()
  const current = polidRows.filter((r) => new Date(r.tran_entered).getTime() === at)
  const earlier = polidRows.filter((r) => new Date(r.tran_entered).getTime() < at)
  if(current.length === 0 || earlier.length === 0) return null

  const num = (v: string | number | null) => Number(v ?? 0) || 0
  const prorated = current.reduce((sum, r) => sum + num(r.premium), 0)
  let comparable = true
  const fullTermChange = current.reduce((sum, r) => {
    const prior = earlier
      .filter((e) => e.lineofbus === r.lineofbus)
      .sort((a, b) => new Date(b.tran_entered).getTime() - new Date(a.tran_entered).getTime())[0]
    // A line with nothing earlier (or only a $0 placeholder, common on commercial packages) can't
    // give a full-term change — one such case read "full-term +$65,115" on an $884 endorsement.
    if(!prior || (num(prior.fulltermpremium) === 0 && num(r.fulltermpremium) !== 0)) comparable = false
    return sum + num(r.fulltermpremium) - (prior ? num(prior.fulltermpremium) : 0)
  }, 0)

  if(Math.abs(prorated) < 0.005 && (!comparable || Math.abs(fullTermChange) < 0.005)) return "No premium change"
  return comparable
    ? `Premium: ${ signedMoney(prorated) } (full-term ${ signedMoney(fullTermChange) })`
    : `Premium: ${ signedMoney(prorated) }`
}

type PolicyTransactionRow = {
  trantype: string
  description: string
  effdate: string
  changeddate: string
  entereddate: string
  polid: string
  custid: string
  policy_no: string
  line_of_business: string | null
  carrier_name: string | null
  csrcode: string | null
  rep_name: string | null
  customer_name: string | null
  // Set only for a row synthesized from MISSING_DOWNLOAD_TRANSACTION_QUERY (afw_transaction, not
  // afw_policytransaction) — lets the item-building step add a note explaining why this item has no
  // backing policy-transaction record, without a second parallel code path through clusterRepeats/
  // foldCrossTermEchoes/the vehicle-coverage change_detail correlation, all of which apply just as
  // well to these rows since they carry a real polid/effdate too.
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

type CandidateActivityRow = { polid: string; activity_date: string; entereddate: string; commenttran: string | null }

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
  cross_term_echo_count?: number
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

// `foldStaleReplays` — a fold for a second, distinct AMS360-side glitch from clusterRepeats'
// exact-duplicate rewrite (discovered from client feedback 2026-09-03: "it looks like it's pulling
// ALL the changes for that policy throughout the policy year") — lived here and was removed
// 2026-09-11, superseded by switching this report's window bind from `changeddate` to `entereddate`
// (see the comment above POLICY_TRANSACTION_QUERY). Its whole premise was that AMS360 re-stamps
// `changeddate` on old rows without touching their `entereddate`, so a `changeddate`-windowed report
// would catch a whole term's history in one batch and need this fold to collapse it back down.
// Confirmed empirically dead post-switch (2026-09-11): 0 folds fired across 313 items spanning 10
// report windows over the full available dataset range, vs. `foldCrossTermEchoes` (a genuinely
// different problem — real distinct rows, not a `changeddate` artifact) still firing 7 times in the
// same sweep. Not a coincidence: under `entereddate` windowing, the rows this fold used to catch
// (old `entereddate`, freshly-bumped `changeddate`) simply aren't selected into a later day's report
// at all anymore, so there's nothing left to fold. If this project ever needs it again — e.g. a
// future column stops being as `entereddate`-stable as `afw_policytransaction` was confirmed to be
// (70.7% of source='D' rows show a real `changeddate`-`entereddate` gap, 38.4% by more than 30 days,
// across 6,434 distinct policies) — the removed implementation is in git history (this file, before
// this commit).

// A second, distinct AMS360/carrier-side glitch from clusterRepeats' exact-rewrite above: a
// carrier's overnight EDI feed can transmit one real-world edit *twice* when it lands right at a
// policy's term-rollover boundary — once as a
// plain "policy change" image against the *closing* term, and again folded into the "renewal"
// image against the *new* term (since the new term's declarations already reflect the edit).
// `afw_basicpolinfo` mints a brand-new `polid` every renewal term for the same `polno`, so AMS360's
// sync materializes both as real, independent `afw_policytransaction` rows — genuinely distinct
// (polid, effdate) primary keys, not literal duplicate rows — carrying identical `description` text,
// entered within the same overnight sync batch, but weeks apart on `effdate` (however long the
// remaining term was). Confirmed via `afw_transaction`: the staff note behind the edit exists
// exactly once, filed against the *new* term's polid (e.g. "Added Tiffany's daughter Raquel Blue
// Rooney. Sent dec page. Follow up for DNLD.") — Cincinnati echoed it as two separate carrier
// messages, seconds apart, with distinct carrier reference numbers, one a "PCH" against the closing
// term and one an "RWL"-bundled "PCH" against the new term. Confirmed systemic book-wide via direct
// query against synced data: 611 same-sync-batch (`entereddate` within minutes of each other) pairs
// across 294 distinct policies, `source='D'` only.
//
// `clusterRepeats` (same `polid`, `effdate`-window) can't catch this — it keys on a single `polid`,
// and this pattern spans two different `polid` values by design. This runs *after* it (on its
// output) and groups by `(custid, policy_no, description)` instead — a policy's own number is
// stable across its renewal terms even though its `polid` isn't. Within a group, rows are chained
// by `entereddate` proximity (same "one sync batch" logic `clusterRepeats` already uses, just keyed
// on `entereddate` instead of `effdate`, since `effdate` itself is expected to differ by design
// here — confirmed the anchor should be the newer term's own row, since that's where the real staff
// note is actually filed). A chain only folds when it spans more than one `polid`: a same-`polid`
// chain this late in the pipeline is two genuinely distinct real transactions on the very same term
// that happen to share boilerplate description text (e.g. a generic "Policy change" reused weeks
// apart) — not an echo — and must be left alone rather than merged.
const CROSS_TERM_SYNC_BATCH_MS = 5 * 60_000

type CrossTermEchoInfo = { count: number; olderEffdates: string[] }

function foldCrossTermEchoes(
  clusters: { row: PolicyTransactionRow; repeatCount: number }[]
): { kept: { row: PolicyTransactionRow; repeatCount: number }[]; echoByKey: Map<string, CrossTermEchoInfo> } {
  const groups = new Map<string, { row: PolicyTransactionRow; repeatCount: number }[]>()

  for(const item of clusters) {
    const key = `${ item.row.custid }||${ item.row.policy_no }||${ item.row.description }`
    const group = groups.get(key)

    if(group) group.push(item)
    else groups.set(key, [item])
  }

  const kept: { row: PolicyTransactionRow; repeatCount: number }[] = []
  const echoByKey = new Map<string, CrossTermEchoInfo>()

  for(const group of groups.values()) {
    if(group.length === 1) {
      kept.push(group[0])
      continue
    }

    const sorted = [...group].sort((a, b) => new Date(a.row.entereddate).getTime() - new Date(b.row.entereddate).getTime())
    let chainStart = 0

    for(let i = 1; i <= sorted.length; i++) {
      const gap = i < sorted.length
        ? new Date(sorted[i].row.entereddate).getTime() - new Date(sorted[i - 1].row.entereddate).getTime()
        : Infinity

      if(gap > CROSS_TERM_SYNC_BATCH_MS) {
        const chain = sorted.slice(chainStart, i)
        const distinctPolids = new Set(chain.map((c) => c.row.polid))

        if(distinctPolids.size === 1) {
          kept.push(...chain)
        } else {
          const anchor = chain.reduce((a, b) => (new Date(b.row.effdate).getTime() > new Date(a.row.effdate).getTime() ? b : a))
          const others = chain.filter((c) => c !== anchor)

          kept.push(anchor)
          echoByKey.set(`${ anchor.row.polid }||${ anchor.row.effdate }`, {
            count: others.length,
            olderEffdates: others.map((o) => o.row.effdate).sort()
          })
        }

        chainStart = i
      }
    }
  }

  return { kept, echoByKey }
}

type InternalItem = Omit<ReportItem, "item_id"> & { csrcode: string | null; rep_name: string | null; polid?: string }

export function registerDownloadReportTool(server: McpServer) {
  server.registerTool(
    "download_report",
    {
      description: "Boxwood's daily \"Download Report\" — the overnight carrier-download review each rep does every morning, rebuilt from synced AMS360 data instead of AMS360's own exported report. Returns policy transactions and claims that came down from carriers overnight, normalized into plain-language action items and grouped by representative (CSR). RESPONSE SHAPE — this returns a compact result, not the full dataset: the full item list (every rep's routine AND flagged items, with every field) is written to a 24h link (`report_url`) instead of being embedded inline, to keep this response small on a busy day. The inline `reps[].flagged_items` only includes items where `flagged: true`, trimmed to just what judging accuracy requires (`item_id`, `customer_name`, `policy_no`, `what_happened`, `repeat_count`, and up to 3 most-recent `candidate_prior_activity` notes, each capped to 240 characters) — routine items are represented solely by `reps[].summary` counts, and flagged items' other fields (carrier_name, detail, next_step, ...) live only in the full dataset behind the link. Save `report_token` (the same value as the last path segment of `report_url`): pass it to `download_report_workbook` to build the finished worksheet from the *full* dataset (not just the flagged subset you saw here). IMPORTANT — this is a data-synthesis step only, not the finished worksheet: (1) `flagged` means \"this category is one a client could plausibly have requested something about\" (policy change/cancellation/rewrite/reinstatement/reissue/new business) — it is NOT AMS360's native [WARNING]/GROUP REJECT flag from its live download-processing log, which isn't replicated into any table this MCP can query and so cannot be reproduced here; (2) flagged items include `candidate_prior_activity` (recent staff notes on that policy) but NO verdict — deciding whether the download actually matches a documented client request requires reading those notes and judging, which is a separate reasoning step, not something this tool computes; (3) claims reflect only their current state — AMS360's own report can show a claim re-downloaded multiple times in one night (an \"x2/x3 overnight\" note), but that per-event history isn't stored in these tables, so no repeat-count is reported for claims; (4) policy transactions ARE collapsed when AMS360's download processor writes the same transaction (same policy/type/description) several times in quick succession — a confirmed, ongoing AMS360-side glitch, not a client action — into one item, so 12 identical rows read as 1 client-relevant event, not 12 separate requests; a 2-row repeat merges quietly (common enough — ~78% of these — to be unremarkable on its own), but 3+ is surfaced via `repeat_count` and called a repeated transaction, since that pattern is rare enough to be worth a second look. It is NOT necessarily harmless: no synced table records whether a transaction actually applied (isposted/isuploaded were checked and don't track this), so a repeated transaction can equally mean AMS360 kept retrying something that kept failing (e.g. a GROUP REJECT loop) — `next_step` calls this out for any item with a `repeat_count` and the rep should verify directly in AMS360 rather than assume it's cosmetic. (5) `change_detail` (client-requested 2026-09-02, broadened 2026-09-02 from a vehicle-only field per follow-up feedback, expanded 2026-09-30) is the rep-facing \"Policy Changes\" column. On a policy change, cancellation, reinstatement or premium audit it starts with the premium impact (\"Premium: +$58.34 (full-term +$68.00)\" or \"No premium change\"), then vehicles added/removed with their own coverages folded in, then additional interests (mortgagee/lienholder/loss payee/additional insured added or removed, loan number changed), then named insured/mailing address/email changes, then coverage changes. Coverage re-sent unchanged under a new id doesn't count, and a carrier's first image of a policy's coverages reads \"Coverage detail first received from carrier\". It spells out the concrete specifics of what changed on a policy transaction, across every line of business — not just AMS360's terse transaction description. Two independent signals are merged into this one field, semicolon-joined when both fire on the same transaction: vehicle adds/removals with VIN (e.g. \"Added: 2019 FORD F-150 SUPERCREW RAPTOR (VIN 1FTFW1RG5KFC53281); Removed: 2013 FORD F-150 SUPERCREW (VIN 1FTFW1ET3DKE56229)\" for a vehicle replacement — Personal and Commercial Auto, `afw_vehicle`/`afw_127vehicle`), and coverage/limit/deductible adds, removals, and value changes for any line of business (e.g. \"Dwelling limit: $850,000 → $899,000; Other Structures limit: $170,000 → $179,800\" for a homeowners coverage bump, or \"Added coverage: Water Backup of Sewers & Drains ($50,000)\" for a new endorsement — `afw_coverage`). Both are correlated to the specific transaction (not just the policy) even when several related transactions land seconds apart on the same policy in one overnight batch. Null whenever a transaction has neither kind of activity — most transactions, including ones with `detail` text that already mentions a vehicle or coverage (e.g. a plain premium change), will have this as null; don't read null as \"nothing changed,\" only as \"nothing this field tracks changed on this specific transaction.\" Deliberately does not report a vehicle that was merely edited in place (e.g. renumbered when a sibling vehicle was added/removed) or a coverage row rewritten with identical values (AMS360 rewrites every active coverage on any coverage-related download, not just the one that changed) — only clear adds/removals/value-changes, since AMS360's audit trail can't reliably distinguish a real edit from an incidental side-effect touch. `change_detail` only ever attributes a vehicle/coverage row to a transaction actually present in the current call's own window — if that row's true owning transaction was already downloaded and reported on an earlier call, this attribution correctly excludes the row entirely (verified against real data) rather than misattributing it to whatever unrelated transaction happens to be nearby in this call. Coverage limit/deductible comparisons also look up each coverage line's prior value across the policy's full renewal history (not just its current term), since AMS360 gives a policy a new internal term id every renewal but keeps the same coverage-line id — so a renewal's own first-of-term snapshot correctly compares against its real prior value instead of reading every limit as newly added. (6) `effective_date` on a policy_transaction item is that specific transaction's own effdate (when the change took effect), not the policy's own poleffdate/polexpdate — always null on a claim item, since claims have no equivalent field. (7) `missing_transaction_record` (client-requested 2026-09-03: \"if a new row is inserted into afw_transaction by a carrier download we want to see that tx ... even if there is no policy change detected\") surfaces a carrier download that never got its own row in AMS360's policy-transaction table at all — afw_policytransaction only keeps the latest write per (policy, effective date), so when two downloads land on the same key close together, the earlier one's content is otherwise invisible to this report. These items are built from afw_transaction's own raw processing-log text instead (its `detail` is AMS360's cleaned-up commenttran narrative, e.g. \"Download updated the writing company from Hartford Property & Casualty to Hartford Insurance Group\" or a vehicle's discount change) — `categorized`/`flagged`/`change_detail`/`repeat_count` all still apply normally on top, since these items carry a real policy and effective date same as any other. `next_step` names this explicitly so a rep isn't confused why an item has unusual detail text. (8) `cross_term_echo_count` (found investigating client-requested duplicate-reduction 2026-09-11) covers a second, distinct glitch from repeat_count above, this one carrier-side rather than purely AMS360-side: a carrier's overnight feed can transmit one real edit twice right at a policy's term-rollover boundary — once as a plain policy-change image against the closing term, once folded into the renewal image against the new term — and since AMS360 mints a brand-new polid every renewal term, these land as two genuinely distinct policy-transaction rows (not literal duplicates) with identical description text, in the same sync batch, weeks apart on effdate. Confirmed via real data the underlying staff request was only ever entered once. `clusterRepeats` can't catch this since it keys on a single polid; this folds the closing-term echo into the new-term item instead (same policy number, matching description, same sync batch) and reports how many were folded plus their original effective date(s) in `next_step` — the rep should treat it as the same request already seen elsewhere, not a second one, unless something looks off. (9) `since`/`until` bind against each row's own `entereddate` (client-requested 2026-09-11, after staff reported transactions being \"flagged as not on [today's] report\" but actually downloaded days earlier) — not `changeddate`, which AMS360 re-touches on a large share of rows well after real entry (confirmed at scale: 70.7% of source='D' policy-transaction rows show a real changeddate-entereddate gap, 38.4% by more than 30 days, across thousands of distinct policies) — so a transaction's report day no longer silently drifts to whatever day something unrelated last touched it. This is unrelated to `repeat_count`/`cross_term_echo_count` above, which catch genuinely duplicated or miscounted content within an already-correctly-selected transaction, not which day it's selected into. (10) `synced_since` (client-requested 2026-09-19, after a 2026-09-17 batch that synced a full day late fell into the gap between two consecutive entereddate windows and was never reported at all) is a separate, additive bound on top of since/until — see its own field description for the mechanism. Ordinary callers should leave it unset; scripts/morningDownload.ts's persisted watermark is the intended user of it. (11) `sync_metadata` (`tables_touched`, the synced tables that actually contributed a row this call, and `rows_entered`, their total row count) reports what this call actually pulled off Postgres, before any downstream merging/collapsing (repeat clustering, cross-term echo folding) changes how many distinct items the report ends up showing — scripts/morningDownload.ts records both alongside the watermark boundary it advances, so a run that succeeds but quietly touched nothing is visible without digging up that day's report separately.",
      inputSchema: {
        since: z.string().describe('Start of window: agency-local timestamp ("2026-08-28T08:00") or relative shorthand ("24h", "7d"). Defaults to the most recent 8am agency-local sync cutoff, minus 24h — i.e. the 8am-to-8am span ending at the last completed overnight sync (minus 72h on a Monday, reaching back to Friday 8am, since no report runs Sat/Sun)').optional(),
        until: z.string().describe("End of window, same format as since. Defaults to the most recent 8am agency-local sync cutoff (or yesterday's 8am, if today's hasn't happened yet) — a firm boundary, not \"now\", since the AMS360 ETL sync doesn't reliably finish pulling overnight carrier activity until shortly after 7:30am, and the report script itself doesn't run until 8am").optional(),
        csr_code: z.string().describe("Scope to one representative (exact match against afw_customer.csrcode, the customer's header CSR — not afw_basicpolinfo's per-policy CSR field, which can diverge)").optional(),
        lookback_days: z.number().int().min(1).max(365).default(30).describe("How far back (in days, from when each flagged download was entered) to search for candidate staff activity notes. Defaults to 30 — Patrick, 2026-09-29: activity older than that shouldn't be tied to today's download"),
        synced_since: z.string().describe("Advanced/automation use — a true UTC instant (plain ISO-8601, e.g. \"2026-09-17T13:01:00.000Z\"; NOT agency-local like since/until). When set, only includes rows whose synced_at (when this MCP's own ETL first ingested the row, genuinely immutable after insert) is at or after this instant, on top of the normal since/until entereddate window. Exists because entereddate reflects AMS360's own write time, not when the row reached this database — a row can be entered in AMS360 before since/until's lower bound yet not actually sync into Postgres until after a prior day's report already ran, in which case an entereddate-only window can never include it again. scripts/morningDownload.ts uses this to drive a persisted watermark (see src/utils/downloadReportWatermark.ts) so a late-syncing row still gets reported on the next run instead of silently falling into the gap between two windows.").optional()
      }
    },
    async ({ since, until, csr_code, lookback_days, synced_since }) => {
      try {
        const defaultWindow = mostRecentAgencySyncWindow()
        const sinceDate = resolveWindowBound(since, () => defaultWindow.since)
        const untilDate = resolveWindowBound(until, () => defaultWindow.until)
        const csrParam = csr_code ?? null
        // Genuine UTC (see synced_at's own description above) — parsed directly, not run through
        // resolveWindowBound's agency-local reinterpretation like since/until/entereddate are.
        const syncedSinceDate = synced_since ? new Date(synced_since) : null

        const [transactionRows, claimRows, missingDownloadRows] = await Promise.all([
          runReadOnlyQuery(POLICY_TRANSACTION_QUERY, [sinceDate, untilDate, csrParam, syncedSinceDate]) as Promise<PolicyTransactionRow[]>,
          runReadOnlyQuery(CLAIM_QUERY, [sinceDate, untilDate, csrParam, syncedSinceDate]) as Promise<ClaimRow[]>,
          runReadOnlyQuery(MISSING_DOWNLOAD_TRANSACTION_QUERY, [sinceDate, untilDate, csrParam, syncedSinceDate]) as Promise<MissingDownloadTransactionRow[]>
        ])

        // Tallied here, off the raw query results, rather than derived later from item counts —
        // a row can be dropped or merged downstream (foldCrossTermEchoes, missing-download
        // reshaping into transaction items) without ever having failed to come off its source
        // table. sync_metadata (below) reports what was actually pulled this call, for
        // scripts/morningDownload.ts's persisted watermark (src/utils/downloadReportWatermark.ts)
        // to record alongside the boundary it advances.
        const tablesTouched = new Set<string>()
        let rowsEntered = 0
        const tallyTable = (table: string, rows: unknown[]) => {
          if(rows.length === 0) return
          tablesTouched.add(table)
          rowsEntered += rows.length
        }
        tallyTable("afw_policytransaction", transactionRows)
        tallyTable("afw_claim", claimRows)
        tallyTable("afw_transaction", missingDownloadRows)

        // Reshaped into PolicyTransactionRow so every downstream step (repeat clustering, stale-
        // replay folding, vehicle/coverage change_detail correlation, categorization, flagging) just
        // works on these the same as a real afw_policytransaction row — they carry a real
        // polid/effdate, the only things that machinery actually needs.
        const missingDownloadAsTransactionRows: PolicyTransactionRow[] = missingDownloadRows.map((row) => ({
          trantype: row.trantype,
          description: formatMissingDownloadDetail(row.commenttran),
          effdate: row.effdate,
          changeddate: row.changeddate,
          entereddate: row.entereddate,
          polid: row.polid,
          custid: row.custid,
          policy_no: row.policy_no,
          line_of_business: row.line_of_business,
          carrier_name: row.carrier_name,
          csrcode: row.csrcode,
          rep_name: row.rep_name,
          customer_name: row.customer_name,
          missingRecord: true
        }))

        const { kept: echoFoldedClusters, echoByKey } = foldCrossTermEchoes(clusterRepeats([...transactionRows, ...missingDownloadAsTransactionRows]))
        const canonicalRows = echoFoldedClusters.map((c) => c.row)

        const transactionItems: InternalItem[] = echoFoldedClusters.map(({ row, repeatCount }) => {
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

          const crossTermEcho = echoByKey.get(`${ row.polid }||${ row.effdate }`)
          const nextStepWithEchoWarning = crossTermEcho
            ? `${ nextStepWithRepeatWarning } AMS360 also transmitted this same change against this policy's prior term (originally effective ${ crossTermEcho.olderEffdates.map((d) => d.slice(0, 10)).join(", ") }) — carriers can echo one real edit against both the closing and new term at renewal, so that's very likely the same request, not a second one, unless something looks off.`
            : nextStepWithRepeatWarning

          // See MISSING_DOWNLOAD_TRANSACTION_QUERY — this item has no backing afw_policytransaction
          // row at all (a later download reused its exact key first), so its detail comes from
          // AMS360's raw processing log instead; worth telling the rep that up front.
          const finalNextStep = row.missingRecord
            ? `${ nextStepWithEchoWarning } This download has no corresponding entry in AMS360's policy-transaction table — a later download reused the same effective date before this one could be recorded on its own, so the detail above comes from AMS360's raw processing log. Verify directly in AMS360 if anything here needs action.`
            : nextStepWithEchoWarning

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
            cross_term_echo_count: crossTermEcho?.count,
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

          const [vehicleChangeRows, coverageChangeRows, premiumRows, interestChangeRows, applicantChangeRows] = await Promise.all([
            runReadOnlyQuery(VEHICLE_CHANGE_QUERY, [idxs, polids, lowerBounds, upperBounds]) as Promise<VehicleChangeRow[]>,
            runReadOnlyQuery(COVERAGE_CHANGE_QUERY, [idxs, polids, lowerBounds, upperBounds]) as Promise<CoverageChangeRow[]>,
            runReadOnlyQuery(TRANSACTION_PREMIUM_QUERY, [[...new Set(polids)]]) as Promise<TransactionPremiumRow[]>,
            runReadOnlyQuery(ADDITIONAL_INTEREST_CHANGE_QUERY, [idxs, polids, lowerBounds, upperBounds]) as Promise<AdditionalInterestChangeRow[]>,
            runReadOnlyQuery(APPLICANT_CHANGE_QUERY, [idxs, polids, lowerBounds, upperBounds]) as Promise<ApplicantChangeRow[]>
          ])

          // VEHICLE_CHANGE_QUERY UNIONs afw_vehicle and afw_127vehicle with no table-of-origin
          // column in its result, so a combined row can't be attributed back to one table or the
          // other — both are marked touched whenever any row comes back.
          if(vehicleChangeRows.length > 0) {
            tablesTouched.add("afw_vehicle")
            tablesTouched.add("afw_127vehicle")
            rowsEntered += vehicleChangeRows.length
          }
          tallyTable("afw_coverage", coverageChangeRows)
          tallyTable("afw_policytranpremium", premiumRows)
          tallyTable("afw_commaddotherint", interestChangeRows)
          tallyTable("afw_applicant", applicantChangeRows)
          const premiumRowsByPolid = groupByKey(premiumRows, "polid")
          const byIdx = <T extends { idx: number }>(rows: T[]) => {
            const map = new Map<number, T[]>()
            for(const row of rows) map.set(row.idx, [...(map.get(row.idx) ?? []), row])
            return map
          }
          const interestChangesByIdx = byIdx(interestChangeRows)
          const applicantChangesByIdx = byIdx(applicantChangeRows)

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

          // Premium impact, vehicle adds/removes (with VIN) and coverage adds/removes/limit changes
          // are independent signals about the same underlying transaction — merged into one field
          // since the client's ask ("specifics of what changed") doesn't distinguish between them,
          // with the premium line first (Andrew, 2026-09-30), so a rep never has to check two columns.
          for(const [index, item] of transactionItems.entries()) {
            const vehicleLines = summarizeVehicleChanges(vehicleChangesByIdx.get(index) ?? [])
            const coverage = summarizeCoverageChanges(coverageChangesByIdx.get(index) ?? [], new Set(vehicleLines.flatMap((l) => l.unitIds)))
            const row = canonicalRows[index]
            const premium = row.missingRecord || !PREMIUM_LINE_TRANTYPES.has(row.trantype) ? null : summarizePremiumChange(premiumRowsByPolid.get(row.polid) ?? [], row.entereddate)

            const interests = summarizeInterestChanges(interestChangesByIdx.get(index) ?? [], row.description ?? "")
            const applicant = summarizeApplicantChanges(applicantChangesByIdx.get(index) ?? [])

            item.change_detail = [premium, vehicleSummaryText(vehicleLines, coverage.foldedByUnit), interests, applicant, coverageSummaryText(coverage)]
              .filter((s): s is string => s !== null).join("; ") || null
          }
        }

        const flaggedTransactions = canonicalRows.filter((_, i) => transactionItems[i].flagged)

        let candidatesByPolid = new Map<string, CandidateActivityRow[]>()

        if(flaggedTransactions.length > 0) {
          const polids = [...new Set(flaggedTransactions.map((row) => row.polid))]
          const earliestNeeded = new Date(Math.min(...flaggedTransactions.map((row) => new Date(row.entereddate).getTime())) - lookback_days * 86_400_000)
          const latestNeeded = new Date(Math.max(...flaggedTransactions.map((row) => new Date(row.entereddate).getTime())))

          const candidateRows = await runReadOnlyQuery(CANDIDATE_ACTIVITY_QUERY, [polids, earliestNeeded, latestNeeded]) as CandidateActivityRow[]

          candidatesByPolid = groupByKey(candidateRows, "polid")
        }

        for(const [index, row] of canonicalRows.entries()) {
          const item = transactionItems[index]

          if(!item.flagged) continue

          const windowStart = new Date(row.entereddate).getTime() - lookback_days * 86_400_000
          const windowEnd = new Date(row.entereddate).getTime()

          const candidates = (candidatesByPolid.get(row.polid) ?? [])
            .filter((c) => new Date(c.activity_date).getTime() >= windowStart && new Date(c.entereddate).getTime() <= windowEnd)
            .slice(0, CANDIDATE_LIMIT_PER_ITEM)
            .map((c) => ({ date: c.activity_date, note: c.commenttran ?? "" }))

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
        const window = {
          since: formatTimestampColumn(sinceDate, "since"),
          until: formatTimestampColumn(untilDate, "until"),
          // Echoed as a plain UTC ISO string, not through formatTimestampColumn's agency-local
          // reinterpret path — synced_at (and therefore this bound) is a true instant, unlike
          // since/until above.
          synced_since: syncedSinceDate ? syncedSinceDate.toISOString() : null
        }

        const syncMetadata = {
          tables_touched: [...tablesTouched].sort(),
          rows_entered: rowsEntered
        }

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
          cross_term_echo_count: item.cross_term_echo_count,
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
          sync_metadata: syncMetadata,
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
        logger.error({ err: error, since, until, csr_code, lookback_days, synced_since }, "download_report failed")
        return errorResult(error)
      }
    }
  )
}
