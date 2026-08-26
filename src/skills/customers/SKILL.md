---
name: customers
description: Domain knowledge for the customer_lookup MCP tool in boxwood-mcp-ts — Boxwood Insurance's AMS360 customer data (profiles, contacts, dependents, loss history, relationships, cross-references, expiring outside business, service team). Use when answering questions about a customer/prospect or browsing/searching the customer book of business.
---

# Boxwood customers

`customer_lookup` is the anchor tool for everything about a customer, prospect, or suspect (AMS360's `afw_customer` table — one row per entity, commercial or personal). Every other domain (policies, invoices) hangs off `custid`.

## Calling the tool

Two modes:
- **Exact lookup** — pass `custid` (uuid) or `custno` (int). Returns at most one customer; `sort`/`offset`/`limit` are ignored.
- **Browse/search** — no filters returns a paginated list of *all* customers. Narrow with any combination of:
  - `name` — partial match (ILIKE) against last name, first name, DBA, or firm/business name
  - `active` — exact `"Y"`/`"N"`
  - `city` — partial match
  - `state` — exact 2-letter code
  - `producer_code` / `csr_code` — exact match against `afw_customer.prod1code` / `csrcode`

  `sort` (default `lastname_asc`): `lastname_asc/desc`, `custno_asc/desc`, `entereddate_asc/desc`. `limit` (default 10, max 50) + `offset` paginate; response includes `has_more`.

Every result already has producer/CSR name, broker name, GL division/branch/department/group name, and agency notation resolved inline — no need to separately look up `prod1code`/`csrcode`/`brokercode`/`anotid`/GL codes.

## `include` options

Pass an array of any of these to attach related record sets to each customer:

| include | table(s) | what you get |
|---|---|---|
| `contacts` | `afw_custcontact` | Named contacts at the account (officers, directors, other) — name, title, officer/director flags, email/phone |
| `dependents` | `afw_dependent` | Spouse/children/other household members — name, DOB, relationship, marital status |
| `loss_history` | `afw_custlosshist` | Claim/loss summary rows — carrier, policy #, cause, dates, status, description. `amount paid` is also selected but is NOT reliable — see the `claims` skill's gotcha on this before quoting it |
| `attributes` | `afw_customerattribute` + `afw_customerattributetype` | Custom EAV fields the agency defined (name + typed value), e.g. "Referral Source" |
| `relationships` | `afw_customerrelationship` + `afw_relationship` + `afw_relationshiptype` | Household/business relationship links (e.g. spousal, multi-entity groupings) with role (Primary/Secondary/Member) |
| `xrefs` | `afw_custxref` + `afw_agencyxreftype` | Cross-reference IDs to other systems (e.g. legacy AMS ID), with the reference type label |
| `expiring_business` | `afw_xdate` | Outside business the customer holds elsewhere, tracked for solicitation — competitor, expiration date, premium, interest level |
| `service_team` | `afw_custaddpersonnel` + `afw_employee` | Agency staff assigned beyond the primary producer/CSR, by role and line of business |

## Domain gotchas

- **`lastname`/`firstname`/`dba` are all null for ~39% of customers (1,170 of 3,011) — use `firmnamecust` as the name in that case.** This is common for commercial accounts recorded under a business name rather than a person/DBA. `firmnamecust` is selected in the core result and included in the `name` filter's search, but it's easy to miss if you only look at `lastname`/`firstname`/`dba` and conclude the customer has no name on file.
- **PII is excluded at the database grant level, not just left out of the query.** `afw_customer.ssn`/`driverslicense`/`fedidno` and `afw_dependent.ssn`/`driverslicense` are not selectable by the role this tool runs as — a direct `run_query` against those columns returns `permission denied`, it isn't just omitted from `customer_lookup`'s output. Don't imply they could be fetched another way.
- **`mastersubtype`/`mastercustid`** encode Multiple Entity setups — `mastersubtype` is `M` (master) or `S` (sub), and a sub-customer's `mastercustid` points back to the master. Useful for "who are the related entities on this commercial account."
- **`active`, `typecust`, and other single-char fields are raw AMS360 passthrough codes, not enums** — e.g. `typecust` is `C` (commercial, 1,780 of 3,004) or `P` (personal, 1,224) in the current book, but treat any single-char field as "whatever the source system sent," not a fixed list to validate against.
- **Timestamp fields (`changeddate`, `entereddate`, dependents' `dob`) come back agency-local (`America/Chicago`), not UTC** — e.g. `2026-08-21T14:00:00.000-05:00`. No conversion needed on the caller's end.
- **`changedby` on the core result is a raw AMS360 code (e.g. `!!Z`), not a name — it isn't resolved in this tool's output.** It has no inherent meaning to an end user and should never be surfaced verbatim in an answer. It's an `afw_employee.empcode`, but the code alone doesn't tell you whether a human or a system/integration account made the change (see the `activity` skill's `changed_by_type` classification). If the user needs who changed a record, say that and point at `activity_feed`/`afw_employee` rather than printing the code.
- **Important: `prod1code`/`csrcode`/`brokercode`/`anotid`/the GL codes come back raw *alongside* their resolved name fields, not instead of them.** The tool doesn't drop the code — `csrcode` (e.g. `!!C`) sits right next to `csr_lastname`/`csr_firstname` in the same row. Always answer with the resolved name; never quote the raw code to the user, even though it's right there in the JSON. The same goes for `producer_code`/`csr_code` when you use them as filters — if you had to resolve a name to a code first (e.g. via `employee_lookup`) to build the filter, refer to that person by name in your answer, not by the code you queried with.
- **`loss_history` here is a summary, not the full claim.** Full claim detail (loss location, report authority, catastrophe code, etc.) lives in `afw_claim` — use `claim_lookup(claimid=...)` (see the `claims` skill) with `loss_history`'s `claimid` to get it, rather than trying to find more detail in this tool's output.

## Shared lookup tables joined into every result

- **`afw_employee`** — every agency staff member (producers, CSRs, etc.), keyed by `empcode`. Backs `prod1code`/`csrcode` resolution here, plus every `service_team` row's `empcode`.
- **`afw_broker`** — brokers the agency places business through; `brokercode` resolves to broker name when a customer's business runs through one (mostly commercial accounts).
- **The four GL tables** (`afw_generalledgerdivision/branch/department/group`) — the agency's business-unit hierarchy (Division → Branch → Department → Group). Resolve a customer's `gldivcode`/`glbrnchcode`/`gldeptcode`/`glgrpcode` to names; only meaningful for agencies actually segmenting by these levels.

## Common questions → calls

- "Look up customer 1012" → `custno: 1012`
- "Find customers named Smith" → `name: "Smith"` (matches both first *and* last name — expect multiple hits; disambiguate by address/DOB/producer)
- "Who are John Smith's dependents?" → `custno`/`name` lookup with `include: ["dependents"]`
- "What's this commercial account's claims history?" → `include: ["loss_history"]`
- "Which prospects have outside business expiring soon we could quote?" → browse with `active: "N"` (or no filter) + `include: ["expiring_business"]`, inspect `expdate`/`interestlevel`
- "Who's on the service team for this account besides the CSR?" → `include: ["service_team"]`
- "Show me all active commercial customers in Franklin sorted by name" → `city: "Franklin"`, `active: "Y"`, default `sort`
