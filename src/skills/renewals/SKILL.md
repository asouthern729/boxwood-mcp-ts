---
name: renewals
description: Domain knowledge for the upcoming_renewals MCP tool in boxwood-mcp-ts — Boxwood Insurance's AMS360 book of business filtered to active policy terms expiring within a day window, with marketing shells, expired terms, and already-renewed terms excluded. Use when answering questions about what's renewing soon, a producer's or carrier's upcoming renewal book, or which accounts need renewal outreach.
---

# Boxwood upcoming renewals

`upcoming_renewals` answers "what's expiring soon and still needs attention?" — it is not a generic `polexpdate` sort. `policy_query` has no `polexpdate` sort/filter at all today, and even if it did, a naive "active + expiring in N days" query is mostly noise: roughly 80% of policies that look like they're expiring soon already have a renewal term booked (see exclusion logic below). This tool exists specifically to strip that noise out.

## Calling the tool

`within_days` (default 30, max 365) is the only required concept — how far out to look from real `now()`. Narrow with any combination of:
- `producer_code` — exact match against `afw_basicpolinfo.execcode` (the producer/agent of record, distinct from CSR)
- `csr_code` — exact match against `afw_basicpolinfo.csrcode`
- `carrier_code` — exact match against `afw_basicpolinfo.cocode`
- `typeofbus` — exact match, integer code. `1` (personal) and `2` (commercial) dominate the book; other codes (`0`, `3`-`7`) also appear in small numbers and aren't decoded anywhere — don't assume it's strictly binary

`group_by` (default `"none"`) adds a `breakdown` array grouped by `"producer"` or `"carrier"` — a separate count query over the same filters, not a client-side tally. Each breakdown row is `{ code, label, count }`. `limit` (default 25, max 200) + `offset` paginate; response includes `has_more`. Results are always sorted `polexpdate` ascending — soonest-expiring first — there's no `sort` param.

## What's excluded, and why

Every result satisfies all four of these, unconditionally — they aren't optional filters:

- **`renewalrptflag = 'A'`** — only the currently-active term in each renewal chain. `afw_basicpolinfo.status` looks like it should mean this but doesn't: in this data most currently-in-force terms carry `status = 'C'`, not `'A'` — `status='A'` alone undercounts the true active book by roughly 8x. `renewalrptflag` is the field that actually tracks renewal-chain lifecycle (`A`=active/current, `R`=renewed-over, `C`=cancelled, `E`=expired, plus a few rarer codes).
- **`polsubtype != 'S'`** — excludes marketing/submission shells (see `policies` skill), which have a `polexpdate` but represent a shopped quote, not a real bound risk.
- **Already-renewed exclusion** — a term is dropped if any other `afw_basicpolinfo` row's `priorpolid` already points back at its `polid` (i.e. a successor term already exists via `NOT EXISTS (... WHERE bp2.priorpolid = p.polid)`). **This is the load-bearing filter, not a nice-to-have**: a naive `status='A' AND polsubtype != 'S'` query in a 30-day window returns ~5x more rows than after this exclusion — the difference is entirely policies that already have a booked renewal term sitting in the data, just not the one that's technically "expiring."
- **`polexpdate` within the window** — `BETWEEN now() AND now() + within_days`.

Note: `policy_query`'s `renewalrptflag: "A"` filter and `book_summary` both additionally require `poleffdate <= today` (client-confirmed 2026-08-27, so a bound-but-not-yet-started renewal doesn't count as part of the "current" book). This tool deliberately does **not** apply that restriction — a future-dated renewal that's already bound is precisely what makes an about-to-expire term excluded here via the already-renewed exclusion above, and is exactly the kind of row this tool's own purpose requires being able to detect.

## `has_renewal_activity`

A boolean per row: `true` if `afw_policytransaction` has a row for this `polid` with `trantype IN ('RWL', 'RWQ')` (renewal / renewal-quote). This is a *narrower* signal than the already-renewed exclusion above — a row can pass the exclusion (no successor term exists yet) and still have `has_renewal_activity: true`, meaning a renewal has been quoted/bound but the new term hasn't synced as its own `afw_basicpolinfo` row yet. Use it to distinguish "renewal already in motion, don't call this account" from "nothing's happened, needs outreach."

There are three other renewal-adjacent `trantype` codes in the data (`RWX`, `RRQ`, `RWR`) that are **not** included in this flag — they're undecoded (no lookup table backs `trantype`) and rare enough (under 40 rows combined, vs. ~9,500 for `RWL`/`RWQ`) that including them without knowing what they mean risked false positives. If a caller needs those, they show up via `policy_query`'s `include: ["transactions"]` on the specific `polid`.

## Domain gotcha: output timestamps are agency-local

`poleffdate`/`polexpdate` (and any other timestamp field surfaced) come back agency-local (`America/Chicago`), not UTC — e.g. `2026-09-01T00:00:00.000-05:00`. No conversion needed on the caller's end.

## Domain gotcha: producer vs. CSR

`execcode` is the producer/agent of record (who sold and owns the account); `csrcode` is the customer service rep (who services it day-to-day). They're frequently different people. `producer_code` filters on `execcode` — if a request says "CSR" instead of "producer" or "agent," use `csr_code` instead.

`execcode`/`csrcode` are always resolved to a producer/CSR name in the core result (`exec_lastname`/`exec_firstname`, `csr_lastname`/`csr_firstname`) and in the `producer` breakdown's `label`. **But the raw code still comes back too, right alongside the name — `p.csrcode`/`p.execcode` are selected as-is in the core result, and the breakdown row's `code` field is the raw employee code (e.g. `!!C`) by design.** Always answer with the resolved name; never quote `csrcode`/`execcode`/breakdown `code` to the user — it's an opaque AMS360 identifier with no meaning to them, even when it happens to render as short text. This applies equally to `producer_code`/`csr_code` used as filters: if a name had to be resolved to a code first (e.g. via `employee_lookup`) to build the filter, refer to that person by name in the answer, not by the code you queried with. If this tool is ever extended to expose another employee-linked field, resolve it to a name in the output and keep this same rule in mind.

## Common questions → calls

- "What's renewing in the next 30 days?" → `within_days: 30` (the default — can omit)
- "What's Blake Lambert's renewal book look like for next quarter?" → `within_days: 90, producer_code: "<lambert's execcode>"`
- "Any commercial renewals coming up this month?" → `within_days: 30, typeofbus: 2`
- "How many renewals per producer in the next 30 days?" → `within_days: 30, group_by: "producer"`
- "Which of these still need outreach vs. are already in motion?" → check `has_renewal_activity` per row
