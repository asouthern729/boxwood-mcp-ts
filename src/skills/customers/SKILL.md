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
  - `name` — partial match (ILIKE) against last name, first name, or DBA
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
| `loss_history` | `afw_custlosshist` | Claim/loss summary rows — carrier, policy #, cause, dates, amount paid, status, description |
| `attributes` | `afw_customerattribute` + `afw_customerattributetype` | Custom EAV fields the agency defined (name + typed value), e.g. "Referral Source" |
| `relationships` | `afw_customerrelationship` + `afw_relationship` + `afw_relationshiptype` | Household/business relationship links (e.g. spousal, multi-entity groupings) with role (Primary/Secondary/Member) |
| `xrefs` | `afw_custxref` + `afw_agencyxreftype` | Cross-reference IDs to other systems (e.g. legacy AMS ID), with the reference type label |
| `expiring_business` | `afw_xdate` | Outside business the customer holds elsewhere, tracked for solicitation — competitor, expiration date, premium, interest level |
| `service_team` | `afw_custaddpersonnel` + `afw_employee` | Agency staff assigned beyond the primary producer/CSR, by role and line of business |

## Domain gotchas

- **PII is excluded at the database grant level, not just left out of the query.** `afw_customer.ssn`/`driverslicense`/`fedidno` and `afw_dependent.ssn`/`driverslicense` are not selectable by the role this tool runs as — a direct `run_query` against those columns returns `permission denied`, it isn't just omitted from `customer_lookup`'s output. Don't imply they could be fetched another way.
- **`mastersubtype`/`mastercustid`** encode Multiple Entity setups — `mastersubtype` is `M` (master) or `S` (sub), and a sub-customer's `mastercustid` points back to the master. Useful for "who are the related entities on this commercial account."
- **`active`, `typecust`, and other single-char fields are raw AMS360 passthrough codes, not enums** — e.g. `typecust` is `C` (commercial) or `P` (personal) in the seed data, but treat any single-char field as "whatever the source system sent," not a fixed list to validate against.
- **`loss_history` here is a summary, not the full claim.** Full claim detail (loss location, report authority, catastrophe code, etc.) lives in `afw_claim`, which isn't exposed through any current MCP tool — `loss_history`'s `claimid` is the join key if that ever needs deeper detail via `run_query`.

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
- "Show me all active commercial customers in Tyneside sorted by name" → `city: "Tyneside"`, `active: "Y"`, default `sort`
