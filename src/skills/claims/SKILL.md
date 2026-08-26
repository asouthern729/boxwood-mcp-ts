---
name: claims
description: Domain knowledge for the claim_lookup MCP tool in boxwood-mcp-ts — Boxwood Insurance's AMS360 claim data (cause of loss, loss location, report chain, status, catastrophe code). Use when answering questions about a specific claim or browsing/searching claims for a customer or policy.
---

# Boxwood claims

`claim_lookup` is the anchor tool for full claim detail (AMS360's `afw_claim` — one row per claim). It fills the gap `customer_lookup`'s `loss_history` include leaves: that include only returns the summary row from `afw_custlosshist` (carrier, policy #, dates, amount paid); this tool returns the claim itself (cause, loss location, report chain, description). A claim belongs to exactly one policy (`polid`); `afw_claim` has no `custid` column of its own — customer scoping goes through `afw_basicpolinfo`.

## Calling the tool

Two modes:
- **Exact lookup** — pass `claimid` (uuid). Returns at most one claim; `sort`/`offset`/`limit` are ignored.
- **Browse/search** — no filters returns a paginated list of *all* claims. Narrow with any combination of:
  - `polid` — claims on one specific policy
  - `custid` — claims across all of a customer's policies (joins through `afw_basicpolinfo`)
  - `claimno` — partial match against claim number
  - `claimstatus` — exact match against the descriptive status text (see below — not a code)
  - `causeofloss` — partial match against cause of loss (also descriptive text, not a code)

  `sort` (default `lossdate_desc`): `lossdate_asc/desc`, `reportdate_asc/desc`, `entereddate_asc/desc`. `limit` (default 10, max 50) + `offset` paginate; response includes `has_more`.

Every result already has policy number, customer name/DBA, and line-of-business description resolved inline.

## `include` options

| include | table(s) | what you get |
|---|---|---|
| `loss_history` | `afw_custlosshist` | The matching summary row(s) from the customer's loss history for this claim — confirmed 1:1 with `afw_claim` in the current book (every claim has exactly one summary row and vice versa). This is the same data `customer_lookup`'s `loss_history` include shows from the other direction. |

## Domain gotchas

- **`claimstatus` and `causeofloss` are already human-readable descriptive text, not codes** — e.g. `claimstatus` is "Open", "Closed", "Re-opened", "Closed, no claim", etc.; `causeofloss` is "Hail", "Fire", "Water damage", etc. No decoding needed, and both are safe to filter/display directly. **`status` is different** — a single-char raw AMS360 passthrough code (`A`/`D` in the current book), same pattern as `status` fields elsewhere in this domain; don't confuse the two.
- **`catcode` (catastrophe code) and `elfformid` (electronic loss form ID) don't resolve to anything.** No lookup table exists for either — `catcode` is `NULL` on every claim in the current book (field exists, unused so far), and `elfformid` is populated on a minority of claims with no `afw_elfform`-style table behind it. Same treatment as `policy_query`'s undecoded `underwriter`/`masteragent`/`ticomid`/`istid` — passed through raw if selected, not resolved to a name/label.
- **`changedby` is a raw AMS360 code (e.g. `!!Z`), not a name — it isn't resolved in this tool's output.** It has no inherent meaning to an end user and should never be surfaced verbatim in an answer. See the `activity` skill's `changed_by_type` classification for how to reason about it if the user needs who changed a claim record.
- **`poleffdate`/`polexpdate`/`polenddate` on the claim row are a snapshot of the policy's term dates at the time of the claim** — they can diverge from the *current* `afw_basicpolinfo` row if the policy has since renewed. Use `polid` to look up the live policy via `policy_query` if current term dates matter.
- **There is no reliable claim payment/dollar figure anywhere in this data — don't report one, and don't read a low or missing amount as "no cost."** `afw_claim` itself has no payment/reserve/incurred column at all. `afw_custlosshist.amountpaid` (surfaced via this tool's `loss_history` include, `customer_lookup`'s `loss_history` include, and `book_summary`'s `claims_paid_total`) is populated on only 14 of 1,195 claims (1%) — the other 99% come back `NULL`, which `SUM()` silently treats as zero rather than "unknown." This looks like a sync-coverage gap, not a real absence of data: AMS360's Data Lake API exposes a dedicated `afw_claimpayment` table (plus `afw_claimremark`/`afw_claiminjured`/`afw_claimpropdamage`/`afw_claimriskinfo`), none of which are part of this database's current sync — that's an infrastructure fix outside this codebase, not something `run_query`/a different join here can recover. If asked about claims cost/paid amounts, say the data isn't reliably available rather than quoting `amountpaid` or `claims_paid_total`.
- **Timestamp fields (`lossdate`, `occurrencedate`, `reportdate`, `closeddate`, `changeddate`, `entereddate`) come back agency-local (`America/Chicago`), not UTC.** No conversion needed on the caller's end.

## Shared lookup tables joined into every result

- **`afw_basicpolinfo`** — resolves `polid` to policy number and the owning `custid` (one join level, does not pull the full policy record — use `policy_query` for that).
- **`afw_customer`** — resolves the policy's `custid` to customer name/DBA.
- **`afw_lobsetup`** — resolves the claim's own `lineofbus` text to a line-of-business description, same join `policy_query`'s `lines_of_business` include uses.

## Common questions → calls

- "Show claim CLM-1042" → `claimno: "CLM-1042"` (or `claimid` if known)
- "What claims does this customer have?" → `custid: "..."`
- "What's the claims history on this policy?" → `polid: "..."`
- "Any open claims right now?" → `claimstatus: "Open"` (check exact status text first — statuses like "Re-opened" or "Open, in Litigation" won't match an exact `"Open"` filter)
- "Any hail claims this book?" → `causeofloss: "Hail"`
- "What's the full detail behind this loss-history row?" → take the `claimid` from `customer_lookup`'s `loss_history` include and look it up here
- "What's the full detail behind this claim activity from the activity feed?" → take the `source_id` from an `activity_feed` row where `domain: "claim"` and look it up here as `claimid`
