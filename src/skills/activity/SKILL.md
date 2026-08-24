---
name: activity
description: Domain knowledge for the activity_feed MCP tool in boxwood-mcp-ts — Boxwood Insurance's AMS360 audit trail ("what's changed lately"), unioning policy transactions, policy term changes, claims, invoices, and staff activity notes by changeddate/changedby. Use when answering questions about recent activity, an audit trail, or "what happened" across a time window, a customer, or a policy.
---

# Boxwood activity feed

`activity_feed` is the "what's changed" tool — it does not read a raw AMS360 download-processing log (that's an internal message-level report, not available via the synced data), it queries the `changeddate`/`changedby` columns already present on five domain tables and unions them into one timeline. It's additive to `customer_lookup`/`policy_query`/`invoice_lookup`, not a replacement — use those for full record detail, use this for "what happened since X."

## Calling the tool

`since` (required) is either an ISO timestamp or relative shorthand: `"1h"`, `"24h"`, `"7d"`, `"30d"`. Relative shorthand is always computed against real `now()`, independent of `until`. `until` (optional, ISO timestamp) defaults to now.

**Known limitation, not yet fixed:** `since`/`until` are resolved as true UTC instants and compared directly against `changeddate`, which (per the classification note below) actually holds agency-local wall-clock values, not UTC. This means the filtered window is off by the Central offset (5-6 hours) — e.g. `since: "24h"` may include a few extra hours of yesterday's activity or clip a few hours off the near edge, depending on time of day. Output timestamps themselves (`changed_at` in results) are correctly agency-local — this only affects which rows the window boundary includes.

Narrow with any combination of:
- `domains` — subset of `["policy_transaction", "policy", "claim", "invoice", "activity"]`. Defaults to all five.
- `changed_by_type` — `"staff"`, `"system"`, or `"any"` (default). See classification below.
- `custid` / `polid` — scope to one customer or one policy.
- `csr_code` — scope to customers assigned to one CSR (exact match against `afw_customer.csrcode`). This is the customer's CSR, not the policy's — a policy-level `csrcode` (`afw_basicpolinfo`) can differ but isn't checked here. **`csr_code` is a raw, opaque AMS360 employee code (e.g. `!!C`) — it's for querying only.** It doesn't come back in the tool's output, but you'll typically need to resolve a name to a code first (e.g. via `employee_lookup`) to build the filter; when you do, refer to that person by name in your answer, never by the code you queried with.

`group_by` (default `"none"`) adds a `breakdown` array alongside `results`, grouped by `"domain"` or `"changed_by_type"` — a separate count query over the same filters, not a client-side tally. `limit` (default 25, max 200) + `offset` paginate; response includes `has_more`.

## The five domains

| domain | table | row = | notes |
|---|---|---|---|
| `policy_transaction` | `afw_policytransaction` | An endorsement/renewal/cancellation/new-business transaction | Richest signal — `summary` is `trantype: description`. PK is `(polid, effdate)`, so `source_id` is `polid:effdate`, not just `polid` — a policy can have several transactions in the same window. |
| `policy` | `afw_basicpolinfo` | A policy term header change | Catches status/term changes not captured as their own transaction row. `summary` is the raw status code, not decoded (no status lookup exists yet — same as `policy_query`). |
| `claim` | `afw_claim` | A claim record change | `source_id` is the `claimid` — pass it to `claim_lookup` (see the `claims` skill) for full claim detail (cause, loss location, report chain), which this feed doesn't surface beyond the `summary` string. |
| `invoice` | `afw_invoice` | An invoice/billing change | Uses `changeddate`, not `invdate`/`inveffdate` — an invoice can show up here without being newly issued, e.g. a void. |
| `activity` | `afw_transaction` | A staff-logged communication/note | `commenttran` is the summary. The only domain where `changed_by` is regularly a real staff member rather than a system code. |

## `changed_by_type` classification

`changedby` is a real identity/foreign-key value — it renders as an opaque short code (e.g. `"!!Z"`) rather than something human-readable (see `ams360-code-encoding-investigation.md` at the repo root for the open investigation into why), but a given code reliably and consistently resolves to the same `afw_employee` row every time. Matching it against `afw_employee.empcode` is a sound, ordinary FK lookup — that part isn't in question.

**The tool's `changed_by` output field is this raw code, unresolved to a name.** It has no inherent meaning to an end user — never paste it into an answer as if it were an identifier the user could do anything with (e.g. don't say "changed by `!!Z`"). If who-made-the-change matters, resolve the code against `afw_employee` (or use `customer_lookup`'s `service_team`/`policy_query`'s `personnel` include, which already join to `afw_employee` for a name) before answering, or fall back to the `changed_by_type` classification (staff vs. system) below.

What *is* not safe to assume: that "matches an employee row" means "a human did this." **AMS360 represents its own system/integration accounts as real rows in `afw_employee`** — `DBO`, `API Services`, `Conversion Service`, and `Administrator` all have `empcode`s and would pass a naive `changedby IN (SELECT empcode FROM afw_employee)` check as `"staff"`. So classification excludes these explicitly:

```sql
CASE WHEN EXISTS (
  SELECT 1 FROM afw_employee e
  WHERE e.empcode = <changedby>
    AND e.status <> 'S'  -- third-party integrations (zywave, InsuredMine, ...)
    AND lower(e.lastname) NOT IN ('dbo', 'api services', 'conversion service', 'administrator', 'login', 'vertafore', 'test', 'testuser')
) THEN 'staff' ELSE 'system' END
```

The `lastname` list is a maintained set of AMS360's known built-in/vendor accounts, not a guess — confirmed by inspecting `afw_employee` directly (their `status` is usually `'D'`, but not always — `Administrator` shows `status = 'A'`, so `status` alone can't distinguish them). If AMS360 introduces a new built-in account under a name not in this list, it will misclassify as `"staff"` until the list is updated — that's the known limitation here, not the fact that codes are unreadable.

`afw_employee.status` also has real values (`A` active, `I` inactive, `D` deactivated/deleted, `S` third-party service) — former employees aren't removed from the table, they're retained with `status <> 'A'`, so historical `changed_by` attribution for departed staff still resolves correctly to their name.

## Domain gotcha: resolving customer on `activity` rows

`afw_transaction` has a polymorphic `entityid`/`entitytype` pair that can attach a note to non-policy entities. `activity_feed` resolves customer-level activity (not tied to any `polid`) via `entitytype = 4`, confirmed empirically: `afw_logicaltable` (the type-code lookup that would normally back this) is a stub — one placeholder row, no descriptive columns — so this can't be looked up symbolically. `invoice_lookup`'s `activity` include deliberately avoids `entitytype`/`entityid` for exactly this reason and scopes to `polid` only; `activity_feed` diverges from that precedent on purpose, backed by a direct correlation check against `afw_customer` (100% match, 196,650/196,650 rows) rather than a guess. If a row's `entitytype` is something other than `4` and it isn't tied to a `polid` either, `customer_name`/`policy_no` come back `null` — that's expected, not a resolution failure.

## Common questions → calls

- "What's changed in the last 24 hours?" → `since: "24h"`
- "What's happened on this policy?" → `since: "30d"` (or wider), `polid: "..."`
- "Any billing activity for this customer this month?" → `since: "30d"`, `custid: "..."`, `domains: ["invoice"]`
- "Break down last week's activity by type" → `since: "7d"`, `group_by: "domain"`
- "What has staff (not the download) touched recently?" → `changed_by_type: "staff"`
- "Show me claim activity in the last quarter" → `since: "90d"`, `domains: ["claim"]`
- "What recent activity impacts Kimbra's customers?" → `since: "7d"` (or whatever window), `csr_code: "<Kimbra's empcode>"` (look it up via `employee_lookup` if you only have her name)
