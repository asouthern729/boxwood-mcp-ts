---
name: renewals
description: Domain knowledge for boxwood-mcp-ts's renewal tools for Boxwood Insurance's AMS360 book — upcoming_renewals (active terms expiring in a day window; already-renewed terms excluded unless include_already_renewed), risk_profile (exposures-only Pre-Renewal Review .docx for commercial policies), renewal_premium_spreadsheet (Commercial Renewal Premium Spreadsheet .xlsx, current premium and carrier per line), cl_renewal_summary (Commercial Insurance Proposal-format renewal .docx, limits and schedules, no premiums), pl_renewal_summary (Personal Insurance Portfolio Summary .docx) and pl_renewal_premium_change (PL Renewal Calculator .xlsx, premium change per line vs the expiring term, plus an AMS note). Use for what's renewing soon, a producer's or carrier's renewal book, renewal outreach, commercial renewal packets, proposals or premium spreadsheets, personal-lines coverage summaries, or how much a personal renewal changed.
---

# Boxwood renewals

Six tools cover renewal work today: `upcoming_renewals` (find what's coming due),
`risk_profile` (build the exposures-only renewal-meeting document for one or more commercial
accounts), `renewal_premium_spreadsheet` (current premium per line for a commercial account's
renewal), `cl_renewal_summary` (the renewal proposal: coverage limits and schedules by line),
`pl_renewal_summary` (the personal-lines coverage summary for a household), and
`pl_renewal_premium_change` (how much a downloaded personal-lines renewal changed in premium). More
renewal-related tools will land in this same skill over time rather than each getting its own skill
— check here first for anything renewal-shaped. (`proposal_builder`, which builds a proposal from
uploaded quote PDFs, is only available inside the dashboard's Proposal Builder chat, not on the
general MCP endpoint.)

## upcoming_renewals

`upcoming_renewals` answers "what's expiring soon and still needs attention?" — it is not a generic `polexpdate` sort. `policy_query` has no `polexpdate` sort/filter at all today, and even if it did, a naive "active + expiring in N days" query is mostly noise: roughly 80% of policies that look like they're expiring soon already have a renewal term booked (see exclusion logic below). This tool exists specifically to strip that noise out.

### Calling the tool

The window is either `within_days` (default 30, max 365 — a rolling window from real `now()`, for a relative ask like "the next 30 days") or an exact `start_date`/`end_date` pair (YYYY-MM-DD, both required together, for a specific calendar period like "December" or "Q1" — takes precedence over `within_days` when given). Always prefer `start_date`/`end_date` when the person names a specific period rather than computing a rolling window wide enough to contain it and filtering afterward — that wastes rows, risks pagination, and burns turns for no benefit. Narrow either window with any combination of:
- `producer_code` — exact match against `afw_basicpolinfo.execcode` (the producer/agent of record, distinct from CSR)
- `csr_code` — exact match against `afw_basicpolinfo.csrcode`
- `carrier_code` — exact match against `afw_basicpolinfo.cocode`
- `typeofbus` — exact match, integer code. `1` (personal) and `2` (commercial) dominate the book; other codes (`0`, `3`-`7`) also appear in small numbers (`policy_query` returns their `typeofbus_description`) — don't assume it's strictly binary
- `book_type` — friendlier alias over `typeofbus` for the book's two dominant segments: `"commercial"` restricts to `typeofbus = 2`, `"personal"` to `typeofbus = 1`. The book has other `typeofbus` codes too (`0`, `3`-`7`) that `book_type` doesn't cover — pass `typeofbus` directly for those. Combines with an explicit `typeofbus` via AND if both are given (redundant if consistent, zero rows if not)

`group_by` (default `"none"`) adds a `breakdown` array grouped by `"producer"` or `"carrier"` — a separate count query over the same filters, not a client-side tally. Each breakdown row is `{ code, label, count, premium_sum, premium_avg }` (sum/average of `fulltermpremium` over the matched terms — answers "premium renewing next quarter, by carrier"). `limit` (default 25, max 200) + `offset` paginate; response includes `has_more`. Results are always sorted `polexpdate` ascending — soonest-expiring first — there's no `sort` param.

### What's excluded, and why

Two exclusions are unconditional, always applied regardless of `include_already_renewed`:

- **`polsubtype != 'S'`** — excludes marketing/submission shells (see `policies` skill), which have a `polexpdate` but represent a shopped quote, not a real bound risk.
- **`status != 'D'`** — excludes deleted rows.

By default (`include_already_renewed: false`, the default), two more are applied on top — together these turn the tool into a "needs action" pipeline view (what hasn't been handled yet), which is the primary use case:

- **`renewalrptflag = 'A'`** — only the currently-active term in each renewal chain. `afw_basicpolinfo.status` looks like it should mean this but doesn't: in this data most currently-in-force terms carry `status = 'C'`, not `'A'` — `status='A'` alone undercounts the true active book by roughly 8x. `renewalrptflag` is the field that actually tracks renewal-chain lifecycle (`A`=active/current, `R`=renewed-over, `C`=cancelled, `E`=expired, plus a few rarer codes).
- **Already-renewed exclusion** — a term is dropped if any other `afw_basicpolinfo` row's `priorpolid` already points back at its `polid` (i.e. a successor term already exists via `NOT EXISTS (... WHERE bp2.priorpolid = p.polid)`). **This is the load-bearing filter, not a nice-to-have**: a naive `status='A' AND polsubtype != 'S'` query in a 30-day window returns ~5x more rows than after this exclusion — the difference is entirely policies that already have a booked renewal term sitting in the data, just not the one that's technically "expiring."

Pass **`include_already_renewed: true`** to drop both of the above and get a calendar/exposure view instead — every term whose `polexpdate` is in the window, whether or not its renewal has already been bound. Verified against real data via `EPP 0764015`: its expiring term already had a bound successor with `renewalrptflag: 'R'` ten days before anyone asked about it, and the default view correctly excludes it as already-handled.

The Pre-Renewal Risk Profile and Renewal Premium Spreadsheet chats (client decision, 2026-09-21) do NOT default their main query to `include_already_renewed: true` — both worksheets are meant to surface accounts still being shopped at renewal, so the default "needs action" list stays primary. Instead, when browsing a date range, each chat calls `upcoming_renewals` a second time with `include_already_renewed: true` for the same window, diffs the two result sets, and appends a short closing note naming any accounts that were excluded because they'd already renewed — visible as an FYI without cluttering the main action list.

`polexpdate` within the window is always required — `BETWEEN now() AND now() + within_days` (or the exact `start_date`/`end_date` range).

Note: `policy_query`'s `renewalrptflag: "A"` filter and `book_summary` both additionally require `poleffdate <= today` (client-confirmed 2026-08-27, so a bound-but-not-yet-started renewal doesn't count as part of the "current" book). This tool deliberately does **not** apply that restriction — a future-dated renewal that's already bound is precisely what makes an about-to-expire term excluded here via the already-renewed exclusion above, and is exactly the kind of row this tool's own purpose requires being able to detect.

### `has_renewal_activity`

A boolean per row: `true` if `afw_policytransaction` has a row for this `polid` with `trantype IN ('RWL', 'RWQ')` (renewal / renewal-quote). This is a *narrower* signal than the already-renewed exclusion above — a row can pass the exclusion (no successor term exists yet) and still have `has_renewal_activity: true`, meaning a renewal has been quoted/bound but the new term hasn't synced as its own `afw_basicpolinfo` row yet. Use it to distinguish "renewal already in motion, don't call this account" from "nothing's happened, needs outreach."

There are three other renewal-adjacent `trantype` codes in the data (`RWX`, `RRQ`, `RWR`) that are **not** included in this flag — they're rare enough (under 40 rows combined, vs. ~9,500 for `RWL`/`RWQ`) that including them without knowing what they mean risked false positives. If a caller needs those, they show up via `policy_query`'s `include: ["transactions"]` on the specific `polid`.

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

Builds a branded "Pre-Renewal Review" Word document (`.docx`) for one or more commercial-lines policies — the current expiring program's exposure schedules ONLY (Named Insureds, Locations, Property Coverage, General Liability Exposure, Equipment, Vehicles, Drivers, Workers' Comp Exposure) — deliberately no premiums or coverage limits (coverage limits are `cl_renewal_summary`, below). Meant for the CSR and client to review together ahead of the renewal meeting. Called ad hoc, not tied to `download_report` or any other tool — a rep can ask for one for any commercial account at any time. Styled like `cl_renewal_summary` (same palette, cover, banners and tables, 2026-10-10), but sections flow on from one another rather than each starting a page.

### Calling the tool

Pass `customer_name` (partial match), `polno` (partial match), and/or `custid` to identify the policy — resolves to the customer's current in-force term(s) (`typeofbus = 2 AND poleffdate <= today <= polexpdate`). Deliberately does NOT also require `renewalrptflag = 'A'` (client-corrected 2026-09-14, Defatta Custom Homes LLC): AMS360 can flip a term's flag to `'R'` the moment its successor term is bound, weeks before that successor's own effective date arrives — so the term genuinely in force today can carry `'R'`, not `'A'`, and a literal `renewalrptflag = 'A'` filter would find nothing at all for that account until the new term actually starts. Zero matches or a personal-lines-only match is a clean error.

**Prefer `customer_name` over resolving a name through `customer_lookup` first** (client-reported 2026-09-22). AMS360 often keeps a commercial client's employee-benefits book as a separate customer record with a near-identical name — Defatta Custom Homes LLC (commercial) vs. "DeFatta Custom Homes" (typeofbus 4 only: dental/vision/life/disability) — so `customer_lookup` returns both and forces a "which one?" question. `customer_name` is matched only among customers with a current commercial policy, so that benefits record never competes; only fall back to `customer_lookup` on no match or a genuine multi-customer ambiguity.

`renewal_within_days` scopes matches to policies whose `polexpdate` falls within that many days from today. **It defaults to 90 for an account-level request** (`customer_name`/`custid` with no `polno`) — same default as `renewal_premium_spreadsheet` — so bonds and other lines not renewing until much later stay out (client-reported 2026-09-22: a surety bond renewing 5/2027 showed up on Defatta's combined document before this default). Pass a larger value to widen it. A specific `polno` gets no default window. If nothing on the account renews within the window, the tool errors with the account's soonest renewal date rather than a bare "no match".

**Multiple current policies matching the SAME customer are combined into one document, not treated as ambiguous** — e.g. `custid` alone, or a loosely-matched `polno`, resolving to several of that customer's policies. The combined doc lists every policy in the cover's Carrier | Line of Business table (shown for a single policy too; the "Current Policy Period"/"Renewal Effective" lines are the first policy's), and Named Insureds are merged/deduped across policies (up to 12 at once); every other section's rows are simply combined with no per-row policy tag. Matches across DIFFERENT customers (an ambiguous `polno` with no `custid`) are still a genuine error — narrow with a more specific `polno` or add `custid`.

There is no email-sending on this tool — it only ever returns a download link; share it with the CSR directly.

### What's included, and what's deliberately left out

Every section is independently omitted (not shown empty) when the policy has no data for it — never assume all 8 sections appear. The General Liability and Workers' Comp tables carry an intentionally blank trailing "Renewal Exposure"/"Renewal Payroll" column — this is for the live meeting, never populate it.

**Property Coverage is grouped one row per address** (Building Limit / BPP Limit split columns, plus a blank "Description" column for staff to annotate by hand at the renewal meeting) — matching the client's own reference layout.

**Driver schedule has no DOB or license number.** `afw_127driver`'s schema carries both columns, but they're locked down at the column-grant level for the `claude` role — same PII convention as `afw_applicant`/`afw_driver` (see `policies` skill). Only name and license state are shown.

A section can legitimately come back empty even when raw row counts (e.g. from `run_query`) suggest otherwise — every query dedupes to each record's *latest* version by `effdate`, then drops it if that latest version is deleted (`status = 'D'`). A Workers' Comp classification that was set up and later fully superseded/removed shows real historical rows in the raw table but correctly produces no current WC section here.

### Archiving and the 24-hour link

The response includes a `download_url` (same `/downloads/<token>` pattern as `download_report`/`download_report_workbook`) that expires after 24 hours. Separately, every generated document is also written to `<OUTPUT_ROOT>/cl-risk-profile/` (`/var/lib/boxwood-mcp/output` in production, outside the checkout — same convention as the morning download-report `.xlsx`) with a `manifest.json` entry — `filename`, `generated_at`, `csr_code`, `csr_name`, `client_name`, `polnos`, `renewal_date`, `renewal_date_label` — backing the `/cl-risk-profile/` index page (`site/cl-risk-profile.html`, `reports.html`'s counterpart for these — same Auth0/PKCE-protected pattern, served via `src/routes/riskProfile.ts`). That page groups by CSR (alphabetical, unassigned last) and sorts each CSR's accounts by `renewal_date` ascending — soonest-due first, not `generated_at`. **At most one archived file per policy (`polid`), or per exact combined policy set** — a customer can carry several distinct commercial policies at once (confirmed against real data: one account has 4), so a single-policy archive filename keys on `polid` (unique per term) and a combined document keys on the full matched `polno` set. Regenerating the exact same policy's packet, or the exact same combination, overwrites its own prior copy; a different policy or combination gets its own separate file; a future renewal of the same policy (a new term, new `polid`, new `renewal_date`) becomes its own new file rather than clobbering the current one. There's no retention cron on this archive (only the download report is pruned after 30 days); a file removed by hand or via the page's delete leaves no visible entry, because the route filters out any manifest entry whose file no longer exists on disk.

**Built automatically** on the 1st of each month by `scripts/monthlyRiskProfiles.ts` (run from `monthlyRenewalPremiumSummaries.sh`, 8:30am CT): one document per commercial account with a policy expiring in month M+2 (Oct 1 builds December's), combining only that account's policies expiring in the target month. Nothing is emailed.

### Common questions → calls

- "Build a risk profile / pre-renewal review for [client]" → `polno` or `custid` for that client
- "Build one for everything [client] has renewing in the next 90 days" → `custid`, `renewal_within_days: 90`

## renewal_premium_spreadsheet

Fills Patrick's own **Commercial Renewal Premium Spreadsheet** (`assets/templates/commercial-renewal-template.xlsx`) for one commercial account. It's the premium counterpart to `risk_profile` and `cl_renewal_summary`, which carry no premiums.

### Calling the tool

`custid` only (resolve the customer first). The tool is always account-scoped, because its job is to separate "renewing soon" from "everything else on the account." `renewal_within_days` (default 90) decides which current commercial policies go in the main table. Every other current commercial policy goes in a second table with its expiration date. If nothing renews in the window, the tool returns the soonest renewal date and builds nothing.

### What gets filled

- **Current premium and Carrier** for each of the template's 8 fixed lines: General Liability, Property, Auto, Umbrella, Workers Comp, EPLI, Inland Marine, D&O. A monoline policy maps to its one line. A Package policy's full blended premium goes on its "primary" line and is never split, because AMS360 doesn't split a package rate reliably (`afw_cprem` per-line sums came to only 62% of `fulltermpremium` on a real Package policy).
- A line that matches none of the 8 goes in a spare row.
- **Left blank at build time:** Renewal premium, renewal carrier, the market-option carrier columns, and Trending Percent Increase (removed per Patrick). Staff fill these in by hand as the renewal is shopped. TOTAL PREMIUM and Percent Change are template formulas.
- An **internal-only note block** below the table gives each policy's "premium as of" date (its latest AMS360 transaction). Staff delete it before forwarding the workbook to the client.

### Archiving

The tool returns a 24-hour `download_url`. It also archives to `<OUTPUT_ROOT>/cl-renewal-premium-summaries/`, one file per account (rebuilding overwrites it), backing the CSR-grouped renewal-premium-summaries index page. **Built automatically** on the 1st of each month for every commercial account with a policy expiring in month M+2 (`scripts/monthlyRenewalPremiumSummaries.ts`), and refreshed each weekday at 9am CT (`scripts/dailyRenewalPremiumSummaryRefresh.ts`, the same Refresh as the index page's button). The refresh fills a still-blank Renewal cell once AMS360 has a priced successor term. It also updates Current when AMS360's figure changed, unless someone edited that cell by hand. It never touches anything else in the workbook. Nothing is emailed.

### Common questions → calls

- "Build the renewal premium spreadsheet for [client]" → `customer_lookup` for the `custid`, then `renewal_premium_spreadsheet`
- "What's each line costing [client] now?" as a quick question → `policy_query` with `custid` is lighter; build the workbook only when they want the deliverable

## cl_renewal_summary

Builds the commercial-lines "Renewal Summary" Word document (`.docx`) in the layout of Patrick's insurance-proposal skill — a **Commercial Insurance Proposal** for the account's renewal, filled from AMS360 (Patrick, 2026-10-07: "This is what we would want to pull from the Renewal Summary Tool for commercial lines"). Use this whenever coverage limits are wanted; use `risk_profile` for the exposures-only Pre-Renewal Review. **No premiums anywhere** — the proposal's Premium Summary page is deliberately left out; premiums are `renewal_premium_spreadsheet`'s job.

### Calling the tool

Identical inputs and policy resolution to `risk_profile` (`customer_name`, `polno`, and/or `custid`, optional `renewal_within_days` — same advice to prefer `customer_name` over `customer_lookup`) — both tools share the same resolution/combine code (`src/utils/clPolicyData.ts`), so they always cover the same in-force terms, combine the same way for one customer, and treat cross-customer matches as ambiguous the same way. Download link only, no email.

**Renewal term.** For each matched policy, when AMS360 already has its renewal term (the next term, not cancelled at inception, with coverage detail in `afw_cprem`), the document prints that term's limits, schedules and dates. Otherwise it prints the current term — nothing in the document flags this (users didn't want "Renewal Terms Pending" banners, 2026-10-10); instead each manifest entry's `sections` lists every coverage section with `renewed: true|false`, which the index page shows under the policy numbers. The tool returns those policies in `renewal_pending_polnos`, and the daily job rebuilds the document once the renewal lands.

**Built automatically** each weekday at 9am CT by `scripts/dailyClRenewalSummaries.ts`: every commercial term expiring within the next 30 days that has no archived Renewal Summary yet gets one, built once (the same account's new terms are combined into one document). Nothing is emailed.

### Layout

Cover page (client, mailing address, policy period, Prepared By = the producer) → Executive Summary (template wording, Named Insureds, Location Schedule) → one section per line of business, each on its own page with carrier, key facts and tables → Bind Conditions & Notes (only from an uploaded quote) → stand-alone add-ons (only from a quote) → Why Boxwood Insurance Group → Your Service Team (producer, account manager, agency) → footer. Each policy's line gets its own section naming that policy's carrier; the same line on two policies is told apart by policy number.

- **Property** — Covered Causes of Loss, Coinsurance, Valuation, Deductible and peril (wind/hail) deductibles as key facts; "Coverage Limits by Location" one row per location/building (Building / Business Personal Property / Business Income); other subjects and policy-level coverages in "Additional Property Coverages".
- **General Liability** — standard limits as key facts; other GL-line coverages (Employee Benefits, cyber or EPLI endorsements, ...) in "Additional Liability Coverages"; the classification & exposure schedule.
- **Inland Marine** — limits table plus the scheduled equipment list.
- **Commercial Auto** — liability symbols and each coverage at the value most vehicles carry; vehicles that differ are named under "Coverage Notes"; Veh. No. / Description / VIN (last 4) schedule; hired/non-owned auto; drivers.
- **Workers' Compensation** — Statutory, the three Employers Liability limits, Part One states, class/payroll schedule.
- **Umbrella / Excess** — occurrence / aggregate / retention, and an Underlying Coverage Schedule built from the document's own GL, auto and EL lines.
- **Everything else** (Crime, Cyber, D&O, EPLI, E&O, ...) — a Coverage / Limit / Deductible table under the line's own title.

AMS360 has no A.M. Best ratings, enhancement lists or exclusions, so those appear only when an uploaded quote supplies them — never as placeholder text.

**Uploaded quotes.** A quote PDF uploaded on the dashboard is read by Claude. A quoted line takes over the same line's section from the same carrier (carrier, rating, form, limits, highlights, exclusions); AMS360's schedules of what's insured stay. A line from a different carrier — or a line AMS360 doesn't have — gets its own section. Bind conditions and quote validity go to the Bind Conditions section and the cover. Every quote-built section carries a Word comment asking the CSR to verify it (comments never appear in the PDF). Quoted premiums are never printed.

**Carrier-internal coverage codes.** Some carriers record coverages under a bare code (e.g. `WTRBN`, `DPPRM`, `FORMR`) with no description anywhere in the synced AMS360 data. They stay in the document as-is (dropping them would hide a real limit) and come back in the tool's `unresolved_coverage_codes` so the CSR can relabel them by hand — mention them when reporting the result.

### Archiving

Same manifest shape and keying rules as `risk_profile`, under `<OUTPUT_ROOT>/cl-renewal-summary/`, backing `GET /api/v1/boxwood-mcp/cl-renewal-summary/manifest`, `GET`/`DELETE .../cl-renewal-summary/files/:filename`, and `POST .../cl-renewal-summary/chat` (`src/routes/clRenewalSummary.ts`, mirroring the risk-profile routes). The client's requirement is that these be filed to SharePoint (Commercial Lines/Client Renewal Info/<client>/<year>/), not emailed — the local archive is the interim until that Graph access exists.

### Common questions → calls

- "Build a renewal summary for [client]" / "renewal proposal" / "risk profile with limits" → `cl_renewal_summary` with `customer_name`, `polno` or `custid`
- "What are [client]'s GL limits?" as a quick question → `policy_query` is lighter; build this document only when they want the deliverable

## pl_renewal_summary

Builds a branded "Personal Insurance Portfolio Summary" Word document (`.docx`) for a personal-lines client — the personal counterpart to `cl_renewal_summary`, laid out after the client-supplied sample (Patrick Baggett, 2026-09-28): letterhead with the producer's email, "Insured:" and (when there's one carrier) "Carrier:" lines, an Important Notice disclaimer, then short sections. **No premiums.**

### Calling the tool

Same inputs as `cl_renewal_summary` (`customer_name`, `polno`, and/or `custid`, optional `renewal_within_days`) and the same resolution code (`resolveClPolicies` in `src/utils/clPolicyData.ts`, called with `PERSONAL_BOOK`): `typeofbus = 1`, current in-force terms only, `customer_name` matched only among customers with a current personal policy, cross-customer matches ambiguous. Two differences:
- **No default renewal window.** An account-level request combines every in-force personal policy on the account (up to 20), since PL auto's 6-month terms rarely line up with the home's annual term.
- **Downloaded renewals show their renewal term** (Andrew, 2026-09-30). After the shared lookup, `withDownloadedRenewalTerms` (`src/utils/plRenewalTerms.ts`) swaps each in-force policy for its successor term when that renewal has an RWL download, wasn't cancelled at inception, and carries coverage rows. So the client sees what they're renewing into. Swapped policies come back in `shown_on_renewal_term`. Overlapping terms are kept once.
- **One term per policy number.** When the same polno is in force more than once on the account (22 such groups on 2026-09-30, none of them real second policies), `dedupeSamePolicyNumber` keeps one term. The usual causes are an agency-entered $0 "Monoline" placeholder next to the carrier's real term (e.g. Kimbra Morris's 6835594207), a cancel + reissue, or leftover quote terms. It drops a term with no carrier download when a sibling has one, a cancelled-not-reinstated term, and a quote-only term. Of what's left, the most recently downloaded term wins. If the rules can't decide, the result carries `verify_in_ams360` for a rep; the client document never shows it.

No email. The build itself lives in `src/utils/plRenewalSummaryBuild.ts`, shared with the morning job.

### Sections

All coverages come from `afw_coverage` (deduped to each coverage's latest non-deleted row; `afw_cprem` is commercial-only). Rows with no limit and no deductible are rating artifacts (peril premiums, credits, counts) and are skipped.

- **Automobile Insurance** (AUTOP; per-vehicle rows, attachtype 121 → `afw_vehicle.vehid`) — Coverage Highlights: Liability (CSL, or split BI per person / per accident / PD), Uninsured/Underinsured Motorist, UM PD (only alongside a split UM limit), Medical Payments, PIP, Comprehensive and Collision deductibles, Rental Reimbursement, Roadside Assistance. A coverage identical on every vehicle is a highlight; one that differs goes in a separate Coverage by Vehicle table below the Scheduled Vehicles table (Year / Make & Model / VIN), one row per coverage and one column per vehicle, split into several tables past 4 vehicles, with "None" where a vehicle lacks it. Vehicles come only from the auto line's own schedule: an auto + umbrella policy keeps a second copy of the vehicles on the umbrella line, which is ignored, and vehicles are also deduped by VIN. Truncated makes from carrier downloads (SUBA, TOYT, LNDR, MERC, …) are expanded to the full make name.
- **Homeowners Insurance** / **Dwelling Fire Insurance** (HOME / DFIRE; attachtype 86 → `afw_location.locid`, one table per property address) — Dwelling, Other Structures, Personal Property, Loss of Use (shown as "Actual Loss Sustained" when the HOME row carries no limit, as in the client's sample) or Fair Rental Value, Medical Payments, Personal or Premises Liability, Deductible (the Dwelling row's), Wind/Hail Deductible ("1% of Dwelling" for a percentage). Other home endorsements (service line, fungi, loss assessment) are left out, matching the sample. Rating counts ("Number of Autos", "Number of Residences") are never shown, even when a carrier puts a number in their limit field.
- **Personal Articles Coverage** (INMRP): the total scheduled limit, then the full item schedule (Patrick, 2026-09-29). There's one table per class (Jewelry, Fine arts, Guns…) with Item # / Description / Value and the class's scheduled limit (`afw_sppsummary.spplimit`, not the item sum, which runs a few dollars short on integer values). The data comes from `afw_sppitem`, using the latest entered version of each item and class, with deletes dropped. Each class lists its first 50 items, then "…and N more" (one fine-art schedule has 752). Descriptions cut at AMS360's 150-character limit get "…". Classes with no item rows synced keep the total-only line. Scheduled property priced inside a **homeowners** policy is listed the same way under that policy's first property table.
- **Umbrella Liability Insurance** (PUMBR) — Personal Liability, Excess Uninsured/Underinsured Motorist, Self-Insured Retention; no underlying schedule.
- **Any other personal line** (boat, etc.) — a generic Coverage / Limit / Deductible table.
- A line with no coverage detail on file at all (every current FLOOD policy, as of 2026-09-29) still gets its heading, with a note to see the policy documents.

With several carriers (or the same line on two policies), each section shows its own Carrier / Policy # / Term line and the header's "Carrier:" line is dropped. Carrier-internal codes with no description come back in `unresolved_coverage_codes`, same as `cl_renewal_summary`.

### Archiving

Same manifest shape and keying as `cl_renewal_summary`, under `<OUTPUT_ROOT>/pl-renewal-summary/`, backing `GET /api/v1/boxwood-mcp/pl-renewal-summary/manifest`, `GET`/`DELETE .../pl-renewal-summary/files/:filename`, and `POST .../pl-renewal-summary/chat` (`src/routes/plRenewalSummary.ts`), consumed by the employee dashboard's /personal/renewal-summary page. `GET .../pl-renewal-summary/files/:filename/pdf` returns a PDF of the same .docx: headless LibreOffice, cached beside the .docx and removed with it, 503 `converter_unavailable` if LibreOffice isn't installed. An account-level summary is archived as one file per client per soonest upcoming renewal date (`<Client>_<YYYY-MM-DD>_Personal_Insurance_Summary.docx`); a single-policy request, per polid.

**Built automatically** each weekday at 9am CT by `scripts/dailyPlRenewalPremiumChange.ts --job=renewal-summary` (run from `dailyPlRenewalJob.sh`). Every client with a new PL renewal download gets their account-level summary rebuilt. The Renewal Calculator workbooks are a separate 8:30am run of the same script (`--job=premium-change`). Nothing is emailed; OneDrive filing is pending Entra access.

### Common questions → calls

- "Build a personal insurance summary / PL renewal summary for [client]" → `pl_renewal_summary` with `customer_name`
- "Just the policies renewing in the next 60 days" → add `renewal_within_days: 60`

## pl_renewal_premium_change

Fills the PL team's own **Renewal Calculator** workbook (`assets/templates/pl-renewal-calculator.xlsx`, Patrick 2026-09-29) for each personal-lines renewal a carrier downloaded (`afw_policytransaction` `trantype='RWL'`, `source='D'`, `typeofbus=1`). There's one workbook per client per renewal effective date, covering every PL policy renewing that day, whichever day each downloaded. Current vs renewal premium goes per line: Homeowners, Automobile, Personal Articles, Watercraft, Umbrella, Flood, plus spare rows. The template's formulas give the $/monthly/% change. The note block holds only the client's lines plus Account Total, and the same text is returned as a column-aligned `note` for "Copy For AMS".
- **6-month auto:** accounts with a 6-month auto term use the template's 6-month table.
- **Package policies** are split per line from each term's latest transaction.
- **Personal Articles** is carved out of HOME via the SPP premium.
- **Where it's filed:** archived to `<OUTPUT_ROOT>/pl-renewal-premium-change/` for the dashboard's /personal/premium-change-tool page, and built automatically each weekday at 8:30am CT. Nothing is emailed.

### Calling the tool

- Scope by `customer_name` (partial match), `custid`, or `policy_no`, plus `start_date`/`end_date`: the date the renewal *downloaded*, end inclusive. The default is the last 30 days.
- A policy whose premium can't be compared (prior term missing, $0, negative/cancelled) is left out and listed in `excluded` with the reason. It is never estimated.

### How the premiums are chosen (confirmed against 171 real renewals, 2026-09-24)

- **Expiring premium** is the prior term's `fulltermpremium`, the endorsed figure at expiration. It is not the original bound premium, and the difference matters: one Homeowners renewal reads +9.3% against the endorsed figure but −1.5% against the original.
- **Renewal premium** is the new term's `fulltermpremium`.
- **Never `annualizedpremium`.** It's truly annualized, so a 6-month auto term reads about 2×. It's also missing on most prior terms, because AMS360 only started filling it on downloads around Q1 2026.
- **Prior term** is found by `priorpolid`, falling back to same custid + polno only when `priorpolid` is empty (seen on Flood). Don't match terms by polno alone: about 1 in 7 PL renewals change polno (e.g. `HO252129001` → `HO252129002`).
- **Missing premium.** When either side is $0 or missing (every Flood/NFIP renewal so far, plus the odd auto policy), the change is left blank and `note` says why. Report "unavailable", never an infinite or made-up change.

### Common questions → calls

- "How much did [client]'s renewal go up?" → `pl_renewal_premium_change` with `customer_name`
- "Which PL renewals came in this week with big increases?" → `pl_renewal_premium_change` with `start_date`, then sort by `change_percent`
