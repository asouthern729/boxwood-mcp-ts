<!-- Snapshot of the purpose, Steps 1-4 and style rules from the org-synced "coverage-comparison" skill (Patrick), copied 2026-11-22. The CL Coverage Comparison tool (src/utils/coverageComparisonAnalysis.ts) sends this as its instructions. Re-copy when the skill changes. -->

# Boxwood Coverage Comparison

Takes **two sets of documents** (Set A and Set B) and produces a branded, printable, letter-size Word document comparing them coverage line by coverage line. Use it for:

- Current program vs proposed program (e.g. Erie vs Travelers/Hartford)
- Quote vs quote (two carriers bidding the same risk)
- Expiring policy vs renewal policy
- Old policy vs new/endorsed policy

Inputs can be any mix of PDFs (dec pages, policies, quotes, proposals, binders), Word files, or a pre-built comparison spreadsheet (e.g. a PowerbrokerAI "Quick Comparison" .xlsx export). Each set may contain several documents (e.g. Set B = Travelers BOP + Travelers umbrella + Hartford WC).

Distinct from: `insurance-proposal` (presents new quotes, no side-by-side), `renewal-premium-comparison` (premium-only plain-text table), `coverage-gap-checklist` (checks against Boxwood standards, not against another document).

## Step 1 — Identify the two sets

From file names, carriers, dates and the request, decide which documents are Set A (baseline: current / expiring / Quote 1) and Set B (comparison: proposed / renewal / Quote 2). If it is ambiguous which file belongs to which set, ask once. Set labels:

- `set_a.label` — column header, e.g. "Current — Erie", "Expiring 2025–26", "Quote A — Cincinnati"
- `set_a.short` — one word used in tags, e.g. "Current", "Expiring", "Quote A"
- Same for `set_b` ("Proposed", "Renewal", "Quote B")

## Step 2 — Extract (never guess)

Read every document fully (pdf skill for PDFs; for a PowerbrokerAI xlsx read each sheet: OVERVIEW, one sheet per line, PREMIUM SUMMARY, FORMS & ENDORSEMENTS). For each coverage line in either set, capture:

- **Limits**, **Deductibles / retentions**, **Exposures** (locations, class codes, payroll, sales, building details), **Terms and conditions** (form type, valuation, coinsurance, audit, binding status, quote validity)
- **Premium** by line and in total, taxes/fees, minimum premiums, optional-limit pricing
- **Forms & endorsements** (form number, edition, description)
- Header facts: carrier/writing company, policy or quote number, policy period, named insured(s), mailing address, locations

Rules:
- Only use values printed in the documents. Missing → null (prints "—") or "Not stated". Never fabricate limits, premiums, or forms.
- Keep carrier wording for limits (e.g. "$2,000,000 each occurrence").
- If Set A documents are for an older term than expected, say so in `glance_notes`.
- Flag internal contradictions inside a document (e.g. a deductible stated and also footnoted as not applying).

## Step 3 — Classify each row

| status | Meaning | Prints as |
|---|---|---|
| `same` | Identical value | "Same" (green, bold) |
| `a_only` | Only in Set A — potential gap | "Current only" (rust, bold) |
| `b_only` | Only in Set B | "Proposed only" |
| `better` | Set B broader/higher | "Better in Proposed" (green) |
| `worse` | Set B narrower/lower | "Reduced in Proposed" (rust, bold) |
| `different` | Different, not clearly better/worse | the `note` text (or "Different") |
| `info` | Just a note | the `note` text |

Add `note` for a short plain-English explanation (don't repeat the tag). Add `flag: true` to force rust/bold on anything the client must look at. Use `better`/`worse` only when objectively clear; otherwise `different`.

A line present in only one set (e.g. WC quoted only in Set B): set `single: "a"` or `"b"` on that line for a 2-column table.

Property-style lines with dozens of one-sided extensions: keep main limits in `sections`, move the one-sided extensions to `extensions` (prints as a compact Coverage | Limit | Coverage | Limit table).

## Step 4 — Key Points to Review

6–12 bullets, each `{lead, text}`, most important first. Cover when applicable:
1. Coverage in Set A missing from Set B (gaps)
2. Reduced limits / higher deductibles / new retentions
3. New coverage or locations added in Set B
4. Exclusions that matter (e.g. professional liability excluded under both)
5. Premium differences, auditable and minimum premiums
6. Items to clarify with the carrier (contradictions, coverage only implied by a form)
7. Deadlines: quote/proposal expiration and effective date

State facts and what to confirm. Do not tell the client which option to buy.

## Style rules (fixed)

- Letter portrait, 0.5" margins, Arial; body 9pt, tables 8.5pt, forms 7.5pt
- Brand green `#459361` headings/table headers; tint `#E3F0E7` total rows; rust `#A0522D` gaps/reductions
- Logo on page 1 only; footer with Boxwood address, phone and page number on every page
- Order: header → At a Glance → Premium Summary → Key Points → (page break) line-by-line tables → (page break) Forms appendix → disclaimer
- Plain-English, factual, no buying recommendation
