---
name: invoices
description: Domain knowledge for the invoice_lookup MCP tool in boxwood-mcp-ts — Boxwood Insurance's AMS360 billing/AR data (invoices, void/correction chains, installment billing, related policy activity log). Use when answering questions about invoice history for a customer or policy. Does NOT cover outstanding balances/dollar amounts — afw_invoice has no such column.
---

# Boxwood invoices

`invoice_lookup` is the anchor tool for billing (AMS360's `afw_invoice` — one row per invoice header). An invoice can be policy-specific or customer-level (`polrelation`), so `custid` and `polid` are both nullable on the underlying table even though most seed/real invoices carry both.

## Calling the tool

Two modes:
- **Exact lookup** — pass `invid` (uuid) or `invno` (int). Returns at most one invoice; `sort`/`offset`/`limit` are ignored.
- **Browse/search** — no filters returns a paginated list of *all* invoices. Narrow with any combination of:
  - `custid` — invoices for a customer (across all their policies)
  - `polid` — invoices for one specific policy term
  - `iscancelled` — exact `"Y"`/`"N"`
  - `closedstatus` — exact match, but NOT `"Y"`/`"N"` despite how that reads — real values are `"A"` (the overwhelming majority) and `"X"` (rare, ~2 rows in 55k). What `"X"` actually signifies isn't confirmed yet, so don't treat this as an "outstanding balance" filter (see gotcha below — this tool has no dollar amounts at all).
  - `invtype` — exact match, integer code (raw AMS360 passthrough, no fixed enum resolved yet — `afw_constant` isn't built)

  `sort` (default `inveffdate_desc`): `inveffdate_asc/desc`, `invno_asc/desc`, `duedate_asc/desc`. `limit` (default 10, max 50) + `offset` paginate; response includes `has_more`.

Every result already has customer name, policy number, broker name, exec/rep name, original/void invoice numbers (when applicable), and GL division/branch/department/group name resolved inline.

## `include` options

| include | table(s) | what you get |
|---|---|---|
| `activity` | `afw_transaction` | The policy's activity/communication log (calls, emails, notes) tied via `polid` — `trantype` + resolved `trantype_description` (via `afw_prcode`, `AttrCode='TT'`, as of 2026-09-01), date, comment, which employee logged it |

Only one include exists today. It attaches to the invoice's `polid` — invoices with no `polid` (pure customer-level invoices) get an empty array back.

## Domain gotchas

- **`originalinvidinv`/`voidinvidinv` are the correction-tracking pair.** When an invoice gets corrected, the original is marked `iscancelled = "Y"` with `voidinvidinv` pointing at its replacement; the replacement carries `originalinvidinv` pointing back. Both directions resolve to an invoice number in the core query (`original_invno`/`void_invno`) — always check these before treating a cancelled invoice's amount as real.
- **`afw_invoice` has no dollar-amount column at all — this tool cannot answer "outstanding balance" questions.** There's no premium/fee/tax/total/balance field on the invoice row, and `CORE_QUERY` doesn't select one because none exists. Real premium figures live on `afw_policytranpremium`, keyed by `polid`/`poltpid`/`effdate` — not by `invid` — so there's currently no schema path from an invoice to a dollar figure. If asked about outstanding balances, say this tool can't answer that rather than guessing from `closedstatus`.
- **`closedstatus`/`arclosedstatus` are separate concepts, and neither is a Y/N flag** — `closedstatus` tracks the invoice's own workflow state, `arclosedstatus` tracks whether it's closed on the AR (accounts-receivable) side. Real values are `"A"`/`"X"`, not `"Y"`/`"N"`; `"X"` is rare enough (~2 of 55k rows) that its exact meaning isn't confirmed. Don't treat either as a reliable "still outstanding" proxy.
- **`polrelation` tells you whether an invoice is policy-specific or customer-level** — don't assume every invoice ties to one policy; a customer-level invoice (fees, adjustments) can have `polid IS NULL`.
- **`billmethod` resolves to `billmethod_description` as of 2026-09-01** — via `_code_lookup` (`category='billmethod'`, hardcoded in the Guide's prose, not `afw_prcode`-backed): `A`=Agency Bill, `P`=Direct Bill. Same code/meaning as `policy_query`'s `afw_basicpolinfo.billmethod` (confirmed identical A/P distribution shape on both tables) — one shared `_code_lookup` category covers both. On-account invoices (`invtype` 101+) commonly have `billmethod IS NULL` — that's expected, not a data gap.
- **The `activity` include is scoped by `polid`, not the raw entity/activity link.** `afw_transaction` actually has a separate polymorphic `entityid`/`entitytype` pair that can attach an activity to non-policy entities (a bank, broker, company, employee, vendor) too — this tool deliberately joins on `polid` instead, because `entitytype`'s code-to-table lookup (`afw_logicaltable`) is still incomplete and can't reliably resolve back to a customer. So `activity` only ever shows policy-tied entries, not every logged interaction with the customer.
- **`invtype` resolves to `invtype_description` as of 2026-09-01** — via `_code_lookup` (`category='invtype'`), not `afw_constant` directly: `afw_constant` (built 2026-09-01, 7,420 rows) is AMS360's general system-constants table spanning far more than invoicing, with no description column of its own (`constantname` like `INV_TYPE_OA_AGCYCUSTPOL` isn't a clean label) — `_code_lookup` holds prettified labels instead. Two underlying constant groups feed this field (`INV_TYPE`: 1=Agency Bill, 2=Direct Bill, 3=Commission Statement, 4=Direct Bill Entry, 17=Beginning Balance; `INV_TYPE_OA`: 101-108, on-account invoice variants) — confirmed against real data that both groups are actually in use for this tenant (101/102 appear on real on-account invoices, not just theoretically), and their numeric ranges don't collide, so a plain code match against `_code_lookup` is safe. Still filter by the exact numeric value, just use `invtype_description` to display it.
- **Timestamp fields (`invdate`, `inveffdate`, `duedate`, `changeddate`, `entereddate`) come back agency-local (`America/Chicago`), not UTC** — e.g. `2026-08-21T00:00:00.000-05:00`. No conversion needed on the caller's end.
- **`changedby` on the core result, and `empcode`/`execcode`/`csrcode` on the `activity` include, are raw AMS360 codes (e.g. `!!Z`), not names — none of them are resolved in this tool's output.** They have no inherent meaning to an end user and should never be surfaced verbatim in an answer. These are `afw_employee.empcode` values, but the code alone doesn't tell you whether a human or a system/integration account made the change (see the `activity` skill's `changed_by_type` classification). If the user needs who logged an activity or changed a record, say that and point at `activity_feed`/`afw_employee` rather than printing the code.
- **Important: unlike the `activity` include, the core result's `execcode`/`brokercode` *are* resolved — but the raw code still comes back alongside the resolved name, not in place of it.** `execcode` (e.g. `!!C`) sits right next to `exec_lastname`/`exec_firstname` in the same row. Always answer with the resolved name; never quote the raw code to the user just because it's present in the JSON.

## Shared lookup tables joined into every result

- **`afw_customer`** — resolves `custid` to name/DBA.
- **`afw_basicpolinfo`** — resolves `polid` to policy number (join is one level, does not pull the full policy record — use `policy_query` for that).
- **`afw_broker`** — resolves `brokercode` when relevant.
- **`afw_employee`** — resolves `execcode` and `repcode`.
- **The four GL tables** (`afw_generalledgerdivision/branch/department/group`) — resolve the invoice's GL division/branch/department/group codes to names.

## Common questions → calls

- "Show invoice #5012" → `invno: 5012`
- "What's this customer's billing history?" → `custid`, default sort (`inveffdate_desc`) shows most recent first
- "What invoices are still outstanding for this policy?" → not answerable by this tool — `afw_invoice` has no dollar-amount/balance column, and `closedstatus` isn't a reliable outstanding-balance proxy (see gotcha above). Say so rather than filtering on `closedstatus`.
- "Was this invoice corrected?" → look up by `invid`/`invno`, check `original_invno`/`void_invno` and `iscancelled` in the result
- "What's the activity log around this policy's billing?" → `polid` lookup with `include: ["activity"]`
- "Any cancelled/voided invoices for this account this year?" → `custid` + `iscancelled: "Y"`
