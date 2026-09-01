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
  detail: string | null
  next_step: string
  flagged: boolean
  repeat_count?: number
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

type InternalItem = Omit<ReportItem, "item_id"> & { csrcode: string | null; rep_name: string | null; polid?: string }

export function registerDownloadReportTool(server: McpServer) {
  server.registerTool(
    "download_report",
    {
      description: "Boxwood's daily \"Download Report\" — the overnight carrier-download review each rep does every morning, rebuilt from synced AMS360 data instead of AMS360's own exported report. Returns policy transactions and claims that came down from carriers overnight, normalized into plain-language action items and grouped by representative (CSR). RESPONSE SHAPE — this returns a compact result, not the full dataset: the full item list (every rep's routine AND flagged items, with every field) is written to a 24h link (`report_url`) instead of being embedded inline, to keep this response small on a busy day. The inline `reps[].flagged_items` only includes items where `flagged: true`, trimmed to just what judging accuracy requires (`item_id`, `customer_name`, `policy_no`, `what_happened`, `repeat_count`, and up to 3 most-recent `candidate_prior_activity` notes, each capped to 240 characters) — routine items are represented solely by `reps[].summary` counts, and flagged items' other fields (carrier_name, detail, next_step, ...) live only in the full dataset behind the link. Save `report_token` (the same value as the last path segment of `report_url`): pass it to `download_report_workbook` to build the finished worksheet from the *full* dataset (not just the flagged subset you saw here). IMPORTANT — this is a data-synthesis step only, not the finished worksheet: (1) `flagged` means \"this category is one a client could plausibly have requested something about\" (policy change/cancellation/rewrite/reinstatement/reissue/new business) — it is NOT AMS360's native [WARNING]/GROUP REJECT flag from its live download-processing log, which isn't replicated into any table this MCP can query and so cannot be reproduced here; (2) flagged items include `candidate_prior_activity` (recent staff notes on that policy) but NO verdict — deciding whether the download actually matches a documented client request requires reading those notes and judging, which is a separate reasoning step, not something this tool computes; (3) claims reflect only their current state — AMS360's own report can show a claim re-downloaded multiple times in one night (an \"x2/x3 overnight\" note), but that per-event history isn't stored in these tables, so no repeat-count is reported for claims; (4) policy transactions ARE collapsed when AMS360's download processor writes the same transaction (same policy/type/description) several times in quick succession — a confirmed, ongoing AMS360-side glitch, not a client action — into one item, so 12 identical rows read as 1 client-relevant event, not 12 separate requests; a 2-row repeat merges quietly (common enough — ~78% of these — to be unremarkable on its own), but 3+ is surfaced via `repeat_count` and called a repeated transaction, since that pattern is rare enough to be worth a second look. It is NOT necessarily harmless: no synced table records whether a transaction actually applied (isposted/isuploaded were checked and don't track this), so a repeated transaction can equally mean AMS360 kept retrying something that kept failing (e.g. a GROUP REJECT loop) — `next_step` calls this out for any item with a `repeat_count` and the rep should verify directly in AMS360 rather than assume it's cosmetic.",
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

        const [transactionRows, claimRows] = await Promise.all([
          runReadOnlyQuery(POLICY_TRANSACTION_QUERY, [sinceDate, untilDate, csrParam]) as Promise<PolicyTransactionRow[]>,
          runReadOnlyQuery(CLAIM_QUERY, [sinceDate, untilDate, csrParam]) as Promise<ClaimRow[]>
        ])

        const transactionClusters = clusterRepeats(transactionRows)
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

          return {
            customer_name: row.customer_name,
            policy_no: row.policy_no,
            carrier_name: row.carrier_name,
            line_of_business: row.line_of_business,
            domain: "policy_transaction",
            what_happened: category,
            detail: stripDownloadPrefix(row.description),
            next_step: nextStepWithRepeatWarning,
            flagged,
            repeat_count: isReportedRepeat ? repeatCount : undefined,
            csrcode: row.csrcode,
            rep_name: row.rep_name,
            polid: row.polid
          }
        })

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
          detail: [row.claimno ? `Claim #${ row.claimno }` : null, row.claimstatus, row.causeofloss, row.descriptioncl].filter(Boolean).join(" — "),
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
          repeat_count: item.repeat_count,
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
