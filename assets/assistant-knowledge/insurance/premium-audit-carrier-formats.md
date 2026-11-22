<!-- Snapshot of references/carrier-formats.md from the org-synced "premium-audit-summary" skill, copied 2026-11-22. Re-copy when the skill changes. -->

# Carrier Statement Formats

Every carrier presents audit results differently, and each format has a specific way of being
misread. This file records the ones Boxwood has seen, what to extract from each, and the
mistake each one invites. Read the section for the carrier in front of you before extracting.

## Contents
1. The universal rule: reconcile against the carrier's own printed totals
2. Cincinnati Insurance — GL (form IA 405)
3. Cincinnati Indemnity — WC final audit (form WC 98 06)
4. Cincinnati Specialty Underwriters — surplus lines GL (forms CSIA 405 / CSIA 411)
5. Frankenmuth — GL audit premium notice (form FM-939)
6. Frankenmuth — WC audit premium notice (form WC 99 04 01)
7. Travelers — Premium Adjustment Notice packet (WC)
8. Internal Boxwood comparison spreadsheets
9. Deriving estimated exposures when the carrier doesn't print them

---

## 1. The universal rule

Every one of these statements prints its own totals. Before building anything, sum the extracted
rows and confirm they equal the carrier's printed totals exactly, to the dollar. If they don't,
something was missed — almost always a column or a second rate line, not a typo.

This single check would have caught every extraction error made so far. Do it every time,
including on statements that look simple.

---

## 2. Cincinnati Insurance — GL (form IA 405, "Liability Premium Adjustment Statement")

**The trap, and it is the big one: every class is rated twice.** The statement has paired
columns throughout — RATES, DEPOSIT PREMIUM, EARNED PREMIUM and DIFFERENCE each split into
Prod/Comp and All Other. A class that carries both produces **two physical lines** for the same
class code and the same exposure figure. The second line is indented differently because its
numbers sit in the left column of each pair.

Read it this way: the right-hand value of each pair is All Other; the left-hand value is
Products/Completed Operations. A class with only one line has All Other premium only.

Combine both lines into one premium per class. Taking only the All Other line understates the
result — on one real account it turned a $988 net additional premium into a reported $1,934,
because the Prod/Comp side on subcontracted work was a $946 return that should have offset it.

**Verify with the totals block on the last page.** It prints Total Earned Premium, Deposit
Premium and Additional/Return Premium as Prod/Comp and All Other pairs, then NET ADDITIONAL
PREMIUM. Your combined per-class figures must sum to those pairs, and the net must match.

**Other notes:**
- Premium basis is the letter before the exposure figure: P payroll, C cost, S sales, A area,
  O each/other. Normalize per `plain-english.md` §2.
- Rates on P and C bases are per $1,000. On O they're per unit.
- Classes 29923 and 29975 (Contractors Broadened Liability) routinely appear as two identical
  rows on the same basis. They are two separate coverage grants, not a duplicate. Keep both,
  and exclude that basis from the payroll and subcontracted cost totals.
- Policy period and term of audit differ on two-year policies. The document's Premium Term is
  the **term of audit**; show the full policy period separately in the Policy Detail block.
- Estimated exposures are **not printed**. See §9.

## 3. Cincinnati Indemnity — WC final audit (form WC 98 06)

Page 1 carries the summary: Final Audited Premium, Deposit Premium, Taxes/Assessments, and
Additional Premium Due Now. Page 3 onward carries Classification of Operations.

- Class rows give actual exposure, rate per $100 of remuneration, and earned premium. **No
  estimated exposure and no per-class deposit breakdown** — the deposit is a single lump sum.
  Build the exposure table with a Rate column and audited figures only unless the estimated
  exposures can be sourced elsewhere (dec page, or an internal comparison sheet).
- Below the classes comes Manual Premium, then rating elements that are not classifications:
  9807 employers liability increased limits, 9898 experience modification, 0063 premium
  discount, 9724 waiver of subrogation, 0900 expense constant, 9740 terrorism, 9741 catastrophe.
  These go in the Rating Adjustments table, never in the exposure table — putting them there
  strands the payroll total below them and makes surcharges look like classes.
- The experience modification is usually the largest single item on the statement and is worth
  calling out in the narrative. A mod above 1.00 is a surcharge on loss history; say so plainly.
- Check the chain: manual premium → +employers liability → ×mod → −discount → +waiver →
  State Premium → +expense constant +terrorism +catastrophe → State Total = Final Audited.

## 4. Cincinnati Specialty Underwriters — surplus lines GL (CSIA 405 / CSIA 411)

Two documents arrive together and they do not agree, by design.

- **CSIA 405-A**, the Liability Premium Adjustment Statement, ends at additional premium plus a
  5% policy processing fee.
- **CSIA 411**, the Policy Change Endorsement, is what actually gets billed. It adds surplus
  lines tax (5%) and a clearinghouse fee on top.

Use the endorsement's figures as the billed amounts, and give the client the whole stack in the
Total Amount Due section — premium, PPF, tax, fee, total. A client shown only the premium change
will be surprised by the invoice, which is exactly what this document exists to prevent.

Expect a dollar or two of rounding disagreement between the two forms. The endorsement is
authoritative; the tax will compute cleanly off its figure. Flag the difference to the user, not
in the document.

Note also that the amended dec page folds the audit charge into Total Policy Premium, so that
figure is not the original deposit. Don't read the deposit off an amended dec.

## 5. Frankenmuth — GL audit premium notice (form FM-939)

Watch for **"Final Audit Revision"** in the header. A revision compares PRIOR AUDITED against
REVISED AUDITED, not an estimate against an audit.

- The box labeled "Estimated Premium" on a revision is **not** the estimate. It equals the prior
  audit's total. Set `est_label` to "Prior Audited" and `aud_label` to "Revised Audited" so the
  document doesn't repeat the carrier's misleading label.
- Premium splits into Premises/Operations and Products columns. Combine them per class.
- A revision usually means a reclassification. Check whether total exposure changed: if the
  prior and revised exposure totals are identical, nothing about the business changed and the
  entire adjustment comes from moving exposure between class codes. Say that in the narrative,
  and give the client the rate comparison between the two classes, since that's the whole story.
- "ADJUSTMENT TO PRIOR AUDITED PREMIUM: RETURN" means money back. Do not present it as owed.

## 6. Frankenmuth — WC audit premium notice (form WC 99 04 01)

The friendliest format of the set: estimated exposure, audited exposure, rate, estimated premium
and audited premium all printed per class. Rating elements (0900, 9740, 9741, 9807, 9848, 9898)
appear in the same table and both estimated and audited are given, so the Rating Adjustments
table can carry both columns here.

Experience rating shows as a negative when the mod is below 1.00. Keep the sign.

## 7. Travelers — Premium Adjustment Notice packet (WC)

Arrives as one PDF containing four stapled sub-documents. Identify each by the code in the
bottom-left footer rather than by page number, since the premium calculation runs onto a second
page on most accounts:

| Footer | Sub-document | What it carries |
|---|---|---|
| `CLAUPA1E` | Premium Adjustment Notice, page 1 | Header block and the first part of the premium calculation |
| `CLAUPA2A` | Premium Adjustment Notice, page 2 | Remainder of the calculation, then the totals roll-up |
| `CLAUEXP1` | Exposure Comparison | Estimated vs. audited payroll by class — the only place estimates appear |
| `CLAUCIP1` | Commission Information | Account month, premium/charge, commission rate |

**The header box is the reconciliation.** It prints Total Premium/Charge (earned), Total Prior to
Audit (already billed), and Return Premium/Charge. Map these straight onto `audited_premium`,
`estimated_premium`, and the difference. Note that "Total Prior to Audit" is not a deposit
premium in the Cincinnati sense — it's everything applied to the term, so it already includes any
mid-term endorsement activity.

**Sign convention.** A negative Return Premium/Charge is money back to the insured. Verify against
earned minus prior rather than trusting the label, and never present a return as owed.

**The packet is marked "NOT A BILL".** Travelers credits a return under separate cover, and bills
additional premium separately too. Say so in What Happens Next; the client will otherwise wait for
a document that never arrives.

**Premium calculation lines are transaction-code driven.** Only the first is a classification:

| Tr Cd | Line | Basis |
|---|---|---|
| Class code (e.g. `8008`) | The classification itself | Audited payroll, rate per $100 |
| `0930` | Blanket Waiver, and Balance to Waiver Minimum | Manual premium, then a flat balancing charge |
| `9812` / `9848` | Employers Liability Increased Limits, and its minimum | Manual premium, then flat |
| `9887` | Schedule Credit — negative | Subtotal of everything above it |
| `0900` | Expense Constant | Flat |
| `9740` | Certified Terrorism | Payroll |
| `9741` | Catastrophe — Other Than Certified Terrorism | Payroll |

The roll-up at the end always runs Total Premium → Premium Location → Total Premium/Charge →
Total [State] → Total Premium/Charge, all equal on a single-location account.

**Two internal checks that catch a misread immediately.** The schedule credit's exposure basis
equals the sum of every line above it, and the whole column sums to Total Premium. On a real
account: 733 + 15 + 235 + 10 + 140 = 1,133, which is exactly the credit's basis; the full column
then sums to $1,226, matching the header box.

**Rendering choice for this carrier: use `fees` with `fees_itemized: false`.** The transaction
codes and rates are Travelers bookkeeping, and the charges themselves — expense constant, waiver
minimums, increased limits minimum, terrorism, catastrophe — are fixed items the insured has no
say over. Print the total alone under a heading like "Workers' Compensation Fees and Charges".
Still record every individual line in the `fees` array: class premium plus fees must equal the
audited premium, and that check can't be made from a lump sum. On a real account, $733 of class
premium plus $493 of fees reaches the $1,226 in the header box.

Include the schedule credit in the fees array even though it's a credit — leaving it out breaks
the reconciliation by $91.

**Omit the Rate column from the exposure table.** A single rate per $100 of payroll adds nothing
next to the estimated and audited exposure figures, and the narrative can state it in words.

**Per-class estimated premium is not printed.** Only the class's audited premium appears. Supply
`aud_premium` and omit `est_premium` so the column drops; the reconciliation still works off the
policy-level figures from the header box. Deriving it from estimated payroll × rate is possible
but unnecessary, and per §9 a derived figure has to be disclosed.

**Commission.** The commission page gives the rate, so the agency's chargeback on a return is
return × rate. That figure is for internal discussion only — never put it in the client document.

**Watch for related insureds across separate packets.** Travelers writes through several
underwriting entities (Travelers Commercial Casualty, NAIC 29815; The Travelers Indemnity Company,
NAIC 11347). Two commonly-owned insureds at one address can sit in different companies on the same
class code at materially different rates and schedule credits. That's worth raising with the
producer ahead of the common renewal, but it belongs in the chat, not the client document.

## 8. Internal Boxwood comparison spreadsheets

These often arrive alongside the carrier documents. Treat them as a **second source to
reconcile against**, not as the source of truth, and treat any disagreement as something to
resolve with the user before building.

- Two lines of business are commonly laid out as side-by-side column blocks on one sheet (GL in
  columns A–F, WC in H–M). Detect each block by its own "Line of Business" label; parsing the
  sheet as one table silently merges two policies.
- Known failure modes actually observed: only the All Other column captured from a Cincinnati GL
  statement; a payroll total that omits the clerical class; a transposed class code; a premium
  basis labeled Total Cost on a payroll-rated class; an adjustment amount typed into a cell
  labeled Audited Premium.
- Where the spreadsheet holds something the carrier doesn't print — usually the real estimated
  exposures from the dec page — prefer it over anything derived, after checking that estimated
  exposure × rate reproduces the carrier's deposit premium.

## 9. Deriving estimated exposures when the carrier doesn't print them

Cincinnati GL prints deposit premium and rate but no estimated exposure. Estimated exposure =
deposit premium ÷ rate × 1,000 for payroll and cost bases, or ÷ rate for each/other bases.

This is reliable. On a real account it reproduced $9,000,000, $150,000, $3,088,000 and $428,000
as exact round figures, and on another it landed within $500 of the dec page's actual values.

Two cautions:
- Where the deposit premium is tiny, the derivation is imprecise — a $40 deposit at rate 0.509
  is consistent with anything from roughly $77,600 to $79,600 of payroll. Say "approximately."
- Always prefer a sourced figure. Ask whether a dec page or internal comparison sheet exists
  before deriving.

When any estimated figure in the document is derived rather than printed, say so in the Notes
block of that section. The client is entitled to know which numbers came from the carrier.
