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
const DIMENSIONS = {
  producer: {
    bookSelect: "p.execcode AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', exec.firstname, exec.lastname)), ''), p.execcode) AS label",
    bookJoin: "LEFT JOIN afw_employee exec ON p.execcode = exec.empcode",
    claimsSelect: "pol.execcode AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', exec.firstname, exec.lastname)), ''), pol.execcode) AS label",
    claimsJoin: "LEFT JOIN afw_employee exec ON pol.execcode = exec.empcode",
    hasPremium: true,
    employeeCodeColumn: "execcode"
  },
  csr: {
    bookSelect: "p.csrcode AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), p.csrcode) AS label",
    bookJoin: "LEFT JOIN afw_employee csr ON p.csrcode = csr.empcode",
    claimsSelect: "pol.csrcode AS key, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), pol.csrcode) AS label",
    claimsJoin: "LEFT JOIN afw_employee csr ON pol.csrcode = csr.empcode",
    hasPremium: true,
    employeeCodeColumn: "csrcode"
  },
  carrier: {
    bookSelect: "p.cocode AS key, COALESCE(co.name, p.cocode) AS label",
    bookJoin: "LEFT JOIN afw_company co ON p.cocode = co.cocode",
    claimsSelect: "pol.cocode AS key, COALESCE(co.name, pol.cocode) AS label",
    claimsJoin: "LEFT JOIN afw_company co ON pol.cocode = co.cocode",
    hasPremium: true,
    employeeCodeColumn: null
  },
  // A package policy can carry multiple LOB lines (afw_lineofbusiness), but premium is only
  // stored once per policy term — summing whole-policy premium once per LOB line would
  // multi-count revenue, so LOB grouping omits premium entirely rather than guessing.
  lob: {
    bookSelect: "l.lineofbus AS key, COALESCE(lo.descriptionlobs, l.lineofbus) AS label",
    bookJoin: "JOIN afw_lineofbusiness l ON l.polid = p.polid LEFT JOIN afw_lobsetup lo ON l.lineofbus = lo.namelobs",
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
      description: "Roll up the current active book (afw_basicpolinfo, renewalrptflag='A', excluding marketing/submission shells) by producer, CSR, carrier, or line of business: policy count, customer count, premium sum/average, and all-time claim count/paid total. Premium is not available when grouping by line of business, since a package policy's premium can't be safely split across its multiple LOB lines without double-counting revenue. Claims figures are all-time, not a rolling window, and are attributed to whoever currently owns the account today (not whoever was producer/CSR/carrier back when the claim happened) — an account that's fully lapsed with no current term drops its claims from every group. `claims_paid_total` is a real disbursement figure sourced from afw_claimpayment (actual payments + adjustment expense; excludes reserves, voided/stopped payments, and subrogation recovery, which aren't money paid to the claimant) — a claim can have zero rows here (nothing paid out yet, e.g. still open) without that being a data gap. Optionally scope to one producer, CSR, carrier, or type of business before grouping. IMPORTANT: when grouping by producer or CSR, each row's `code` is a raw, opaque AMS360 employee code (e.g. \"!!C\") with no meaning to an end user — always report `label` (the resolved name) instead; never surface `code` in an answer, even as a fallback when `label` happens to equal it (a blank name in the source data).",
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

        const bookConditions = ["p.renewalrptflag = 'A'", "p.polsubtype != 'S'"]
        const bookParams: unknown[] = []

        if(producer_code) {
          bookParams.push(producer_code)
          bookConditions.push(`p.execcode = $${ bookParams.length }`)
        }
        if(csr_code) {
          bookParams.push(csr_code)
          bookConditions.push(`p.csrcode = $${ bookParams.length }`)
        }
        if(carrier_code) {
          bookParams.push(carrier_code)
          bookConditions.push(`p.cocode = $${ bookParams.length }`)
        }
        if(typeofbus !== undefined) {
          bookParams.push(typeofbus)
          bookConditions.push(`p.typeofbus = $${ bookParams.length }`)
        }
        // Excludes rows for known AMS360 system/integration accounts (e.g. the "DBO" default
        // bucket) surfacing as if they were a real producer/CSR — see systemEmployeeCondition.
        if(dim.employeeCodeColumn) {
          bookConditions.push(`NOT EXISTS (SELECT 1 FROM afw_employee e WHERE e.empcode = p.${ dim.employeeCodeColumn } AND ${ systemEmployeeCondition("e") })`)
        }

        const premiumColumns = dim.hasPremium ? ", SUM(p.fulltermpremium) AS premium_sum, AVG(p.fulltermpremium) AS premium_avg" : ""

        const bookSql = `
          SELECT ${ dim.bookSelect },
            COUNT(DISTINCT p.polid)::int AS policy_count,
            COUNT(DISTINCT p.custid)::int AS customer_count
            ${ premiumColumns }
          FROM afw_basicpolinfo p
          ${ dim.bookJoin }
          WHERE ${ bookConditions.join(" AND ") }
          GROUP BY 1, 2
        `

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
        const claimsSql = `
          WITH RECURSIVE claim_chain AS (
            SELECT cl.polid AS claim_polid, cl.polid AS cur_polid
            FROM afw_claim cl
            UNION ALL
            SELECT cc.claim_polid, bp.polid
            FROM claim_chain cc
            JOIN afw_basicpolinfo bp ON bp.priorpolid = cc.cur_polid
          ),
          claim_termini AS (
            SELECT DISTINCT cc.claim_polid, cc.cur_polid AS terminus_polid
            FROM claim_chain cc
            JOIN afw_basicpolinfo bp ON bp.polid = cc.cur_polid
            WHERE bp.renewalrptflag = 'A' AND bp.polsubtype != 'S'
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
          JOIN afw_basicpolinfo pol ON pol.polid = ct.terminus_polid
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
