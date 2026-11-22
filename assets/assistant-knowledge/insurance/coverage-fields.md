<!-- Snapshot of references/coverage-fields.md from the org-synced "insurance-proposal" skill, copied 2026-11-22. Re-copy when the skill changes. -->

# Coverage Fields Reference

For each coverage type, extract and display these fields in the per-line table.
Present coverage sections in the order listed below. Omit any row where the field
is not present in the quote.

**Do not add Named Insured, Policy Period, or Annual Premium rows to any per-line
table below** — those are intentionally left off (Named Insured and Policy Period live on the
cover page; Annual Premium lives only in the Premium Summary section). This applies to the
Umbrella section's Table 1 as well. The Stand-Alone Specialty Add-Ons fields at the bottom of
this file are the one exception — that Policy Period row stays, since a specialty add-on's
carrier and term can genuinely differ from the rest of the program.

---

## 1. Commercial Property

| Field | Notes |
|---|---|
| Carrier | |
| Building Limit | |
| Business Personal Property (BPP) | |
| Business Income / Extra Expense | |
| Covered Causes of Loss | Special / Broad / Basic |
| Coinsurance | % |
| Deductible | |
| Wind / Hail Deductible | If separate |
| Flood Coverage | Included / Excluded |
| Earthquake Coverage | Included / Excluded |
| Replacement Cost | Yes / Actual Cash Value |

---

## 2. General Liability (GL)

| Field | Notes |
|---|---|
| Carrier | |
| Each Occurrence | |
| General Aggregate | |
| Products / Completed Operations Aggregate | |
| Personal & Advertising Injury | |
| Medical Payments | Per person |
| Damage to Rented Premises | Per occurrence |
| Primary / Non-Contributory | Yes / No |
| Waiver of Subrogation | Yes / No |
| Additional Insured | Yes / No (and form number if shown) |
| Deductible | |

---

## 3. Liquor Liability

| Field | Notes |
|---|---|
| Carrier | |
| Each Common Cause Limit | |
| Aggregate Limit | |
| Deductible | |
| Coverage Basis | Occurrence or Claims-Made |
| Retroactive Date | If claims-made |
| Host Liquor Liability | Included / Excluded |

---

## 4. Inland Marine

| Field | Notes |
|---|---|
| Carrier | |
| Coverage Form / Type | Contractors Equipment, Installation Floater, EDP, etc. |
| Scheduled Items / Blanket Limit | List key scheduled items if shown |
| Deductible | |
| Covered Causes of Loss | All-Risk / Named Perils |
| Replacement Cost | Yes / Actual Cash Value |

---

## 5. Commercial Auto

| Field | Notes |
|---|---|
| Carrier | |
| Covered Autos (Symbol) | e.g., Symbol 1 = Any Auto |
| Liability — Combined Single Limit | Or split limit if applicable |
| Medical Payments / PIP | |
| Uninsured Motorists | |
| Underinsured Motorists | |
| Comprehensive Deductible | |
| Collision Deductible | |
| Hired Auto Liability | Yes / No |
| Non-Owned Auto Liability | Yes / No |

**Scheduled Vehicle Coverage table** — when the quote lists individual vehicles, add a table
titled "Scheduled Vehicle Coverage" with columns: **Veh. No. | Vehicle Description | VIN**.
**Do not include a per-vehicle Premium column** — vehicle-level premiums stay out of the
proposal entirely; only the line's total Annual Premium appears, and only in the Premium
Summary section.

---

## 5a. Employee Benefits Liability (EBL)

Distinct from Employment Practices Liability (EPLI, #10 below) — EBL covers errors or
omissions in *administering* employee benefit plans (enrollment, claims processing, providing
inaccurate benefits information), not employment-related claims like harassment or wrongful
termination.

| Field | Notes |
|---|---|
| Carrier | |
| Policy Type | Claims-Made (typical) |
| Retroactive Date | |
| Each Occurrence / Each Claim | |
| Aggregate Limit | |
| Deductible | |

---

## 6. Workers' Compensation (WC)

| Field | Notes |
|---|---|
| Carrier | |
| Workers' Compensation | Statutory (Part 1) |
| Employers Liability — BI by Accident | Per accident (Part 2) |
| Employers Liability — BI by Disease (Policy) | Part 2 |
| Employers Liability — BI by Disease (Employee) | Per employee (Part 2) |
| States Covered | |
| Experience Modification Factor | If shown |
| Estimated Annual Payroll | If shown |

---

## 7. Umbrella / Excess Liability

The Umbrella section gets **two tables**, presented back to back.

**Table 1 — Umbrella Policy Details**

| Field | Notes |
|---|---|
| Carrier | |
| Each Occurrence Limit | |
| Aggregate Limit | |
| Self-Insured Retention (SIR) | |
| Drop-Down Provision | Yes / No |

**Table 2 — Underlying Coverage Schedule**

Immediately below Table 1, add a second table with heading "Underlying Coverage Schedule"
(Heading 2 style). This table lists every other coverage line present in the proposal,
pulled from the data already extracted from the other PDFs. Use three columns:

| Coverage Line | Carrier | Applicable Limit |
|---|---|---|
| [e.g. General Liability] | [Carrier name] | [e.g. $1,000,000 / $2,000,000] |
| [e.g. Commercial Auto] | [Carrier name] | [e.g. $1,000,000 CSL] |
| [e.g. Workers' Comp — EL] | [Carrier name] | [e.g. $500,000 / $500,000 / $500,000] |

Include every underlying line found in the uploaded quotes. For each line, use the primary
limit that the umbrella would sit above (per-occurrence for GL/Auto, EL limits for WC,
etc.). If a line is not typically scheduled as an underlying (e.g. D&O, Cyber), still list
it if it appears in the schedule on the umbrella quote itself.

---

## 8. Directors & Officers (D&O)

| Field | Notes |
|---|---|
| Carrier | |
| Coverage Trigger | Claims-Made |
| Retroactive Date | |
| Side A — Individual Protection | Limit |
| Side B — Corporate Reimbursement | Limit |
| Side C / Entity Coverage | Yes / No; Limit if included |
| Each Claim Limit | |
| Aggregate Limit | |
| Retention | |

---

## 9. Cyber Liability

| Field | Notes |
|---|---|
| Carrier | |
| Coverage Trigger | Claims-Made |
| Each Claim / Incident Limit | |
| Aggregate Limit | |
| Retention | |
| First-Party Coverages | Data breach response, ransomware, business interruption, etc. |
| Third-Party Coverages | Network security liability, regulatory defense, etc. |
| Notable Sub-limits | Social engineering, funds transfer fraud, etc. if shown |

---

## 10. Employment Practices Liability (EPLI)

| Field | Notes |
|---|---|
| Carrier | |
| Coverage Trigger | Claims-Made |
| Retroactive Date | |
| Each Claim Limit | |
| Aggregate Limit | |
| Retention | |
| Covered Acts | Wrongful termination, harassment, discrimination, etc. — note if limited |
| Third-Party Liability | Included / Excluded |
| Wage & Hour Defense | Included / Excluded |

---

## 11. Professional Liability / E&O

| Field | Notes |
|---|---|
| Carrier | |
| Coverage Trigger | Claims-Made or Occurrence |
| Retroactive Date | |
| Each Claim Limit | |
| Aggregate Limit | |
| Retention / Deductible | |
| Defense Costs | Inside or Outside limits |
| Profession / Coverage Description | e.g., Tech E&O, Architects & Engineers, etc. |

---

## Enhancement Examples by Coverage Type

These are common enhancements to look for in each quote. Extract anything found on the
quote — these lists are illustrative, not exhaustive.

### Commercial Property
- Ordinance or Law coverage included (and sublimit if shown)
- Equipment Breakdown included
- Spoilage / Refrigeration coverage
- Outdoor Signs, Fences, or Property in the Open sublimit
- Accounts Receivable or Valuable Papers coverage
- Agreed Value (suspends coinsurance)
- Replacement Cost on BPP
- Extended Period of Indemnity (e.g. "60 days beyond restoration")
- Utility Services — Time Element included
- Blanket limit across locations

### General Liability
- Blanket Additional Insured — Ongoing Operations
- Blanket Additional Insured — Completed Operations
- Blanket Waiver of Subrogation
- Primary & Non-Contributory wording
- Employee Benefits Liability (sublimit and deductible)
- Host Liquor Liability included
- Damage to Premises Rented to You — increased sublimit
- Personal & Advertising Injury — broadened definition
- Contractual Liability — broad form
- Medical Payments — increased limit
- Knowledge of Occurrence provision (no late-reporting forfeiture)

### Liquor Liability
- Blanket Additional Insured
- Assault & Battery sublimit included
- Defense costs outside the limit
- Extended Reporting Period (ERP) option terms

### Inland Marine
- Replacement Cost on scheduled items
- Blanket limit (vs. scheduled-only)
- Rented/Leased Equipment included
- Employee Tools sublimit
- Installation Floater — transit and at jobsite
- No coinsurance requirement
- Newly acquired property — automatic coverage period

### Commercial Auto
- Hired Auto Physical Damage included
- Blanket Additional Insured
- Blanket Waiver of Subrogation
- Drive Other Car (DOC) for named individuals
- Uninsured Motorists — stacked limits
- Gap coverage / loan/lease payoff
- Rental Reimbursement sublimit

### Employee Benefits Liability (EBL)
- Retroactive date matches or predates plan inception
- Defense costs outside the limit
- Broad definition of "Employee Benefit Program" (includes unwritten/informal programs)
- Third-Party Claims included (COBRA administration errors, etc.)

### Workers' Compensation
- Waiver of Subrogation — blanket
- Alternate Employer endorsement included
- USL&H (Maritime) coverage included (if applicable)
- Voluntary Compensation included
- Stop-Gap / Employers Liability in monopolistic states
- Foreign Voluntary Workers' Comp included

### Umbrella / Excess
- Drop-down for exhausted aggregate (not just per-occurrence)
- Broad form — follows form to all underlying
- Personal Injury included in umbrella trigger
- Employment-related practices — drop-down provision
- Crisis management expense sublimit

### Directors & Officers (D&O)
- Side A DIC (Difference in Conditions) included
- Investigative costs coverage
- Derivative demand investigation sublimit
- Advancement of defense costs
- Severability of the conduct exclusion
- Prior Acts coverage (retroactive date = inception)
- Run-off / tail coverage terms noted

### Cyber
- Breach Coach / Incident Response services included
- Ransomware / Extortion sublimit
- Funds Transfer Fraud sublimit
- Social Engineering sublimit
- Business Interruption — waiting period (hours)
- Regulatory Fines & Penalties — sublimit and jurisdiction
- PCI-DSS fines coverage
- First-party forensics costs included
- Credit Monitoring sublimit

### Employment Practices Liability (EPLI)
- Third-Party Liability (customers, vendors) included
- Wage & Hour — Defense only or Defense + Indemnity
- Workplace Violence counseling sublimit
- Voluntary Compliance sublimit (EEOC / DOL)
- Separate Side A-style limit for individuals
- ERP (tail) — terms and cost noted

### Professional Liability / E&O
- Defense costs outside the limit
- Automatic ERP — length (e.g. 60 days, 90 days)
- Prior Acts / Full Prior Acts included
- Network Security / Cyber wrapped in
- Disciplinary proceedings coverage
- Personal Injury included
- Subcontractor coverage included

---

## Stand-Alone Specialty Add-Ons

Some quotes cover something that doesn't fit any of the standard lines above — most often a
deductible buy-back (e.g. Wind/Hail), placed with a different (sometimes non-admitted /
surplus-lines) carrier than the rest of the program. Don't force these into the standard
per-line table shape above. Instead follow SECTION 5 in SKILL.md: a plain-language mechanism
paragraph, a "Coverage Terms" Field | Value table, and a schedule table (e.g. "Covered
Premises") with a Total row. Typical fields for a deductible buy-back:

| Field | Notes |
|---|---|
| Coverage Type | e.g. "Wind/Hail Deductible Buy-Back" |
| Carrier | Note if non-admitted / surplus lines, and the underwriting syndicate/agency if shown |
| Policy Basis | Admitted / Non-Admitted / Surplus Lines |
| Policy Period | May differ slightly from the underlying property policy — don't assume they match |
| Maximum Amount Payable | |
| Insured's Retention (Deductible) | The amount the insured still pays before this policy responds |
| Overlying Policy Deductible | The underlying property policy's deductible this sits above (e.g. "2% Per Building") |
