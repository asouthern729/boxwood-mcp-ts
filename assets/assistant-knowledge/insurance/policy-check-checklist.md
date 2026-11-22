<!-- Snapshot of sections 2 and 3 A-D from the org-synced "policy-check" skill, copied 2026-11-22. Re-copy when the skill changes. -->

# Boxwood Policy Check checklist

Boxwood's accuracy review for account managers: checking that an **issued policy matches what was quoted/bound** (Quote → Issued), or that a **renewal correctly carries forward the expiring policy** with every change intended (Expiring → Renewal). Also check the agency record in AMS360 for change requests, endorsements or activity notes that explain a difference.

## Status codes and priority

Every check row gets exactly one status:

| Status | Meaning | Shading |
|---|---|---|
| **ERROR** | Issued/renewal differs from what was quoted/bound/expiring with no evidence it was intended; or wrong vs a reference doc | Red fill `#F8D7D3`, bold dark red text `#9B1C1C` |
| **MISSING** | Item in the baseline (or required by contract) not found in the compared policy | Red fill `#F8D7D3` |
| **ADDED** | *Quote → Issued mode:* item on the issued policy that was not on the quote/binder (location, building, vehicle, class code, driver, named insured, coverage, endorsement, scheduled item) | Red fill `#F8D7D3`, bold dark red text `#9B1C1C` |
| **CHANGED** | Renewal differs from expiring — may be intended; AM must confirm | Amber fill `#FCEBC7`, text `#8A5300` |
| **VERIFY** | Can't be confirmed from the documents (stale exposure, needs client/carrier answer) | Amber fill `#FCEBC7` |
| **MATCH** | Checked, identical | Light green `#E3F0E7`, text `#2E6B43` |
| **N/A** | Doesn't apply | No fill, grey text |

Give every ERROR / MISSING / CHANGED / VERIFY a priority:
- **1 – Correction needed:** wrong named insured/entity, wrong policy period, missing location/vehicle/coverage line, lower limit or higher deductible than bound, missing AI/waiver/PNC the contract requires, new restrictive exclusion, umbrella underlying mismatch. Usually needs an endorsement request. Every ERROR, MISSING and ADDED is Priority 1 unless it is purely cosmetic.

**Unquoted additions are errors.** In Quote → Issued mode, anything on the issued policy that was not on the quote/binder is an **ADDED — Priority 1 (Correction needed)** item, even if it broadens coverage or the premium impact is small. The policy must match what was bound; the AM either gets written confirmation that the client requested it (bind request, change request or email — if one is among the uploaded documents **or logged in AMS360** (a change request, endorsement transaction or activity note from section 3E), cite it with its date and downgrade to Confirm) or asks the carrier to remove it and re-rate. Include the added item's premium so the correction request shows the dollar effect.
- **2 – Confirm this week:** exposure/class code differences, renewal changes that may be intended, premium differences, stale values, open subjectivities.
- **3 – Housekeeping:** address formatting, punctuation, ZIP+4, form edition changes with no coverage effect, minor wording, informational adequacy checks.


Row highlighting in every table is driven by the item's **priority**, so the AM can tell at a glance what must be fixed vs. tidied up. Use these three colors and no others for flagged rows:

| Priority | Label | Row fill | Text / Pri cell |
|---|---|---|---|
| 1 | **Correction needed** | Red `#F8D7D3` | Bold `#9B1C1C` |
| 2 | **Confirm** | Amber `#FCEBC7` | Bold `#8A5300` |
| 3 | **Housekeeping** | Blue-grey `#DCE6F0` | Bold `#1F4E79` |

- Fill the **whole row** in the priority color (Items to Check First table, detail checklist rows, exposure/vehicle tables, premium schedule rows).
- The Status cell still shows the status word (ERROR / MISSING / CHANGED / VERIFY) in the same priority color.
- MATCH rows: no row fill; green `#E3F0E7` fill with `#2E6B43` text in the Status cell only. N/A rows: no fill, grey text.
- Put a one-line color legend directly under the Items to Check First table: red = Correction needed, amber = Confirm, blue-grey = Housekeeping.

## 3. The checklist

Run every section below. Each check produces a row: Item | Baseline | Compared | Status | Note/Action | Citation. In Expiring → Renewal mode, "Baseline" = Expiring and "Compared" = Renewal.

### A. Basic Information (every policy)
1. **Exact legal name** — first named insured letter-for-letter vs baseline and any reference (ACORD, SOS, W-9). Same name on every line of coverage in the program.
2. **DBA(s)** — present, spelled correctly, shown as DBA (not as a separate entity).
3. **Entity type** — LLC / Corp / Partnership / Individual / Joint Venture matches legal documents and is the same across policies.
4. **Additional named insureds** — every entity on the baseline appears on the issued policy (named insured endorsement). Flag any entity dropped at renewal.
5. **Mailing address** — exact match.
6. **FEIN** (if shown) — matches.
7. **Business locations** — every active storefront, office, warehouse, yard, job site is scheduled; any sold/closed location the client told us about has been removed. In Quote → Issued mode, any location on the policy that is not on the quote/binder is ADDED (Priority 1) — check every coverage part it was rated on (property, GL, umbrella exposure) and list its premium on each. Build a location matrix: Address | Baseline | Compared | Property | GL | WC | Auto garaging | Umbrella.
8. **Description of operations** — matches baseline and what the client does today. Flag new or dropped operations.
9. **Policy period** — effective/expiration dates and time (12:01 AM) match the quote/binder or follow the expiring expiration with no gap or overlap. Umbrella term aligns with underlying.
10. **Carrier / writing company** — the issued writing company matches the quoted company (admitted vs non-admitted, different company in the same group). Flag any change.
11. **Policy number** — recorded; matches binder/AMS360 if available.
12. **Premium, taxes, fees, minimum earned premium, payment plan, audit basis** — match the quote/binder. Renewal: show $ and % change. Any difference feeds the Premium Change Schedule (section 4).

### B. Coverage Limits, Deductibles & Exposures

**Commercial General Liability**
- Each occurrence, general aggregate (and per-project / per-location aggregate if quoted), products-completed operations aggregate, personal & advertising injury, damage to premises rented to you, medical payments
- Deductible/SIR and whether it applies to loss only or loss + expense
- **Class codes and exposures by location** — table: Location | Class code | Description | Exposure basis (sales, payroll, sq ft, units) | Baseline amount | Compared amount | Rate (if shown). Flag different codes, missing classes, missing locations, exposure amounts that changed or didn't change (VERIFY if renewal exposure is identical to expiring for an operation the client says has grown/shrunk)
- Occurrence vs claims-made (retro date if claims-made)

**Commercial Property**
- Per location and per building: building limit, BPP, business income/extra expense, computer/EDP, tenant improvements, signs, outdoor property, spoilage
- Valuation (RC / ACV / functional), coinsurance %, agreed value (and its expiration date), inflation guard
- Cause of loss form (Basic/Broad/Special), deductibles (AOP, wind/hail % or flat, named storm, flood, quake)
- **Locations and limits match the baseline exactly.** Building/occupancy/construction descriptions match
- Mortgagees / loss payees / lender's loss payable: names, addresses, loan numbers match
- Renewal: limits unchanged year over year → VERIFY current replacement cost (flag "values not updated since prior term")

**Business Interruption / Extra Expense**
- Limit, indemnity period / months of coverage, monthly limitation fraction, extended period of indemnity, waiting period (hours), ordinary payroll limitation
- VERIFY limit vs revenue if revenue is known

**Workers' Compensation**
- States in 3.A and 3.C (all states with operations; 3.C not "all states except" a state where they work)
- **Payroll by class code by state** — table: State | Class | Description | Baseline payroll | Compared payroll. Flag missing classes, wrong codes, payroll shifted between classes
- Employers liability limits (each accident / disease-policy / disease-each employee)
- Experience mod and its effective date; officers/owners included or excluded (forms match the election); waiver of subrogation (blanket or scheduled)

**Commercial Auto**
- Liability limit (CSL or split), covered auto symbols for liability, PD, med pay, UM/UIM
- Physical damage: comprehensive and collision deductibles per vehicle; stated amount vs ACV
- **Vehicle schedule** — year / make / model / VIN letter-for-letter, garaging address, cost new/stated amount, coverages per unit. Flag VIN typos, missing/dropped units, units with no PD that had it
- **Hired and non-owned auto** — included? (symbols 8 & 9 or HNOA endorsement). If employees drive personal or rented cars for work and it's absent → MISSING/VERIFY
- Hired auto physical damage; rental reimbursement; towing
- Lienholders / loss payees / additional insured lessors match
- Driver list (if scheduled) matches

**Umbrella / Excess**
- Each occurrence / aggregate / SIR
- **Schedule of underlying** — for each underlying policy: carrier, policy number, term, limits. Must match the issued underlying policies exactly and meet the umbrella's minimum underlying requirements. Check GL, auto, **employers liability**, EBL, liquor, garagekeepers
- **Follow-form vs stand-alone**; exclusions that narrow below the underlying
- **Class codes and exposures** on the umbrella rating (if shown) match the underlying GL/auto/WC exposures
- Drop-down limits match or exceed the primary limits

**Other lines present** (Inland Marine/contractors equipment schedule, Crime, Cyber, EPLI, D&O, Professional, Liquor, Builders Risk): limits, retentions, sublimits, retro dates, scheduled items, and coverage parts match the baseline item-for-item.

### C. Endorsements, Exclusions & Special Provisions
1. **Forms comparison** — compare every form number and edition between baseline and compared. Classify: Added / Removed / Edition changed / Same. Every **added** form must be read and summarized; every **removed** form must be checked for lost coverage.
2. **Named insured & additional insured endorsements** — landlords, vendors, project owners, GCs, lenders that require AI status are on the policy via the right form (blanket vs scheduled; ongoing **and** completed operations where required). Compare to certificate requests/contracts when provided.
3. **Waiver of subrogation** — GL, auto, WC (and umbrella if needed); blanket or scheduled per contract.
4. **Primary & non-contributory** — present where contracts/leases require it.
5. **Exclusions review** — list every exclusion that is new vs baseline or restricts the insured's operations: cyber/data, water damage, mold/fungi, communicable disease, roofing/height, residential/habitational, EIFS, subsidence, designated operations/premises/projects, action-over, classification limitation, total pollution, assault & battery, firearms, wind/hail, protective safeguards. State the operational impact in one line.
6. **Quoted enhancements present** — any coverage extension endorsement, broadening endorsement, or optional coverage on the quote/binder (e.g., contractor's enhancement, EBL, liquor, HNOA, cyber sublimit) is actually attached.
7. **Subjectivities** — any binding subjectivities still open (signed apps, inspections, loss runs, NOC forms).

### D. Loss & Financial Safeguards
1. **Business interruption adequacy** — indemnity period and limits vs revenue/continuing expenses (VERIFY if unknown).
2. **Cyber & EPLI** — present? Limits vs headcount, payments/records handled, digital footprint. Absent → VERIFY ("client has X employees and takes card payments; no EPLI/cyber in program").
3. **Contractual alignment** — when leases, MSAs, equipment leases, or loan covenants are provided: table Requirement | Source doc & section | Policy provides | Status. Check limits, AI, waiver, PNC, notice of cancellation, loss payee, deductibles caps. If none provided, add a single VERIFY row: "Obtain current leases/MSAs/loan agreements to confirm requirements."
