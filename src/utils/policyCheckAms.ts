import { runReadOnlyQuery } from "../db.js"
import { logger } from "./logger.js"

// AMS360 side of the CL Policy Check (skill section 3E): the agency's record of the policies being
// checked, pulled straight from the data lake rather than by a chat calling tools, so every check
// gets the same cross-check. The analysis call (policyCheckAnalysis.ts) receives this as JSON and
// uses it to resolve or downgrade findings. Never carries internal ids or employee codes into the
// result — names only, per the skill.

export type AmsPolicyTerm = {
  policy_number: string
  term: string
  status: string
  current_term: boolean
  carrier: string | null
  writing_company: string | null
  full_term_premium: number | null
  payment_plan: string | null
  bill_method: string | null
  lines_of_business: string[]
  transactions: { effective: string; type: string; description: string; annualized_premium: number | null; entered: string }[]
}

export type AmsCrossCheck = {
  pulled_at: string
  customer: { number: string | null; name: string; csr: string | null; producer: string | null } | null
  matched_on: "policy_number" | "named_insured" | null
  checked_policies: AmsPolicyTerm[]
  other_in_force_policies: { policy_number: string; term: string; carrier: string | null; lines_of_business: string[]; full_term_premium: number | null }[]
  activity_notes: { date: string; policy_number: string | null; by: string | null; note: string }[]
  notes: string[]
}

const normalizePolno = (value: string) => value.replace(/[^A-Za-z0-9]/g, "").toUpperCase()

const ymd = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : "")

const money = (value: unknown) => (value === null || value === undefined || value === "" ? null : Number(value))

const personName = (first: unknown, last: unknown) => [first, last].filter((part) => typeof part === "string" && part.trim()).join(" ").trim() || null

// Commercial lines only (typeofbus 2), per the skill — an employee-benefits record with a similar
// name is ignored.
const POLICY_COLUMNS = `
  p.polid, p.custid, p.polno, p.poleffdate, p.polexpdate, p.status, p.renewalrptflag, p.fulltermpremium,
  p.billmethod, bm.description AS billmethod_description, pp.description AS payment_plan,
  co.name AS carrier_name, wco.name AS writing_carrier_name
`
const POLICY_JOINS = `
  LEFT JOIN afw_company co ON p.cocode = co.cocode
  LEFT JOIN afw_company wco ON p.writingcocode = wco.cocode
  LEFT JOIN afw_paymentplan pp ON p.paypid = pp.paypid
  LEFT JOIN _code_lookup bm ON bm.category = 'billmethod' AND bm.code = p.billmethod
`

type PolicyRow = {
  polid: string; custid: string; polno: string; poleffdate: string; polexpdate: string; status: string; renewalrptflag: string
  fulltermpremium: string | null; billmethod_description: string | null; payment_plan: string | null
  carrier_name: string | null; writing_carrier_name: string | null
}

async function policiesByNumber(polnos: string[]): Promise<PolicyRow[]> {
  const wanted = [...new Set(polnos.map(normalizePolno).filter((p) => p.length >= 4))]
  if(wanted.length === 0) return []
  const rows = await runReadOnlyQuery(`
    SELECT ${ POLICY_COLUMNS }
    FROM afw_basicpolinfo p ${ POLICY_JOINS }
    WHERE p.typeofbus = 2 AND upper(regexp_replace(p.polno, '[^A-Za-z0-9]', '', 'g')) = ANY($1::text[])
    ORDER BY p.poleffdate DESC
  `, [wanted])
  return rows as unknown as PolicyRow[]
}

async function customerByName(name: string): Promise<string | null> {
  const cleaned = name.replace(/[,.]/g, " ").replace(/\b(LLC|L L C|INC|CORP|CO|LTD|DBA)\b/gi, " ").replace(/\s+/g, " ").trim()
  if(cleaned.length < 3) return null
  const rows = await runReadOnlyQuery(`
    SELECT DISTINCT c.custid
    FROM afw_customer c
    JOIN afw_basicpolinfo p ON p.custid = c.custid AND p.typeofbus = 2
    WHERE COALESCE(c.dba, '') ILIKE $1 OR COALESCE(c.firmnamecust, '') ILIKE $1 OR COALESCE(c.lastname, '') ILIKE $1
    LIMIT 2
  `, [`%${ cleaned }%`])
  // Only a single unambiguous match counts; two possible customers is worse than none.
  return rows.length === 1 ? (rows[0] as unknown as { custid: string }).custid : null
}

async function customerSummary(custid: string): Promise<AmsCrossCheck["customer"]> {
  const rows = await runReadOnlyQuery(`
    SELECT c.custno, COALESCE(c.firmnamecust, c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), '')) AS name,
      csr.firstname AS csr_first, csr.lastname AS csr_last, ex.firstname AS ex_first, ex.lastname AS ex_last
    FROM afw_customer c
    LEFT JOIN afw_employee csr ON csr.empcode = c.csrcode
    LEFT JOIN afw_employee ex ON ex.empcode = c.prod1code
    WHERE c.custid = $1
  `, [custid])
  const row = rows[0] as Record<string, unknown> | undefined
  if(!row) return null
  return {
    number: row.custno === null || row.custno === undefined ? null : String(row.custno),
    name: String(row.name ?? ""),
    csr: personName(row.csr_first, row.csr_last),
    producer: personName(row.ex_first, row.ex_last)
  }
}

async function termDetails(rows: PolicyRow[]): Promise<AmsPolicyTerm[]> {
  if(rows.length === 0) return []
  const polids = rows.map((r) => r.polid)
  const [lobs, txs] = await Promise.all([
    runReadOnlyQuery(`
      SELECT l.polid, COALESCE(lo.descriptionlobs, l.lineofbus) AS lob
      FROM afw_lineofbusiness l LEFT JOIN afw_lobsetup lo ON l.lineofbus = lo.namelobs
      WHERE l.polid = ANY($1::uuid[]) ORDER BY l.polid, l.sortno
    `, [polids]),
    runReadOnlyQuery(`
      SELECT pt.polid, pt.effdate, COALESCE(tt.description, pt.trantype) AS type, pt.description, pt.annualizedpremium, pt.changeddate
      FROM afw_policytransaction pt
      LEFT JOIN afw_prcode tt ON rtrim(tt.attrcode) = 'TT' AND tt.code = pt.trantype
      WHERE pt.polid = ANY($1::uuid[]) ORDER BY pt.polid, pt.effdate DESC, pt.changeddate DESC
    `, [polids])
  ])

  return rows.map((r) => ({
    policy_number: r.polno,
    term: `${ ymd(r.poleffdate) } to ${ ymd(r.polexpdate) }`,
    status: r.status,
    current_term: r.renewalrptflag === "A",
    carrier: r.carrier_name,
    writing_company: r.writing_carrier_name,
    full_term_premium: money(r.fulltermpremium),
    payment_plan: r.payment_plan,
    bill_method: r.billmethod_description,
    lines_of_business: (lobs as unknown as { polid: string; lob: string }[]).filter((l) => l.polid === r.polid).map((l) => l.lob),
    transactions: (txs as Record<string, unknown>[]).filter((t) => t.polid === r.polid).slice(0, 40).map((t) => ({
      effective: ymd(t.effdate),
      type: String(t.type ?? ""),
      description: String(t.description ?? ""),
      annualized_premium: money(t.annualizedpremium),
      entered: ymd(t.changeddate)
    }))
  }))
}

// Activity notes on the customer and its policies since `since` — the change requests, endorsement
// requests and follow-ups the skill searches for. Capped so the analysis prompt stays small.
async function activityNotes(custid: string, since: string): Promise<AmsCrossCheck["activity_notes"]> {
  const rows = await runReadOnlyQuery(`
    SELECT tr.changeddate, tr.polno, e.firstname, e.lastname, tr.commenttran
    FROM afw_transaction tr
    LEFT JOIN afw_basicpolinfo bp ON bp.polid = tr.polid
    LEFT JOIN afw_employee e ON e.empcode = tr.changedby
    WHERE COALESCE(bp.custid, CASE WHEN tr.entitytype = 4 THEN tr.entityid::uuid END) = $1
      AND tr.changeddate >= $2::date AND COALESCE(tr.commenttran, '') <> ''
    ORDER BY tr.changeddate DESC
    LIMIT 150
  `, [custid, since])
  return rows.map((r) => ({
    date: ymd(r.changeddate),
    policy_number: (r.polno as string | null) ?? null,
    by: personName(r.firstname, r.lastname),
    note: String(r.commenttran).replace(/\s+/g, " ").trim().slice(0, 1200)
  }))
}

async function otherInForce(custid: string, exclude: Set<string>): Promise<AmsCrossCheck["other_in_force_policies"]> {
  const rows = await runReadOnlyQuery(`
    SELECT ${ POLICY_COLUMNS }
    FROM afw_basicpolinfo p ${ POLICY_JOINS }
    WHERE p.custid = $1 AND p.typeofbus = 2 AND p.renewalrptflag = 'A' AND p.polexpdate >= CURRENT_DATE - 30
    ORDER BY p.poleffdate DESC
  `, [custid])
  const terms = await termDetails((rows as unknown as PolicyRow[]).filter((r) => !exclude.has(r.polid)))
  return terms.map((t) => ({ policy_number: t.policy_number, term: t.term, carrier: t.carrier, lines_of_business: t.lines_of_business, full_term_premium: t.full_term_premium }))
}

// Finds the customer from the documents' policy numbers first (exact, punctuation-insensitive), then
// from the named insured. `since` is ~60 days before the baseline document's date.
export async function pullAmsCrossCheck({ policyNumbers, namedInsured, since }: { policyNumbers: string[]; namedInsured: string | null; since: string }): Promise<AmsCrossCheck> {
  const result: AmsCrossCheck = {
    pulled_at: new Date().toISOString().slice(0, 10),
    customer: null,
    matched_on: null,
    checked_policies: [],
    other_in_force_policies: [],
    activity_notes: [],
    notes: []
  }

  try {
    const byNumber = await policiesByNumber(policyNumbers)
    let custid: string | null = null
    if(byNumber.length > 0) {
      const custids = [...new Set(byNumber.map((r) => r.custid))]
      if(custids.length > 1) result.notes.push("The policy numbers match policies under more than one AMS360 customer; only the first is used.")
      custid = custids[0]
      result.matched_on = "policy_number"
    } else if(namedInsured) {
      custid = await customerByName(namedInsured)
      if(custid) result.matched_on = "named_insured"
    }

    if(!custid) {
      result.notes.push(`No AMS360 commercial customer was found for policy number(s) ${ policyNumbers.join(", ") || "none" } or named insured "${ namedInsured ?? "unknown" }".`)
      return result
    }

    // The checked policies: every term of the matched policy numbers (current and prior), newest first.
    const checked = byNumber.filter((r) => r.custid === custid).slice(0, 6)
    const [customer, checkedTerms, notes] = await Promise.all([customerSummary(custid), termDetails(checked), activityNotes(custid, since)])
    result.customer = customer
    result.checked_policies = checkedTerms
    result.activity_notes = notes
    result.other_in_force_policies = await otherInForce(custid, new Set(checked.map((r) => r.polid)))
    if(checked.length === 0) result.notes.push("The customer was matched by name; none of the documents' policy numbers are in AMS360 yet.")
  } catch(error) {
    logger.error({ err: error }, "policy_check: AMS360 cross-check failed")
    result.notes.push("The AMS360 cross-check couldn't run (data lake error).")
  }

  return result
}
