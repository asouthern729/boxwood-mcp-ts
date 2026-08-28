import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { systemEmployeeCondition } from "../utils/employeeClassification.js"
import { logger } from "../utils/logger.js"
import { errorResult, textResult } from "../utils/mcpHelpers.js"

// Book (policy/premium) and claims metrics are always computed as two separate aggregate
// queries and merged by key in JS, never joined into one query — joining afw_custlosshist
// into a SUM(fulltermpremium) query would fan out one policy row per claim on it, multiplying
// that policy's premium into the sum once per claim.

// afw_basicpolinfo can hold several rows for the same (custid, polno) that all carry
// renewalrptflag='A' simultaneously. Two distinct patterns cause this, both confirmed against
// real data: (1) a handful of quick successive in-app edits seconds apart (e.g. one policy had
// 5 snapshot rows 16 seconds apart with different fulltermpremium values), and (2) far larger
// batches — one policy had 28 rows sharing one sync batch (_seq) that actually span 3 different
// annual terms (poleffdate 2023, 2024, 2025) each with several revisions, all bulk-imported at
// once. Because of (2), `changeddate` alone is NOT a safe tiebreaker — within a bulk-imported
// batch many rows share the exact same changeddate down to the millisecond, so ordering by it
// can pick an arbitrary row from an OLD term rather than the current one. Ordering by poleffdate
// first (latest term) and only then by entereddate (latest revision within that term, which does
// vary per-row even inside a shared-changeddate batch) picks the correct one. Aggregating raw,
// non-deduped rows would double- (or 28-times-) count premium and policy_count for any policy
// revised more than once — confirmed: within the renewalrptflag='A' filter, 4,823 rows but only
// 4,517 distinct (custid, polno) pairs. This CTE also drops status='D' rows (293 in the same
// filter, overwhelmingly isnewbpol='Y' with no priorpolid — i.e. first-term entries deleted/
// voided before ever being renewed, not real in-force business) — status='D' was previously not
// excluded at all, unlike the already-established finding that status='C' is NOT a reliable
// exclusion (most genuinely in-force terms carry 'C', not 'A').
//
// Cross-checked against afw_policytranpremium (the transaction-level premium table): summing
// that table's `premium` column for each deduped policy's latest transaction (afw_policytransaction,
// max effdate) agreed with this CTE's fulltermpremium total to within 0.1% on a full-book test —
// so afw_policytranpremium is not a more-accurate alternative source, just a consistent one.
// `billedstmtprem`/`annualizedpremium` were also checked and are further from ground truth, not
// closer (they answer different questions — current statement balance / annualized rate — not
// "current full-term premium").
//
// A real driver of remaining premium inaccuracy was found instead: afw_policytransaction.source
// ('D'=carrier download via the ACORD AL3 feed, 'I'=manually entered, 'T'=bulk transfer, e.g. a
// customer's full history reassigned to a new CSR in one batch). Comparing book_summary's CSR-level
// premium against an external report, CSRs whose books were 90%+ 'D'-sourced matched closely;
// CSRs whose books were mostly 'I'/'T' were off by up to ~2x. Checked whether AMS360's download
// table group (AFW_DownLoadTran etc., AMS360 Database Design Guide §8) could independently verify
// these — ruled out: AFW_DownLoadTran's actual spec has no premium/dollar column at all (it's a
// processing/matching log — transtatus, matchedpolid, possiblecustid — not download *content*),
// and its own doc comment notes it's AMS360's legacy internal download log, distinct from the
// Data Lake API pipeline this project's ETL actually uses.
//
// A genuine independent source WAS found: afw_cprem (AMS360 Database Design Guide §4.4.3.114),
// a per-coverage-line premium history table for commercial lines of business, with clean Add/
// Change/Delete row-level status (unlike afw_basicpolinfo's ambiguous codes). Verified against
// real data after syncing it: taking each policy's latest non-deleted premium per coverage line
// (see cprem_current below) and using it in place of fulltermpremium wherever it exists closed
// 34-60% of the remaining gap for CSRs whose books have real commercial coverage detail (Connell,
// Marchiori, Graham), with only negligible (<2%) movement for CSRs that were already accurate —
// so it's used as a per-policy override, not a blanket replacement, since most policies (personal
// lines, or commercial written without going through AMS360's detailed rating workflow) have no
// afw_cprem rows at all and fulltermpremium remains the only figure available for those. Does NOT
// help CSRs whose books are 100% personal lines (afw_cprem is commercial-only by its own doc) —
// Adams/Kemp/Potter remain unresolved by this.
// Client-confirmed requirement (2026-08-27): their own "as of date" book-of-business report only
// counts a policy as current if it's actually in force today — a bound renewal with a future
// effective date should NOT count yet, even though its predecessor term is still active and
// renewalrptflag='A' alone doesn't distinguish the two. Without this, a customer whose renewal has
// already been bound but hasn't started could show up as "current" under both the still-active
// term and the future-dated renewal simultaneously. Confirmed against real data before this was
// added: 298 of ~4,300 renewalrptflag='A' rows had poleffdate in the future, and 201 had polexpdate
// already in the past (same issue, opposite direction — a lapsed term not yet flagged status='D').
// Filtering to poleffdate <= now() AND polexpdate >= now() *before* the dedup ROW_NUMBER() means a
// customer whose latest bound term is a future renewal correctly falls back to their actual
// currently-active prior term instead of showing no current policy at all.
const CURRENT_POLICIES_CTE = `
  current_policies AS (
    SELECT p.* FROM (
      SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.custid, p.polno ORDER BY p.poleffdate DESC, p.entereddate DESC) AS rn
      FROM afw_basicpolinfo p
      WHERE p.renewalrptflag = 'A' AND p.polsubtype != 'S' AND p.status != 'D'
        AND p.poleffdate <= now() AND p.polexpdate >= now()
    ) p
    WHERE p.rn = 1
  )
`

const CPREM_CURRENT_CTE = `
  cprem_current AS (
    SELECT polid, SUM(premium) AS cprem_premium
    FROM (
      SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.polid, c.lobid, c.cpremid ORDER BY c.effdate DESC) AS rn
      FROM afw_cprem c
    ) c
    WHERE c.rn = 1 AND c.status != 'D'
    GROUP BY polid
  )
`

const DIMENSIONS = {
  // producer/csr book figures are rolled up from afw_customer's header field (whose account
  // this is), not afw_basicpolinfo's per-policy field — the two diverge for real accounts (e.g.
  // one customer whose header CSR is "Baggett" had ~$70K of real current premium sitting under
  // a different CSR's policy-level csrcode instead), and AMS360's own "customers/premium by
  // agent" reporting is keyed on the account owner, not whichever CSR code happens to be on an
  // individual policy row. Claims attribution (below) intentionally stays policy-level — it
  // already went through its own dedicated "current account owner" fix (see git history) and is
  // out of scope here; book and claims rows are still merged correctly by employee code even
  // though they're now resolved via different tables.
  producer: {
    level: "customer",
    bookSelect: "c.prod1code AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', prod.firstname, prod.lastname)), ''), c.prod1code) AS label",
    bookJoin: "LEFT JOIN afw_employee prod ON c.prod1code = prod.empcode",
    bookHeaderColumn: "prod1code",
    claimsSelect: "pol.execcode AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', exec.firstname, exec.lastname)), ''), pol.execcode) AS label",
    claimsJoin: "LEFT JOIN afw_employee exec ON pol.execcode = exec.empcode",
    hasPremium: true,
    employeeCodeColumn: "execcode"
  },
  csr: {
    level: "customer",
    bookSelect: "c.csrcode AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), c.csrcode) AS label",
    bookJoin: "LEFT JOIN afw_employee csr ON c.csrcode = csr.empcode",
    bookHeaderColumn: "csrcode",
    claimsSelect: "pol.csrcode AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), pol.csrcode) AS label",
    claimsJoin: "LEFT JOIN afw_employee csr ON pol.csrcode = csr.empcode",
    hasPremium: true,
    employeeCodeColumn: "csrcode"
  },
  carrier: {
    level: "policy",
    bookSelect: "cp.cocode AS key, COALESCE(co.name, cp.cocode) AS label",
    bookJoin: "LEFT JOIN afw_company co ON cp.cocode = co.cocode",
    claimsSelect: "pol.cocode AS key, COALESCE(co.name, pol.cocode) AS label",
    claimsJoin: "LEFT JOIN afw_company co ON pol.cocode = co.cocode",
    hasPremium: true,
    employeeCodeColumn: null
  },
  // A package policy can carry multiple LOB lines (afw_lineofbusiness), but premium is only
  // stored once per policy term — summing whole-policy premium once per LOB line would
  // multi-count revenue, so LOB grouping omits premium entirely rather than guessing.
  lob: {
    level: "policy",
    bookSelect: "l.lineofbus AS key, COALESCE(lo.descriptionlobs, l.lineofbus) AS label",
    bookJoin: "JOIN afw_lineofbusiness l ON l.polid = cp.polid LEFT JOIN afw_lobsetup lo ON l.lineofbus = lo.namelobs",
    claimsSelect: "h.lineofbus AS key, COALESCE(lo.descriptionlobs, h.lineofbus) AS label",
    claimsJoin: "LEFT JOIN afw_lobsetup lo ON h.lineofbus = lo.namelobs",
    hasPremium: false,
    employeeCodeColumn: null
  }
} as const

type GroupBy = keyof typeof DIMENSIONS

export function registerBookSummaryTool(server: McpServer) {
  server.registerTool(
    "book_summary",
    {
      description: "Roll up the current active book by producer, CSR, carrier, or line of business: policy count, customer count, premium sum/average, and all-time claim count/paid total. 'Current' means each policy's latest-edited snapshot that is actually in force as of today (afw_basicpolinfo, deduplicated per policy number, renewalrptflag='A', excluding marketing/submission shells and deleted (status='D') rows, and requiring poleffdate <= today <= polexpdate) — client-confirmed as of 2026-08-27: a renewal that's already bound but whose term hasn't started yet should not count as part of the current book, and a term whose expiration has already passed doesn't count either even if not yet flagged status='D'. When grouping by producer or CSR, customers/premium are rolled up from afw_customer's header producer/CSR field (whose account this is) rather than any individual policy's own producer/CSR code, since those two can diverge for a real account — matches how customer_lookup resolves producer/CSR. Premium is not available when grouping by line of business, since a package policy's premium can't be safely split across its multiple LOB lines without double-counting revenue. Premium is sourced from afw_cprem's coverage-line detail where available (commercial policies written through AMS360's detailed rating workflow) and falls back to the policy's own fulltermpremium otherwise (personal lines, or commercial policies with no coverage-line detail) — the former is confirmed more accurate where both exist. Claims figures are all-time, not a rolling window, and are attributed to whoever currently owns the account today (not whoever was producer/CSR/carrier back when the claim happened, and not necessarily the same producer/CSR the premium figures are attributed to, since claims stay policy-level) — an account that's fully lapsed with no current term drops its claims from every group. `claims_paid_total` is a real disbursement figure sourced from afw_claimpayment (actual payments + adjustment expense; excludes reserves, voided/stopped payments, and subrogation recovery, which aren't money paid to the claimant) — a claim can have zero rows here (nothing paid out yet, e.g. still open) without that being a data gap. Optionally scope to one producer, CSR, carrier, or type of business before grouping. IMPORTANT: when grouping by producer or CSR, each row's `code` is a raw, opaque AMS360 employee code (e.g. \"!!C\") with no meaning to an end user — always report `label` (the resolved name) instead; never surface `code` in an answer, even as a fallback when `label` happens to equal it (a blank name in the source data). A customer with a header CSR/producer assigned but zero real current policies (e.g. only ever a cancelled/never-bound quote) doesn't count toward that CSR's customer_count.",
      inputSchema: {
        group_by: z.enum(Object.keys(DIMENSIONS) as [GroupBy, ...GroupBy[]]).describe("Dimension to roll the book up by"),
        producer_code: z.string().describe("Scope to one producer/exec employee code before grouping").optional(),
        csr_code: z.string().describe("Scope to one CSR employee code before grouping").optional(),
        carrier_code: z.string().describe("Scope to one carrier code before grouping").optional(),
        typeofbus: z.number().int().describe("Scope to one type-of-business code before grouping").optional()
      }
    },
    async ({ group_by, producer_code, csr_code, carrier_code, typeofbus }) => {
      try {
        const dim = DIMENSIONS[group_by]

        // Scoping conditions are identical regardless of which dimension is being grouped by:
        // producer_code/csr_code always target the customer's header fields (afw_customer),
        // carrier_code/typeofbus always target the deduplicated policy rows (current_policies) —
        // both afw_customer (as `c`) and current_policies (as `cp`) are always joined below.
        const bookConditions: string[] = []
        const bookParams: unknown[] = []

        if(producer_code) {
          bookParams.push(producer_code)
          bookConditions.push(`c.prod1code = $${ bookParams.length }`)
        }
        if(csr_code) {
          bookParams.push(csr_code)
          bookConditions.push(`c.csrcode = $${ bookParams.length }`)
        }
        if(carrier_code) {
          bookParams.push(carrier_code)
          bookConditions.push(`cp.cocode = $${ bookParams.length }`)
        }
        if(typeofbus !== undefined) {
          bookParams.push(typeofbus)
          bookConditions.push(`cp.typeofbus = $${ bookParams.length }`)
        }

        // COALESCE: use afw_cprem's coverage-line premium where it exists (more accurate for
        // commercial policies written through AMS360's detailed rating workflow), fall back to
        // afw_basicpolinfo.fulltermpremium otherwise (personal lines, or commercial policies with
        // no cprem detail) — see cprem_current's comment above for why this is an override, not
        // a replacement.
        const premiumColumns = dim.hasPremium
          ? ", SUM(COALESCE(pm.cprem_premium, cp.fulltermpremium)) AS premium_sum, AVG(COALESCE(pm.cprem_premium, cp.fulltermpremium)) AS premium_avg"
          : ""

        let bookSql: string

        if(dim.level === "customer") {
          // Excludes rows for known AMS360 system/integration accounts (e.g. the "DBO" default
          // bucket) surfacing as if they were a real producer/CSR — see systemEmployeeCondition.
          const customerConditions = [
            ...bookConditions,
            `NOT EXISTS (SELECT 1 FROM afw_employee e WHERE e.empcode = c.${ dim.bookHeaderColumn } AND ${ systemEmployeeCondition("e") })`
          ]

          bookSql = `
            WITH ${ CURRENT_POLICIES_CTE }, ${ CPREM_CURRENT_CTE }
            SELECT ${ dim.bookSelect },
              COUNT(DISTINCT cp.polid)::int AS policy_count,
              COUNT(DISTINCT c.custid) FILTER (WHERE cp.polid IS NOT NULL)::int AS customer_count
              ${ premiumColumns }
            FROM afw_customer c
            LEFT JOIN current_policies cp ON cp.custid = c.custid
            LEFT JOIN cprem_current pm ON pm.polid = cp.polid
            ${ dim.bookJoin }
            WHERE ${ customerConditions.join(" AND ") }
            GROUP BY 1, 2
          `
        } else {
          const whereClause = bookConditions.length ? `WHERE ${ bookConditions.join(" AND ") }` : ""

          bookSql = `
            WITH ${ CURRENT_POLICIES_CTE }, ${ CPREM_CURRENT_CTE }
            SELECT ${ dim.bookSelect },
              COUNT(DISTINCT cp.polid)::int AS policy_count,
              COUNT(DISTINCT cp.custid)::int AS customer_count
              ${ premiumColumns }
            FROM current_policies cp
            LEFT JOIN afw_customer c ON c.custid = cp.custid
            LEFT JOIN cprem_current pm ON pm.polid = cp.polid
            ${ dim.bookJoin }
            ${ whereClause }
            GROUP BY 1, 2
          `
        }

        const claimsConditions: string[] = []
        const claimsParams: unknown[] = []

        if(producer_code) {
          claimsParams.push(producer_code)
          claimsConditions.push(`pol.execcode = $${ claimsParams.length }`)
        }
        if(csr_code) {
          claimsParams.push(csr_code)
          claimsConditions.push(`pol.csrcode = $${ claimsParams.length }`)
        }
        if(carrier_code) {
          claimsParams.push(carrier_code)
          claimsConditions.push(`pol.cocode = $${ claimsParams.length }`)
        }
        if(typeofbus !== undefined) {
          claimsParams.push(typeofbus)
          claimsConditions.push(`pol.typeofbus = $${ claimsParams.length }`)
        }
        if(dim.employeeCodeColumn) {
          claimsConditions.push(`NOT EXISTS (SELECT 1 FROM afw_employee e WHERE e.empcode = pol.${ dim.employeeCodeColumn } AND ${ systemEmployeeCondition("e") })`)
        }

        const claimsWhereClause = claimsConditions.length ? `WHERE ${ claimsConditions.join(" AND ") }` : ""

        // afw_custlosshist.claimid is never null (confirmed against real data), so the inner
        // joins here don't drop any loss-history rows.
        //
        // A claim is tied to whichever specific policy *term* was in force when it happened,
        // but a term is superseded every renewal (a new afw_basicpolinfo row, linked back via
        // priorpolid) — so attributing a claim to that exact term's producer/CSR/carrier would
        // mean an old claim drops out of "the current book" the moment the policy renews, even
        // though the same account is still very much on the book. Instead, claims are attributed
        // to whoever currently owns the account: walk priorpolid forward (there's no direct
        // "next term" pointer, only "prior term", so this has to be a recursive search) from the
        // claim's own term to the chain's live (renewalrptflag='A', polsubtype != 'S') term, and
        // group by that term's codes instead. An account with no live term left in its chain
        // (fully lapsed, never renewed further) drops its claims entirely — same "no phantom
        // claims for accounts no longer serviced" intent as the original per-term scoping, just
        // evaluated over the whole chain instead of the exact term the claim happened on.
        //
        // A small number of chains fork at renewal (e.g. remarketed to two carriers, one bound
        // and one declined) and in ~1% of cases both branches are still independently live today
        // — DISTINCT keeps each (claim, live-term) pair to exactly one row, so those claims count
        // once per live branch rather than being arbitrarily assigned to just one.
        //
        // The chain walk itself (claim_chain) traverses raw afw_basicpolinfo — every historical
        // term, regardless of renewalrptflag/status — but the terminus check joins against
        // current_policies (deduplicated, status='D' excluded) instead of a raw renewalrptflag='A'
        // filter, for the same reasons documented on that CTE above: without dedup, a policy with
        // several simultaneously-"current" snapshot rows could resolve to more than one terminus
        // for the same chain.
        const claimsSql = `
          WITH RECURSIVE claim_chain AS (
            SELECT cl.polid AS claim_polid, cl.polid AS cur_polid
            FROM afw_claim cl
            UNION ALL
            SELECT cc.claim_polid, bp.polid
            FROM claim_chain cc
            JOIN afw_basicpolinfo bp ON bp.priorpolid = cc.cur_polid
          ),
          ${ CURRENT_POLICIES_CTE },
          claim_termini AS (
            SELECT DISTINCT cc.claim_polid, cc.cur_polid AS terminus_polid
            FROM claim_chain cc
            JOIN current_policies bp ON bp.polid = cc.cur_polid
          ),
          -- Only payment types that represent an actual disbursement count toward
          -- claims_paid_total — "Loss reserve" is an estimate, not a real payment;
          -- "Void"/"Stop payment" were cancelled; "Subrogation Recovery"/"Recovery"
          -- are money coming back in, not going out. "Adjustment expense" (paid to
          -- an adjuster, not the claimant) is included — it's still a real
          -- disbursement caused by the claim, standard "loss + LAE" accounting.
          -- Pre-aggregated per claim (not joined raw) so a claim with several
          -- payment rows doesn't fan out claim_count below.
          paid_totals AS (
            SELECT claimid, SUM(amount) AS paid_total
            FROM afw_claimpayment
            WHERE paymenttype IN ('Payment', 'Final payment', 'Claim payment', 'Adjustment expense')
            GROUP BY claimid
          )
          SELECT ${ dim.claimsSelect },
            COUNT(*)::int AS claim_count,
            SUM(pt.paid_total) AS claims_paid_total
          FROM afw_custlosshist h
          JOIN afw_claim cl ON h.claimid = cl.claimid
          JOIN claim_termini ct ON ct.claim_polid = cl.polid
          JOIN current_policies pol ON pol.polid = ct.terminus_polid
          LEFT JOIN paid_totals pt ON pt.claimid = cl.claimid
          ${ dim.claimsJoin }
          ${ claimsWhereClause }
          GROUP BY 1, 2
        `

        const bookRows = await runReadOnlyQuery(bookSql, bookParams) as {
          key: string; label: string; policy_count: number; customer_count: number
          premium_sum: string | null; premium_avg: string | null
        }[]
        const claimsRows = await runReadOnlyQuery(claimsSql, claimsParams) as {
          key: string; label: string; claim_count: number; claims_paid_total: string | null
        }[]

        const merged = new Map<string, Record<string, unknown>>()

        for(const row of bookRows) {
          merged.set(row.key, {
            code: row.key,
            label: row.label,
            policy_count: row.policy_count,
            customer_count: row.customer_count,
            ...(dim.hasPremium ? { premium_sum: row.premium_sum, premium_avg: row.premium_avg } : {}),
            claim_count: 0,
            claims_paid_total: 0
          })
        }

        for(const row of claimsRows) {
          const existing = merged.get(row.key)

          if(existing) {
            existing.claim_count = row.claim_count
            existing.claims_paid_total = row.claims_paid_total ?? 0
          } else {
            merged.set(row.key, {
              code: row.key,
              label: row.label,
              policy_count: 0,
              customer_count: 0,
              ...(dim.hasPremium ? { premium_sum: null, premium_avg: null } : {}),
              claim_count: row.claim_count,
              claims_paid_total: row.claims_paid_total ?? 0
            })
          }
        }

        const rows = [...merged.values()].sort((a, b) => (b.policy_count as number) - (a.policy_count as number))

        return textResult({ group_by, rows })
      } catch(error) {
        logger.error({ err: error, group_by, producer_code, csr_code, carrier_code, typeofbus }, "book_summary failed")
        return errorResult(error)
      }
    }
  )
}
