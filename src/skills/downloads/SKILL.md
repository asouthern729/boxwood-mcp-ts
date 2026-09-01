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
