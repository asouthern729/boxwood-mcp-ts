---
name: certificates
description: Domain knowledge for the certificate_lookup MCP tool in boxwood-mcp-ts — Boxwood Insurance's AMS360 certificates of insurance (COIs), who holds them, and what policies they cover. Use when answering questions about a certificate, resending/checking a certificate holder, or an insurance-domain question about what a certificate does or doesn't do.
---

# Boxwood certificates of insurance

`certificate_lookup` is the anchor tool for issued certificates of insurance (AMS360's `afw_certliabprop` — one row per certificate). A **certificate of insurance (COI)** is proof of coverage handed to a third party who isn't the insured — a general contractor requiring proof of a subcontractor's liability coverage before letting them on a jobsite, a commercial landlord requiring proof from a tenant, a lender requiring proof of property coverage before closing. It's issued *about* the customer's policy, to someone who isn't a party to that policy.

## Calling the tool

Two modes:
- **Exact lookup** — pass `crtid` (uuid). Returns at most one certificate; `sort`/`offset`/`limit` are ignored.
- **Browse/search** — no filters returns a paginated list of *all* certificates. Narrow with any combination of:
  - `custid` — certificates belonging to one customer
  - `crtno` — partial match against certificate number
  - `certformtype` — exact match, `L` (liability) or `P` (property)

  `sort` (default `entereddate_desc`): `entereddate_asc/desc`, `crtno_asc/desc`. `limit` (default 10, max 50) + `offset` paginate; response includes `has_more`.

Every result already has the customer's name, the current certificate holder's name/address/contact/issue date, and up to 9 covered policies resolved (policy number + carrier name) — no follow-up query needed for the common case.

## `include` options

| include | table | what you get |
|---|---|---|
| `holder_history` | `afw_certholderinfo` | Every prior holder snapshot for this certificate, not just the current one — see "reissues" below for why this can be a long list |

## Domain gotchas

- **The most important thing about a COI: it confers no rights, and holding one doesn't add anyone to a policy.** A certificate is purely informational — "this customer had this coverage as of this date." The real ACORD certificate form itself says as much ("issued as a matter of information only... confers no rights upon the certificate holder"). If a user asks "does this GC have coverage" because they hold a certificate, the honest answer is "the certificate says the customer *had* coverage as of its issue date, not that the GC is protected by it" — being handed a certificate and being an **additional insured** (below) are very different things, and this tool's data doesn't distinguish who understands that difference.
- **Certificate holder ≠ additional insured ≠ waiver of subrogation — three different, easily-confused concepts, and this schema has fields for all three:**
  - **Certificate holder** (the bulk of this tool's data, `afw_certholderinfo`) — just received a piece of paper. No legal standing on the policy itself.
  - **Additional insured** (`isaddlinsuredgenl`/`isaddlinsuredautol`/`isaddlinsuredgarl`/`isaddlinsuredgark`/`isaddlinsuredumbl`/`isaddlinsuredother` — all `Y`/`N`, all present on every `certificate_lookup` result) — actually endorsed onto the policy as a covered party for that specific line of coverage. This is a real underwriting change, not paperwork.
  - **Waiver of subrogation** (`iswaivegl`/`iswaiveauto`/`iswaivegarl`/`iswaivegark`/`iswaiveexcess`/`iswaivewc`/`iswaiveother` — also on every result) — the insurer agrees to give up its right to recover a claim payout from this specific party after paying a loss. Different from both of the above: it doesn't add anyone to the policy or hand them rights, it just limits the insurer's own recovery options.

  All three can be true or false independently for the same certificate holder. Don't assume "they have a certificate" implies either of the other two.
- **The additional-insured/waiver-of-subrogation flags above are currently always `null` — confirmed via the raw Data Lake API response, not a sync bug on this project's end.** Checked all 885 real certificates in this database: every `isaddlinsured*`/`iswaive*` flag is `null` on every single row, and the raw API response itself returns `null` before this project's sync even touches it. So right now, this tool **cannot actually answer** "is this holder an additional insured" from the data — that has to come from checking the policy's own endorsements (not currently exposed by any tool) or asking the agency directly. Don't present a `null` value here as "no, not an additional insured" — it means "unknown from this data," which is a different and more honest answer.
- **A certificate gets reissued/resent far more often than you'd expect — confirmed ~11 `afw_certholderinfo` snapshots per certificate on average.** This isn't duplicate/dirty data: a contractor customer might resend the *same* certificate record to a new GC every time they land a job, or a landlord's cert gets reissued at each lease renewal. `current_holder_*` on the core result is only the most recent snapshot (by `certissuedatecrth`, falling back to `entereddate`) — always check `include: ["holder_history"]` before assuming "this is the only time this cert was ever sent to anyone."
- **`certformtype`: `L` = liability (the common case — general liability/auto/WC proof), `P` = property.** Don't confuse a property-type certificate with **Evidence of Property Insurance**, a related but separate AMS360 document family (`AFW_EvidenceOfProp`/`AFW_EvidenceOfPropAOI`) aimed at lienholders/mortgagees rather than a certificate holder — **that data isn't synced/queryable via this tool at all**, only `afw_certliabprop`/`afw_certholderinfo` are.
- **Slots 7, 8, 9 of `covered_policies` have fixed special meanings, unlike slots 1-6.** A certificate can reference up to 9 policies; slot 7 is always Cargo, slot 8 is always Trailer Interchange, slot 9 is always Garage Keepers (per AMS360's own spec) — these show up in `slot_label` when populated. Slots 1-6 can be any general line of business and have no fixed meaning; `slot_label` is `null` for those.
- **Not everything cert-related is in this tool.** AMS360 also has a reusable "saved certificate holder" master list per customer (`AFW_CustCertHolder`, for autofill when issuing a *new* certificate in the AMS360 UI) — this table isn't synced/available via this data source at all, so `certificate_lookup` can only show holders from certificates that have actually been issued, not a customer's roster of likely-future holders.
- **`attachid`/`attachtype` on the underlying tables don't resolve to anything** — same incomplete `afw_logicaltable` mapping gap as everywhere else in this schema (see the `policies` skill). Not surfaced in this tool's output for that reason.
- **`changedby` is a raw AMS360 employee code (e.g. `!!]`), not a name — not resolved in this tool's output.** It has no meaning to an end user. If the user needs who last touched a certificate, point at `employee_lookup` rather than printing the code.
- **Timestamp fields come back agency-local (`America/Chicago`), not UTC** — no conversion needed on the caller's end.

## Shared lookup tables joined into every result

- **`afw_customer`** — resolves the certificate's owning customer to a display name (falls back through firstname/lastname → firmnamecust → dba, same precedence as `customer_lookup`).
- **`afw_basicpolinfo`** + **`afw_company`** — resolve each of the up to 9 covered-policy ids to a policy number and carrier name.

## Common questions → calls

- "Does this customer have any certificates on file?" → `custid`, no other filters (or `customer_lookup`'s `certificates` include for a quicker, current-holder-only glance without leaving that tool)
- "Who's the current holder of certificate CL2682702314?" → `crtno: "CL2682702314"`, read `current_holder_name`/`current_holder_city`/`current_holder_state`
- "Has this certificate ever been sent to anyone besides the current holder?" → look up the certificate, `include: ["holder_history"]`
- "What policies does this certificate actually cover?" → look up the certificate, read `covered_policies` (already resolved, no follow-up `policy_query` needed)
- "Is this landlord actually covered under the policy, or did we just send them a certificate?" → check the `isaddlinsuredgenl`/etc. flags on the certificate, not just whether a holder record exists — see the additional-insured gotcha above
- "Show me all the property certificates for this customer" → `custid`, `certformtype: "P"`
