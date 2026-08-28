---
name: policies
description: Domain knowledge for the policy_query MCP tool in boxwood-mcp-ts — Boxwood Insurance's AMS360 policy data (policy terms, transactions/endorsements, lines of business, coverage, personnel/commission splits, submissions, renewal chains). Use when answering questions about a specific policy or browsing/searching the book of business by policy.
---

# Boxwood policies

`policy_query` is the anchor tool for policy terms (AMS360's `afw_basicpolinfo` — one row **per policy term**, not per policy-in-general; a renewal creates a new row linked back via `priorpolid`). Every policy belongs to exactly one customer (`custid`).

## Calling the tool

Two modes:
- **Exact lookup** — pass `polid` (uuid). Returns at most one policy; `sort`/`offset`/`limit` are ignored.
- **Browse/search** — no filters returns a paginated list of *all* policy terms. Narrow with any combination of:
  - `polno` — partial match against policy number or short policy number
  - `custid` — policies belonging to one customer (use this to get a customer's full book, current + expired terms)
  - `status` — exact match, single raw AMS360 status char. Only `A`/`C`/`D` appear in this data (no `X`) — and despite the name, `status` does **not** track renewal-chain lifecycle: most currently in-force terms carry `status='C'`, not `'A'`. Don't use it to mean "active/current."
  - `renewalrptflag` — exact match, single char. This is the field that actually identifies the currently in-force term in a renewal chain — pass `"A"` to get only current terms. Passing `"A"` specifically also auto-excludes submission shells, `status='D'` rows, and (client-confirmed 2026-08-27) any bound renewal whose effective date hasn't arrived yet or whose term has already expired — so it means "in force today," not just "the latest bound term." Other observed values: `R` (renewed-over), `C`, `E`, `N`, `Q`, `T`, `W` (rarer, less thoroughly verified) — these don't get the same extra exclusions since they're not a "current" request.
  - `typeofbus` — exact match, integer code. `1` (personal) and `2` (commercial) dominate the book (10,308 and 5,947 policies respectively); `0`/`3`/`4`/`5`/`6`/`7` also appear in small numbers and aren't decoded anywhere (no `afw_constant` lookup built) — don't assume it's strictly binary
  - `carrier_code` — exact match against `afw_basicpolinfo.cocode`
  - `csr_code` — exact match

  `sort` (default `poleffdate_desc`): `poleffdate_asc/desc`, `polno_asc/desc`, `entereddate_asc/desc`. `limit` (default 10, max 50) + `offset` paginate; response includes `has_more`.

Every result already has carrier name, writing-carrier name, exec/CSR name, broker name, payment-plan description, agency notation, and GL division/branch/department/group name resolved inline, plus the customer's last/first/DBA name and `priorpolid`/`sourcepolid` raw ids for renewal-chain tracing.

## `include` options

| include | table(s) | what you get |
|---|---|---|
| `transactions` | `afw_policytransaction` | Every transaction on the term — new business, endorsements, cancellations. Type, description, source, billing method, premium-on-effective-date (`premoneffdate`), annualized premium/revenue |
| `lines_of_business` | `afw_lineofbusiness` + `afw_lobsetup` | The LOB(s) attached to the term (a commercial BOP+GL package is 2 rows; single-LOB personal policies are 1) — code, description, plan type, dates |
| `coverage` | `afw_coverage` | Limits/deductibles/premium per coverage line — up to 3 limits and 3 deductibles per row, coverage code + description |
| `personnel` | `afw_policypersonnel` + `afw_employee` | Who's assigned to the policy and their commission split — role type, primary flag, method, percentage/flat amount, position ranking |
| `submissions` | `afw_submission` + `afw_submissiongroup` | Only relevant while the policy is in submission state (`PolSubType='S'`) — links to sibling submissions quoted to other carriers for the same prospect |
| `attributes` | `afw_policyattribute` + `afw_policyattributetype` | Custom EAV fields the agency defined at the policy level, e.g. "Renewal Priority" |

## Domain gotchas

- **Renewal chains are `priorpolid`/`sourcepolid`, not a "policy history" table.** Each policy *term* is its own `afw_basicpolinfo` row; a renewed policy shows up as a separate `polid` with `priorpolid` pointing back at the prior term's `polid`. To show a customer's multi-year history for one risk, browse `custid` + walk the `priorpolid` chain (or filter `renewalrptflag: "A"` to see just the current term) rather than expecting one row to carry multi-year data.
- **`status` looks like it should mean "active vs. cancelled/expired" but doesn't — use `renewalrptflag` for that instead.** This is a confirmed, previously-shipped mistake (it undercounted the active book by ~8x in `book_summary`/`upcoming_renewals` before being fixed there). `typeofbus`/`poltype`/`polsubtype` are raw AMS360 passthrough codes too, not validated enums — filter with the exact character/int the data uses, don't assume a fixed code list.
- **"Current"/"active" means genuinely in force as of today, not just the latest bound term — client-confirmed 2026-08-21/27.** A renewal can be bound with a future effective date while its predecessor term is still the one actually in force; `renewalrptflag='A'` alone doesn't distinguish the two (both can carry it simultaneously). Any question about the *current* state of the book — "what does this CSR's book look like," "group active policies by producer," etc. — should reflect only policies in force right now. `policy_query`'s `renewalrptflag: "A"` filter and `book_summary` both enforce this (`poleffdate <= today <= polexpdate`, in addition to excluding submission shells and `status='D'`). The one deliberate exception is `upcoming_renewals`, whose whole purpose is surfacing renewals with a future effective date — don't apply this restriction there.
- **`underwriter`, `masteragent`, `ticomid`, `istid` exist on `afw_basicpolinfo` but don't resolve to names.** Their lookup tables (`afw_underwriter`, `afw_masteragent`, `afw_defaulttieredcommission`, `afw_invoicesplittemplate`) aren't built yet — these come back as raw text/ids if selected via `run_query`, and `policy_query`'s core result doesn't surface them at all.
- **`coverage`'s `attachid`/`attachtype` polymorphic pair doesn't resolve** — the `afw_logicaltable` code-to-table lookup behind it is incomplete, so don't try to chase what `attachid` "points to" beyond the coverage row itself.
- **Endorsements live in `transactions`, not as edits to the policy row** — `afw_basicpolinfo.fulltermpremium` is the term total; a mid-term premium change shows up as a new `afw_policytransaction` row (`trantype = 'E'`) with its own `premoneffdate`, not a mutation of the original figure.
- **Timestamp fields (`poleffdate`, `polexpdate`, `changeddate`, `entereddate`, etc.) come back agency-local (`America/Chicago`), not UTC** — e.g. `2026-08-21T00:00:00.000-05:00`. No conversion needed on the caller's end.
- **`changedby` on the core result is a raw AMS360 code (e.g. `!!Z`), not a name — it isn't resolved in this tool's output.** It has no inherent meaning to an end user and should never be surfaced verbatim in an answer. It's an `afw_employee.empcode`, but the code alone doesn't tell you whether a human or a system/integration account made the change (see the `activity` skill's `changed_by_type` classification). If the user needs who changed a record, say that and point at `activity_feed`/`afw_employee` rather than printing the code.
- **Important: `execcode`/`csrcode`/`brokercode`/`anotid`/the GL codes come back raw *alongside* their resolved name fields, not instead of them.** `csrcode` (e.g. `!!C`) sits right next to `csr_lastname`/`csr_firstname` in the same row. Always answer with the resolved name; never quote the raw code to the user, even though it's right there in the JSON. The same goes for `csr_code` when used as a filter — if a name had to be resolved to a code first (e.g. via `employee_lookup`) to build the filter, refer to that person by name in the answer, not by the code you queried with.
- **`transactions`' `source` field (`D`/`I`/`T`) tracks how a transaction reached AMS360, and premium reliability tracks with it.** `D` = carrier download (the ACORD AL3 real-time feed), `I` = manually entered, `T` = bulk transfer (e.g. a customer's whole history reassigned to a new CSR/producer in one batch). Confirmed against real data: `book_summary` CSR-level premium totals matched an external report closely for CSRs whose books were 90%+ `D`-sourced, but were off by up to ~2x for CSRs whose books were mostly `I`/`T` — download-fed policies stay in sync automatically, manually-entered/transferred ones don't. This looked like it might be a sync-coverage gap (AMS360's download table group per the Database Design Guide §8 isn't synced into this database), but checking `AFW_DownLoadTran`'s actual spec ruled that out — it's a processing/matching log (status, matched policy/customer) with no premium column at all, and its own doc comment notes it's AMS360's legacy internal download log, separate from the Data Lake API pipeline this project's ETL uses. So there's currently no source anywhere in this schema to independently verify or correct a manually-sourced/transferred policy's premium — treat `I`/`T`-sourced CSR books as lower-confidence for premium specifically (not customer/policy counts).

## Shared lookup tables joined into every result

- **`afw_company`** — every carrier the agency places business with; `cocode`/`writingcocode` resolve to carrier/writing-carrier name. Also backs `lines_of_business`' `writingcocode`.
- **`afw_paymentplan`** — installment/billing plans (`paypid`); resolves to plan description (e.g. "Agency Bill 10-Pay").
- **`afw_employee`** — resolves `execcode`/`csrcode` here, plus every `personnel` row's `empcode`.
- **`afw_broker`** — resolves `brokercode` when the policy is placed through a broker.
- **The four GL tables** (`afw_generalledgerdivision/branch/department/group`) — resolve the policy's GL division/branch/department/group codes to names.

## Common questions → calls

- "Show me policy BOP-TN-1001" → `polno: "BOP-TN-1001"` (or `polid` if known)
- "What policies does this customer have, including expired ones?" → `custid`, no filter (add `renewalrptflag: "A"` to see only the current term)
- "What's this policy's endorsement history?" → `include: ["transactions"]`, read `trantype`/`description`/`premoneffdate` per row
- "What lines of business are on this commercial account's policy?" → `include: ["lines_of_business"]`
- "Who gets commission on this policy and how is it split?" → `include: ["personnel"]`
- "Show all active WC policies" → `typeofbus: 2` + `renewalrptflag: "A"`, filter results client-side by LOB or check `include: ["lines_of_business"]`
- "Trace this policy's renewal history" → look up the current term, note `priorpolid`, then `polid` lookup on that id, repeating until `priorpolid` is null
