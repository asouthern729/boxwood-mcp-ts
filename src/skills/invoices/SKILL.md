---
name: invoices
description: Domain knowledge for the invoice_lookup MCP tool in boxwood-mcp-ts — Boxwood Insurance's AMS360 billing/AR data (invoices, void/correction chains, installment billing, related policy activity log). Use when answering questions about billing, invoice history, or outstanding balances for a customer or policy.
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
  - `closedstatus` — exact `"Y"`/`"N"` — `"N"` is the closest thing to "outstanding/unpaid"
  - `invtype` — exact match, integer code (raw AMS360 passthrough, no fixed enum resolved yet — `afw_constant` isn't built)

  `sort` (default `inveffdate_desc`): `inveffdate_asc/desc`, `invno_asc/desc`, `duedate_asc/desc`. `limit` (default 10, max 50) + `offset` paginate; response includes `has_more`.

Every result already has customer name, policy number, broker name, exec/rep name, original/void invoice numbers (when applicable), and GL division/branch/department/group name resolved inline.

## `include` options

| include | table(s) | what you get |
|---|---|---|
| `activity` | `afw_transaction` | The policy's activity/communication log (calls, emails, notes) tied via `polid` — type, date, comment, which employee logged it |

Only one include exists today. It attaches to the invoice's `polid` — invoices with no `polid` (pure customer-level invoices) get an empty array back.

## Domain gotchas

- **`originalinvidinv`/`voidinvidinv` are the correction-tracking pair.** When an invoice gets corrected, the original is marked `iscancelled = "Y"` with `voidinvidinv` pointing at its replacement; the replacement carries `originalinvidinv` pointing back. Both directions resolve to an invoice number in the core query (`original_invno`/`void_invno`) — always check these before treating a cancelled invoice's amount as real.
- **`closedstatus`/`arclosedstatus` are separate concepts** — `closedstatus` tracks the invoice's own workflow state, `arclosedstatus` tracks whether it's closed on the AR (accounts-receivable) side. A `"N"` on `closedstatus` is the practical proxy for "still outstanding," not `arclosedstatus`.
- **`polrelation` tells you whether an invoice is policy-specific or customer-level** — don't assume every invoice ties to one policy; a customer-level invoice (fees, adjustments) can have `polid IS NULL`.
- **The `activity` include is scoped by `polid`, not the raw entity/activity link.** `afw_transaction` actually has a separate polymorphic `entityid`/`entitytype` pair that can attach an activity to non-policy entities (a bank, broker, company, employee, vendor) too — this tool deliberately joins on `polid` instead, because `entitytype`'s code-to-table lookup (`afw_logicaltable`) is still incomplete and can't reliably resolve back to a customer. So `activity` only ever shows policy-tied entries, not every logged interaction with the customer.
- **`invtype` is a raw int code, not resolved to a label** — `afw_constant` (the general constants/enum table it points to) isn't built yet, so filter by the exact numeric value the data uses rather than a name.
- **Timestamp fields (`invdate`, `inveffdate`, `duedate`, `changeddate`, `entereddate`) come back agency-local (`America/Chicago`), not UTC** — e.g. `2026-08-21T00:00:00.000-05:00`. No conversion needed on the caller's end.
- **`changedby` on the core result, and `empcode`/`execcode`/`csrcode` on the `activity` include, are raw AMS360 codes (e.g. `!!Z`), not names — none of them are resolved in this tool's output.** They have no inherent meaning to an end user and should never be surfaced verbatim in an answer. These are `afw_employee.empcode` values, but the code alone doesn't tell you whether a human or a system/integration account made the change (see the `activity` skill's `changed_by_type` classification). If the user needs who logged an activity or changed a record, say that and point at `activity_feed`/`afw_employee` rather than printing the code.

## Shared lookup tables joined into every result

- **`afw_customer`** — resolves `custid` to name/DBA.
- **`afw_basicpolinfo`** — resolves `polid` to policy number (join is one level, does not pull the full policy record — use `policy_query` for that).
- **`afw_broker`** — resolves `brokercode` when relevant.
- **`afw_employee`** — resolves `execcode` and `repcode`.
- **The four GL tables** (`afw_generalledgerdivision/branch/department/group`) — resolve the invoice's GL division/branch/department/group codes to names.

## Common questions → calls

- "Show invoice #5012" → `invno: 5012`
- "What's this customer's billing history?" → `custid`, default sort (`inveffdate_desc`) shows most recent first
- "What invoices are still outstanding for this policy?" → `polid` + `closedstatus: "N"`
- "Was this invoice corrected?" → look up by `invid`/`invno`, check `original_invno`/`void_invno` and `iscancelled` in the result
- "What's the activity log around this policy's billing?" → `polid` lookup with `include: ["activity"]`
- "Any cancelled/voided invoices for this account this year?" → `custid` + `iscancelled: "Y"`
