---
name: downloads
description: Domain knowledge for the download_report / download_report_workbook MCP tools in boxwood-mcp-ts — Boxwood's daily overnight-carrier-download review, rebuilt from synced AMS360 data instead of AMS360's own exported "Download Detail" report. Use when answering questions about the morning download review, "what came down overnight," or building a rep-facing action list/workbook from carrier downloads.
---

# Boxwood download report

`download_report` is stage 1 of a two-stage process. It synthesizes and normalizes overnight
carrier-download data (policy transactions + claims) into per-rep action items — dedup,
categorization, candidate-note retrieval. It does **not** produce the finished worksheet a rep
actually reads each morning, and it does not decide whether a download was "correct."
`download_report_workbook` (stage 2, see below) turns its output into the actual distributable
`.xlsx`, matching `Morning_Download_Action_List_Example.xlsx` in the repo root (an example built by
hand in an earlier conversation).

## Why this exists, and what it deliberately does not reproduce

Andrew's agency runs a manual "Download Detail" review every morning: AMS360's own download-
processing log lists every overnight carrier message, a human dedupes it, sorts it by rep, and
cross-checks flagged items against documented client requests. That log is AMS360's own live
processing state — **it is not replicated into any table this MCP can query.** Two specific things
from the original manual report cannot be reproduced here, and `download_report`'s tool
description says so explicitly rather than silently dropping them:

- **AMS360's native `[WARNING]`/`GROUP REJECT` flags.** No reject/warning field exists on
  `afw_policytransaction`, `afw_claim`, or `afw_transaction` (checked `isposted`/`isuploaded` —
  `isposted='N'` is the *normal* state for most recent rows, not a rejection signal; searched
  `afw_transaction.commenttran` for "reject" — no hits resembling AMS360's concept). Instead,
  `flagged` here means "this transaction category is one a client could plausibly have requested
  something about" — see the categorization table in `src/utils/downloadCategorization.ts`.
- **"×N overnight" repeat-download counts.** `afw_claim` (PK `claimid`) and
  `afw_policytransaction` (PK `polid, effdate`) are both single-current-state rows, not
  append-only logs — if a claim was re-sent by the carrier 3 times in one night, only its latest
  state is visible. Each claim/transaction appears once.

## What it does instead

- **Scopes policy transactions to `afw_policytransaction.source = 'D'`** — confirmed against live
  data to be exactly AMS360's "came down from the carrier overnight" signal (every `'D'` row's
  `description` is `DNLD/`-prefixed; `'I'` is manual entry, `'T'` is bulk transfer). This is also
  what keeps real log noise out: staff-entered changes never enter the query, and the tool
  deliberately never reads `afw_transaction`'s system-classified rows (raw carrier EDI dumps,
  automated call logs, "IM File Upload"/survey chatter) for the "what happened" side — only for
  staff-classified candidate notes, its proven role in `activity_feed`.
- **Scopes claims** via the same system/staff classification `activity_feed` uses
  (`systemEmployeeCondition`) — `afw_claim` has no `source` column, so this is the available
  signal for "this claim came in via the carrier feed, not staff data entry."
- **Categorizes** every transaction by `trantype` (see `downloadCategorization.ts` for the full
  table and the reasoning behind each `flagged` value — an unrecognized `trantype` is flagged
  rather than silently dropped).
- **For flagged items only**, retrieves candidate prior staff activity notes (`afw_transaction`,
  staff-classified, scoped to that `polid`, within `lookback_days` before the transaction's
  `changeddate`) — but does **not** judge whether they match. That judgment (✓ matches / ✗ no
  match / ⚠ verify, in the original hand-built report) requires reading free text and reasoning
  about it; it's a separate step performed on this tool's output, not something computed here.
- **Groups by `afw_customer.csrcode`** (the customer's header CSR — the account owner), not
  `afw_basicpolinfo.csrcode` (a per-policy field that can diverge from who actually owns the
  relationship) — same precedent as the `book_summary` fix.
- **Resolves specific vehicle adds/removals with VIN, plus coverage/limit/deductible specifics for
  every line of business** (`change_detail` — vehicle-only version added 2026-09-02 per client
  feedback wanting more than AMS360's terse transaction description, e.g. "an auto updated ...
  include the VIN# that was updated or added or del"; broadened same day, same client, to cover
  non-auto policy changes too). Two independent correlated signals, semicolon-joined into one field
  when both fire on the same transaction:
  - **Vehicles** — correlates each transaction's own `effdate` against `afw_vehicle` (Personal Auto)
    and `afw_127vehicle` (Commercial Auto), both a full Add/Change/Delete audit history per vehicle
    keyed by `(polid, effdate)`. Confirmed against real data: a vehicle add/replace/delete
    transaction's own `effdate` matches (or lands within a few seconds of, when AMS360 batches
    several vehicle changes into one download event — same jitter `clusterRepeats`/`REPEAT_GAP_MS`
    already accounts for) the corresponding vehicle row(s)' `effdate`. A vin that only shows a bare
    "Change" row in its window (e.g. a sibling vehicle silently renumbered when another vehicle was
    added/removed — confirmed real) is dropped rather than reported as "Updated" — no reliable way
    to distinguish that from a real field edit without diffing every column.
  - **Coverages** — correlates the same way against `afw_coverage`, the LOB-agnostic analog of
    `afw_vehicle` (every line of business writes its coverage/limit/deductible detail here, keyed by
    `(polid, lobid, coverageid, effdate)`). Unlike `afw_vehicle`, this is **not** a per-field diff
    log: confirmed against real data that AMS360 rewrites *every* currently-active coverage row
    (unchanged values included) at any coverageid's effdate, not just the one(s) that actually
    changed. So each matched row is diffed against its own immediately-prior state (same
    `coverageid`, latest `effdate` strictly before it) via a `LEFT JOIN LATERAL` — only a genuine
    `limit1-3`/`deduct1-3` value change is reported (e.g. "Dwelling limit: $850,000 → $899,000"),
    confirmed against a real "DNLD/cvg chngs - inspection" transaction to surface exactly the 3
    fields that moved out of 96 coverage rows in its window. Added/removed coverages use AMS360's
    own `status='A'`/`'D'` instead (a brand-new coverageid has no prior row to diff against). Both
    are filtered to rows carrying an actual limit or deductible value — `afw_coverage` also holds
    premium-breakdown/administrative rows with no limit or deductible at all (e.g. "Fire Peril
    Premium", "Multi policy credit") that get added/removed as a side effect of any coverage
    rewrite; `iscoverage` looked like the natural filter for this but is inconsistent (the same
    `coveragecode` shows up as both `'Y'` and `'N'` on different rows), so "has a limit or
    deductible value" is what's actually reliable.

  **Both signals** share the same `NOT EXISTS` attribution pattern: two closely-spaced but genuinely
  separate transactions on the same policy (confirmed real: two vehicle-add transactions 2 seconds
  apart on the same policy) would double-count under a naive window join, so each query attributes
  every matched audit row to only the *nearest* transaction at or after it, never both. Each side is
  independently capped (`MAX_REPORTED_VEHICLES`/`MAX_REPORTED_COVERAGE_CHANGES`, both 6) with a
  "too many to list, review in AMS360" fallback — a full rewrite/new-business/reissue transaction can
  legitimately touch 90-160+ coverage rows, all reading as "Added" against no prior coverageid, which
  would otherwise flood the cell. Null whenever a transaction has neither kind of activity — most
  transactions will have this as null; don't read null as "nothing changed," only as "no vehicle or
  coverage change this field tracks happened on this transaction specifically." Rendered as its own
  "Policy Changes" column in the finished workbook (`downloadWorkbook.ts`), between Detail and Next
  Step.
- **Reports each policy transaction's own effective date** (`effective_date`, client-requested
  2026-09-03) — `pt.effdate`, i.e. when that specific download-processed change took effect, not the
  policy's own `poleffdate`/`polexpdate`. Always `null` on a claim item (no equivalent field).
  Rendered as its own "Transaction Effective Date" column in the finished workbook, between What
  Happened and Detail.
- **Folds "term-closeout replay" transactions into the fresher item on the same policy**
  (`stale_replay_count`, `foldStaleReplays` — a second, distinct AMS360 glitch from the
  `clusterRepeats`/`repeat_count` one above, found from client feedback 2026-09-03: "it looks like
  it is going and pulling ALL the changes for that policy throughout the policy year — not just the
  most recent that came through overnight"). Confirmed against real data: when a policy's term
  closes out (renewal/rewrite/new-business), AMS360 re-stamps `changeddate` — the field this
  report's window filter runs against — on *every other* transaction from that closing term's
  history too, not just the actual new event. Evidence: 1,001+ real `(polid, changeddate)` batches
  (same download event, exact-millisecond-identical `changeddate`) carrying multiple
  differently-described transactions (up to 24 in one batch) whose own `effdate` spans nearly the
  whole prior year; a histogram of `changeddate - effdate` across ~12k real policy-change rows shows
  the expected smooth decay for legitimately late-processed changes (0-100 days) plus a distinct
  anomalous spike right at the 1-year mark. Left alone, every one of these gets flagged and checked
  against only the last `lookback_days` of staff notes (default 60) — which can't find the real
  conversation from months ago, producing false "no match found" verdicts. Fix mirrors
  `clusterRepeats`' own "collapse quietly, note the count on the survivor" shape rather than
  dropping data: within a batch, the row with the smallest `changeddate - effdate` gap is the
  anchor; any sibling whose own gap exceeds the anchor's by more than 30 days (chosen because ~70%
  of real policy-change rows land within 30 days of their own effective date — comfortably past
  normal backdating variance, safely short of the ~1-year replay spike) is folded into the anchor's
  `next_step` instead of reported as its own item. A single isolated old transaction with no
  fresher batch-mate is left untouched — this only fires on the specific mixed-batch pattern
  confirmed in the data. No dedicated workbook column (same as `repeat_count`) — surfaced via the
  count field plus the date range named in `next_step`.
- **Surfaces a carrier download that never got its own `afw_policytransaction` row at all**
  (`missing_transaction_record`, `MISSING_DOWNLOAD_TRANSACTION_QUERY` — client-requested 2026-09-03:
  "if a new row is inserted into afw_transaction by a carrier download we want to see that tx ...
  even if there is no policy change detected"). `afw_policytransaction` is a latest-write-wins table
  keyed on `(polid, effdate)`: when two downloads land on that same key close together (the same
  effdate-nudging behavior `clusterRepeats` already accounts for), only the later one survives as its
  own row — the earlier one's content is otherwise invisible to this report. Sourced instead from
  `afw_transaction` where `dbaction = 'Download'` (that table's own analog to
  `afw_policytransaction.source = 'D'`) and `polid IS NOT NULL` — `dbaction = 'Download'` alone is
  NOT a safe filter, confirmed against real data it's overloaded and also fires for a staff member
  pulling a file via AMS360 Mobile (e.g. "AMS360 Mobile - File downloaded: Email.MSG."), which always
  has `polid IS NULL` and is cleanly excluded by that check. Matched against
  `afw_policytransaction.source='D'` using the same 10-minute tolerance as `REPEAT_GAP_MS` rather
  than exact `effdate` equality — an exact match undercounts real correspondence (confirmed: ~5,500
  false "missing" rows collapse to the true ~54 once the nudge is accounted for, out of ~27,400 real
  download events).

  `detail` for these items is AMS360's own `commenttran` processing-log text
  (`formatMissingDownloadDetail`), cleaned up rather than shown raw: the `"Msg Date: ... TranSeq#:
  ..."` header line and the generic `"A current policy has been updated by a more current downloaded
  transaction."` boilerplate (present on nearly every row here — literally why it has no
  `afw_policytransaction` match) are stripped, keeping only the substantive `"*** ..."` bullets —
  confirmed real examples include "Download updated the writing company from Hartford Property &
  Casualty to Hartford Insurance Group", a per-vehicle "GOOD STUDENT DISCOUNT ADDED", and an insured
  address/county change. Falls back to a plain "no other detail recorded" message when nothing
  survives the cleanup (some rows carry only the boilerplate).

  These rows are reshaped into the same `PolicyTransactionRow` shape as a real
  `afw_policytransaction` row and merged into the same pipeline *before* `foldStaleReplays`/
  `clusterRepeats` run — not a parallel code path — so categorization, flagging, `repeat_count`,
  `stale_replay_count`, and the vehicle/coverage `change_detail` correlation all apply exactly as
  they would to a normal item, since all of that machinery only ever needed a real `polid`/`effdate`.
  `next_step` gets an appended note explaining why this item's detail looks different (no backing
  policy-transaction row) so a rep isn't confused. No dedicated workbook column; included in the
  inline flagged-item judgment view (unlike a normal item) since `detail` is this item's only source
  of concrete specifics rather than a label already implied by `what_happened`.

## Calling the tool

- `since`/`until` — agency-local timestamp (`"2026-08-28T08:00"`) or relative shorthand
  (`"24h"`/`"7d"`). Omit both for the default firm "8am agency-local yesterday through 8am
  agency-local today" window (the Boxwood ETL sync pulls overnight AMS360 carrier activity starting
  7:30am agency-local and typically finishes within minutes, and the report script itself doesn't
  run until 8am — the window's upper bound anchors to that fixed cutoff, not to "now," so the same
  "today" question returns the same window regardless of what time of day it's asked). Unlike `activity_feed`'s
  `since`/`until` (which bind a true UTC instant against these same naive-local columns — a known
  ~5-6 hour boundary bug), this tool resolves its window through `src/utils/localTime.ts`'s
  `agencyWallClockParts`/`bindableAgencyDate`/`mostRecentAgencySyncWindow` to anchor correctly in
  agency-local wall-clock time, since precision matters for something specifically framed as
  "overnight."
- `csr_code` — scope to one representative.
- `lookback_days` (default 60) — how far back to search for candidate staff notes on flagged
  items; this was the value used in the original hand-built report, with the same caveat that
  applied there: a legitimate request documented further back won't surface as a candidate.

**Response is compact, not the full dataset.** A busy day's full item list (every rep's routine
*and* flagged items) can exceed the MCP tool-result size cap on its own — confirmed: 119
policy-transaction rows + 5 claims produced a 114,907-character response. So the full dataset is
written to a 24-hour link (`report_url`, same `storeDownload`/`/downloads/:token` mechanism
`download_report_workbook` uses for the finished `.xlsx`) instead of being embedded inline. The
response you actually get back is `{ window, report_token, report_url, reps }`, where each rep is
`{ csr_code, rep_name, summary, flagged_items }` — `flagged_items` only, no routine items (those are
represented solely by `summary`'s counts), and each flagged item is trimmed to just what judging
accuracy requires (`item_id`, `customer_name`, `policy_no`, `what_happened`, `repeat_count`, up to 3
most-recent `candidate_prior_activity` notes capped to 240 characters each) — other fields
(`carrier_name`, `detail`, `next_step`, ...) exist only in the full dataset behind `report_url`. Save
`report_token` — it's required by `download_report_workbook` below.

## Building the finished worksheet — `download_report_workbook`

Stage 2. Takes `download_report`'s `report_token` (it re-fetches that call's full stored dataset
server-side — every item, not just the flagged subset you saw inline) and renders the actual
`.xlsx` — one `Summary` tab plus one tab per rep, color-coded flagged rows and accuracy verdicts —
matching `Morning_Download_Action_List_Example.xlsx`. It only renders; it does not judge anything. Before calling it, read every item in `download_report`'s `flagged_items` (per
rep) and build a `verdicts` array with one `{ item_id, accuracy: { status, note } }` entry per item
(`status` is `matches`/`no_match`/`rejected`/`verify`) — that's the judgment call `download_report`
deliberately leaves undone (see above). Non-flagged items don't need one (they render as
"Routine"/"Informational" automatically); a flagged item with no entry in `verdicts` renders as
"Needs review" rather than silently reading as fine.

**Write `note` for a rep to read, not for another tool call.** It's rendered verbatim into the
"Check for Accuracy" column a rep actually reads (client-requested fix, 2026-09-03, after a note
read "the same Colorado removal is documented elsewhere (item 49) on this policy" — `item_id` is an
internal join key with no meaning outside this MCP's own data flow, invisible anywhere in the
finished workbook). If a verdict depends on another item on the same report, name it by its content
instead — the customer, the policy number, or what it actually says — never by number.
**Keep the cross-reference itself** — dropping it entirely (as opposed to rephrasing it) was an
over-correction caught the same day: several notes went from a useful "this likely matches the
trade-in documented on the client's other policy" down to a generic "no activity notes found," which
throws away real signal the note is supposed to carry. Only the numeric identifier goes; the
observation stays.

The builder itself (`src/utils/downloadWorkbook.ts`'s `buildDownloadReportWorkbook`) is a plain
buffer-in/buffer-out function with no MCP dependency, so a future automation script (the eventual
tool-call-1 → tool-call-2 → email plan) can call it directly without going through the MCP tool.

Returns a plain download link (`https://mcp.boxwoodins.com/downloads/<token>`, valid 24 hours)
rather than embedding the file in the tool result — pass it back to the user as-is.

## Common questions → calls

- "What came down overnight?" → `download_report` with no args (defaults to the firm 8am-to-8am
  sync window — yesterday 8am through today 8am agency-local).
- "What does Kimbra need to review this morning?" → `download_report` with
  `csr_code: "<Kimbra's empcode>"`.
- "Build me the morning worksheet" → call `download_report`, judge each item in every rep's
  `flagged_items` into a `{ item_id, accuracy }` verdict, then call `download_report_workbook` with
  `report_token` + that `verdicts` array to get the actual `.xlsx`.
