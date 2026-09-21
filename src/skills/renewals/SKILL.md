---
name: renewals
description: Domain knowledge for boxwood-mcp-ts's renewal-related MCP tools — upcoming_renewals (Boxwood Insurance's AMS360 book of business filtered to active policy terms expiring within a day window, with marketing shells and, by default, already-renewed terms excluded — pass include_already_renewed for a calendar/exposure view instead) and risk_profile (builds a branded Pre-Renewal Review .docx, exposures only, for one or more commercial policies). Use when answering questions about what's renewing soon, a producer's or carrier's upcoming renewal book, which accounts need renewal outreach, or building a renewal-meeting packet for a commercial client.
---

# Boxwood renewals

Two tools cover renewal work today: `upcoming_renewals` (find what's coming due) and
`risk_profile` (build the renewal-meeting document for one or more commercial accounts). More
renewal-related tools will land in this same skill over time rather than each getting its own skill
— check here first for anything renewal-shaped.

## upcoming_renewals

`upcoming_renewals` answers "what's expiring soon and still needs attention?" — it is not a generic `polexpdate` sort. `policy_query` has no `polexpdate` sort/filter at all today, and even if it did, a naive "active + expiring in N days" query is mostly noise: roughly 80% of policies that look like they're expiring soon already have a renewal term booked (see exclusion logic below). This tool exists specifically to strip that noise out.

### Calling the tool

The window is either `within_days` (default 30, max 365 — a rolling window from real `now()`, for a relative ask like "the next 30 days") or an exact `start_date`/`end_date` pair (YYYY-MM-DD, both required together, for a specific calendar period like "December" or "Q1" — takes precedence over `within_days` when given). Always prefer `start_date`/`end_date` when the person names a specific period rather than computing a rolling window wide enough to contain it and filtering afterward — that wastes rows, risks pagination, and burns turns for no benefit. Narrow either window with any combination of:
- `producer_code` — exact match against `afw_basicpolinfo.execcode` (the producer/agent of record, distinct from CSR)
- `csr_code` — exact match against `afw_basicpolinfo.csrcode`
- `carrier_code` — exact match against `afw_basicpolinfo.cocode`
- `typeofbus` — exact match, integer code. `1` (personal) and `2` (commercial) dominate the book; other codes (`0`, `3`-`7`) also appear in small numbers and aren't decoded anywhere — don't assume it's strictly binary
- `book_type` — friendlier alias over `typeofbus` for the book's two dominant segments: `"commercial"` restricts to `typeofbus = 2`, `"personal"` to `typeofbus = 1`. The book has other, undecoded `typeofbus` codes too (`0`, `3`-`7`) that `book_type` doesn't cover — pass `typeofbus` directly for those. Combines with an explicit `typeofbus` via AND if both are given (redundant if consistent, zero rows if not)

`group_by` (default `"none"`) adds a `breakdown` array grouped by `"producer"` or `"carrier"` — a separate count query over the same filters, not a client-side tally. Each breakdown row is `{ code, label, count }`. `limit` (default 25, max 200) + `offset` paginate; response includes `has_more`. Results are always sorted `polexpdate` ascending — soonest-expiring first — there's no `sort` param.

### What's excluded, and why

Two exclusions are unconditional, always applied regardless of `include_already_renewed`:

- **`polsubtype != 'S'`** — excludes marketing/submission shells (see `policies` skill), which have a `polexpdate` but represent a shopped quote, not a real bound risk.
- **`status != 'D'`** — excludes deleted rows.

By default (`include_already_renewed: false`, the default), two more are applied on top — together these turn the tool into a "needs action" pipeline view (what hasn't been handled yet), which is the primary use case:

- **`renewalrptflag = 'A'`** — only the currently-active term in each renewal chain. `afw_basicpolinfo.status` looks like it should mean this but doesn't: in this data most currently-in-force terms carry `status = 'C'`, not `'A'` — `status='A'` alone undercounts the true active book by roughly 8x. `renewalrptflag` is the field that actually tracks renewal-chain lifecycle (`A`=active/current, `R`=renewed-over, `C`=cancelled, `E`=expired, plus a few rarer codes).
- **Already-renewed exclusion** — a term is dropped if any other `afw_basicpolinfo` row's `priorpolid` already points back at its `polid` (i.e. a successor term already exists via `NOT EXISTS (... WHERE bp2.priorpolid = p.polid)`). **This is the load-bearing filter, not a nice-to-have**: a naive `status='A' AND polsubtype != 'S'` query in a 30-day window returns ~5x more rows than after this exclusion — the difference is entirely policies that already have a booked renewal term sitting in the data, just not the one that's technically "expiring."

Pass **`include_already_renewed: true`** to drop both of the above and get a calendar/exposure view instead — every term whose `polexpdate` is in the window, whether or not its renewal has already been bound. Verified against real data via `EPP 0764015`: its expiring term already had a bound successor with `renewalrptflag: 'R'` ten days before anyone asked about it, and the default view correctly excludes it as already-handled.

The Pre-Renewal Risk Profile and Renewal Premium Summary chats (client decision, 2026-09-21) do NOT default their main query to `include_already_renewed: true` — both worksheets are meant to surface accounts still being shopped at renewal, so the default "needs action" list stays primary. Instead, when browsing a date range, each chat calls `upcoming_renewals` a second time with `include_already_renewed: true` for the same window, diffs the two result sets, and appends a short closing note naming any accounts that were excluded because they'd already renewed — visible as an FYI without cluttering the main action list.

`polexpdate` within the window is always required — `BETWEEN now() AND now() + within_days` (or the exact `start_date`/`end_date` range).

Note: `policy_query`'s `renewalrptflag: "A"` filter and `book_summary` both additionally require `poleffdate <= today` (client-confirmed 2026-08-27, so a bound-but-not-yet-started renewal doesn't count as part of the "current" book). This tool deliberately does **not** apply that restriction — a future-dated renewal that's already bound is precisely what makes an about-to-expire term excluded here via the already-renewed exclusion above, and is exactly the kind of row this tool's own purpose requires being able to detect.

### `has_renewal_activity`

A boolean per row: `true` if `afw_policytransaction` has a row for this `polid` with `trantype IN ('RWL', 'RWQ')` (renewal / renewal-quote). This is a *narrower* signal than the already-renewed exclusion above — a row can pass the exclusion (no successor term exists yet) and still have `has_renewal_activity: true`, meaning a renewal has been quoted/bound but the new term hasn't synced as its own `afw_basicpolinfo` row yet. Use it to distinguish "renewal already in motion, don't call this account" from "nothing's happened, needs outreach."

There are three other renewal-adjacent `trantype` codes in the data (`RWX`, `RRQ`, `RWR`) that are **not** included in this flag — they're undecoded (no lookup table backs `trantype`) and rare enough (under 40 rows combined, vs. ~9,500 for `RWL`/`RWQ`) that including them without knowing what they mean risked false positives. If a caller needs those, they show up via `policy_query`'s `include: ["transactions"]` on the specific `polid`.

### Domain gotcha: output timestamps are agency-local

`poleffdate`/`polexpdate` (and any other timestamp field surfaced) come back agency-local (`America/Chicago`), not UTC — e.g. `2026-09-01T00:00:00.000-05:00`. No conversion needed on the caller's end.

### Domain gotcha: producer vs. CSR

`execcode` is the producer/agent of record (who sold and owns the account); `csrcode` is the customer service rep (who services it day-to-day). They're frequently different people. `producer_code` filters on `execcode` — if a request says "CSR" instead of "producer" or "agent," use `csr_code` instead.

`execcode`/`csrcode` are always resolved to a producer/CSR name in the core result (`exec_lastname`/`exec_firstname`, `csr_lastname`/`csr_firstname`) and in the `producer` breakdown's `label`. **But the raw code still comes back too, right alongside the name — `p.csrcode`/`p.execcode` are selected as-is in the core result, and the breakdown row's `code` field is the raw employee code (e.g. `!!C`) by design.** Always answer with the resolved name; never quote `csrcode`/`execcode`/breakdown `code` to the user — it's an opaque AMS360 identifier with no meaning to them, even when it happens to render as short text. This applies equally to `producer_code`/`csr_code` used as filters: if a name had to be resolved to a code first (e.g. via `employee_lookup`) to build the filter, refer to that person by name in the answer, not by the code you queried with. If this tool is ever extended to expose another employee-linked field, resolve it to a name in the output and keep this same rule in mind.

### Common questions → calls

- "What's renewing in the next 30 days?" → `within_days: 30` (the default — can omit)
- "What's Blake Lambert's renewal book look like for next quarter?" → `within_days: 90, producer_code: "<lambert's execcode>"`
- "Any commercial renewals coming up this month?" → `within_days: 30, book_type: "commercial"` (equivalent to `typeofbus: 2`)
- "Give me a commercial client with a policy expiring in the next 30 days" → `within_days: 30, book_type: "commercial"`
- "What personal lines renewals are coming up this week?" → `within_days: 7, book_type: "personal"`
- "How many renewals per producer in the next 30 days?" → `within_days: 30, group_by: "producer"`
- "I want to review what commercial clients have renewals coming in December" → one `upcoming_renewals` call with `start_date: "2026-12-01", end_date: "2026-12-31", book_type: "commercial"` — an exact calendar range, not `within_days` (computing a wide rolling window that also covers Sept–Nov and filtering afterward wastes rows, risks pagination, and burns turns for no benefit; `start_date`/`end_date` return exactly the December rows in one call). **Do NOT call `customer_lookup` once per matching row to "review" them** — every field needed for a client-by-client review (resolved customer name, `polno`, renewal date, resolved CSR name, resolved carrier name, premium) is already in each `upcoming_renewals` row. Fanning out into a `customer_lookup` call per result (15-30+ sequential tool calls for a busy month) adds no new information for this kind of question and burns context/turns for nothing — only call `customer_lookup` when the person wants to drill into ONE specific client's fuller profile (contacts, policies, loss history, etc.), not to answer a list/summary question about many clients at once.
- "Which of these still need outreach vs. are already in motion?" → check `has_renewal_activity` per row

## risk_profile

Builds a branded "Pre-Renewal Review" Word document (`.docx`) for one or more commercial-lines policies — the current expiring program's exposure schedules ONLY (Named Insureds, Locations, Property Coverage, General Liability Exposure, Equipment, Vehicles, Drivers, Workers' Comp Exposure) — deliberately no premiums or coverage limits (that's the separate, not-yet-built "CL Renewal Summary" tool). Meant for the CSR and client to review together ahead of the renewal meeting. Called ad hoc, not tied to `download_report` or any other tool — a rep can ask for one for any commercial account at any time.

### Calling the tool

Pass `polno` (partial match) and/or `custid` to identify the policy — resolves to the customer's current in-force term(s) (`typeofbus = 2 AND poleffdate <= today <= polexpdate`). Deliberately does NOT also require `renewalrptflag = 'A'` (client-corrected 2026-09-14, Defatta Custom Homes LLC): AMS360 can flip a term's flag to `'R'` the moment its successor term is bound, weeks before that successor's own effective date arrives — so the term genuinely in force today can carry `'R'`, not `'A'`, and a literal `renewalrptflag = 'A'` filter would find nothing at all for that account until the new term actually starts. Zero matches or a personal-lines-only match is a clean error.

`renewal_within_days` (optional) scopes matches to policies whose `polexpdate` falls within that many days from today — pass this (e.g. `90`) when resolving "renewing soon" rather than pulling every current commercial policy on the account, which can include lines of business (e.g. Workers' Comp/Employee Benefits still coded `typeofbus=2`) irrelevant to the renewal conversation at hand.

**Multiple current policies matching the SAME customer are combined into one document, not treated as ambiguous** — e.g. `custid` alone, or a loosely-matched `polno`, resolving to several of that customer's policies. The combined doc gets a cover page with a policy summary table (policy #, type, premium, renewal date), and Named Insureds are merged/deduped across policies (up to 12 at once); every other section's rows are simply combined with no per-row policy tag. Matches across DIFFERENT customers (an ambiguous `polno` with no `custid`) are still a genuine error — narrow with a more specific `polno` or add `custid`.

There is no email-sending on this tool — it only ever returns a download link; share it with the CSR directly.

### What's included, and what's deliberately left out

Every section is independently omitted (not shown empty) when the policy has no data for it — never assume all 8 sections appear. The General Liability and Workers' Comp tables carry an intentionally blank trailing "Renewal Exposure"/"Renewal Payroll" column — this is for the live meeting, never populate it.

**Property Coverage is grouped one row per address** (Building Limit / BPP Limit split columns, plus a blank "Description" column for staff to annotate by hand at the renewal meeting) — matching the client's own reference layout.

**Driver schedule has no DOB or license number.** `afw_127driver`'s schema carries both columns, but they're locked down at the column-grant level for the `claude` role — same PII convention as `afw_applicant`/`afw_driver` (see `policies` skill). Only name and license state are shown.

A section can legitimately come back empty even when raw row counts (e.g. from `run_query`) suggest otherwise — every query dedupes to each record's *latest* version by `effdate`, then drops it if that latest version is deleted (`status = 'D'`). A Workers' Comp classification that was set up and later fully superseded/removed shows real historical rows in the raw table but correctly produces no current WC section here.

### Archiving and the 24-hour link

The response includes a `download_url` (same `/downloads/<token>` pattern as `download_report`/`download_report_workbook`) that expires after 24 hours. Separately, every generated document is also written to `scripts/output/cl-risk-profile/` (same convention as `scripts/morningDownload.ts`'s download-report `.xlsx`, gitignored) with a `manifest.json` entry — `filename`, `generated_at`, `csr_code`, `csr_name`, `client_name`, `polnos`, `renewal_date`, `renewal_date_label` — backing the `/cl-risk-profile/` index page (`site/cl-risk-profile.html`, `reports.html`'s counterpart for these — same Auth0/PKCE-protected pattern, served via `src/routes/riskProfile.ts`). That page groups by CSR (alphabetical, unassigned last) and sorts each CSR's accounts by `renewal_date` ascending — soonest-due first, not `generated_at`. **At most one archived file per policy (`polid`), or per exact combined policy set** — a customer can carry several distinct commercial policies at once (confirmed against real data: one account has 4), so a single-policy archive filename keys on `polid` (unique per term) and a combined document keys on the full matched `polno` set. Regenerating the exact same policy's packet, or the exact same combination, overwrites its own prior copy; a different policy or combination gets its own separate file; a future renewal of the same policy (a new term, new `polid`, new `renewal_date`) becomes its own new file rather than clobbering the current one. Archived files are cleaned up after 30 days via a host crontab entry, same retention as the download report — note this does NOT prune the now-stale `manifest.json` entry for a deleted file, so the route filters out any manifest entry whose file no longer exists on disk before returning results.

### Common questions → calls

- "Build a risk profile / pre-renewal review for [client]" → `polno` or `custid` for that client
- "Build one for everything [client] has renewing in the next 90 days" → `custid`, `renewal_within_days: 90`
