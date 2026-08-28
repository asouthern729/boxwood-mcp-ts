import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { logger } from "../utils/logger.js"
import { errorResult, textResult } from "../utils/mcpHelpers.js"

const INCLUDE_OPTIONS = ["customers", "policies", "claims", "invoices"] as const

type Include = typeof INCLUDE_OPTIONS[number]

// customers/policies are handled separately below (mergeCustomerRoles/mergePolicyRoles) since
// each needs two sources merged — the header field (prod1code/csrcode, execcode/csrcode) plus
// afw_custaddpersonnel/afw_policypersonnel, which record *additional* producer/CSR assignments
// a customer/policy's single header fields miss entirely. claims/invoices have no equivalent
// secondary-assignment table, so they stay single-source via attachRoles.
const SINGLE_SOURCE_INCLUDE_QUERIES: Record<"claims" | "invoices", string> = {
  claims: `
    SELECT cl.claimid, cl.claimno, cl.claimstatus, cl.causeofloss, cl.lossdate,
      pol.execcode, pol.csrcode,
      cl.polid, pol.polno, pol.custid, cust.lastname AS customer_lastname, cust.firstname AS customer_firstname, cust.dba AS customer_dba
    FROM afw_claim cl
    JOIN afw_basicpolinfo pol ON cl.polid = pol.polid
    LEFT JOIN afw_customer cust ON pol.custid = cust.custid
    WHERE pol.execcode = ANY($1::varchar[]) OR pol.csrcode = ANY($1::varchar[])
    ORDER BY cl.lossdate DESC
  `,
  invoices: `
    SELECT i.invid, i.invno, i.inveffdate, i.iscancelled, i.closedstatus,
      i.execcode, i.repcode,
      i.custid, cust.lastname AS customer_lastname, cust.firstname AS customer_firstname, cust.dba AS customer_dba,
      i.polid, pol.polno
    FROM afw_invoice i
    LEFT JOIN afw_customer cust ON i.custid = cust.custid
    LEFT JOIN afw_basicpolinfo pol ON i.polid = pol.polid
    WHERE i.execcode = ANY($1::varchar[]) OR i.repcode = ANY($1::varchar[])
    ORDER BY i.inveffdate DESC
  `
}

// Which two columns on each single-source include's rows carry the employee code, and what to
// call each role in the output. A row where both columns match the same anchor gets both
// labels (e.g. "producer,csr") rather than showing up twice.
const SINGLE_SOURCE_ROLE_COLUMNS: Record<"claims" | "invoices", { primary: string; secondary: string; primaryLabel: string; secondaryLabel: string }> = {
  claims: { primary: "execcode", secondary: "csrcode", primaryLabel: "producer", secondaryLabel: "csr" },
  invoices: { primary: "execcode", secondary: "repcode", primaryLabel: "exec", secondaryLabel: "rep" }
}

// Include queries fetch every row matching ANY requested anchor unbounded (no fan-out risk —
// each row has exactly one primary/secondary code), then this attaches each row to whichever
// anchor(s) it matches with a role tag, capping per anchor after the fact. Simpler and just as
// correct as a per-group SQL window function for the realistic anchor counts here (almost
// always one employee, rarely more than a page).
function attachRoles(
  rows: Record<string, unknown>[],
  empcodes: string[],
  cols: { primary: string; secondary: string; primaryLabel: string; secondaryLabel: string },
  limit: number
) {
  const map = new Map<string, Record<string, unknown>[]>()

  for(const code of empcodes) {
    const matches: Record<string, unknown>[] = []

    for(const row of rows) {
      const isPrimary = row[cols.primary] === code
      const isSecondary = row[cols.secondary] === code

      if(!isPrimary && !isSecondary) continue

      const role = isPrimary && isSecondary ? `${ cols.primaryLabel },${ cols.secondaryLabel }` : isPrimary ? cols.primaryLabel : cols.secondaryLabel

      matches.push({ ...row, role })

      if(matches.length >= limit) break
    }

    if(matches.length) map.set(code, matches)
  }

  return map
}

// "Current" (in force today, not just the latest bound term) — client-confirmed 2026-08-27, same
// definition as book_summary/policy_query: renewalrptflag='A', not a submission shell, not
// status='D', and poleffdate <= today <= polexpdate. Applied here too (both to the "policies"
// include and, via EXISTS, to which customers even qualify for the "customers" include) so an
// employee's book means the same thing regardless of which tool a caller reaches for — a customer
// whose only policies are lapsed or a future-dated renewal that hasn't started yet doesn't count
// as "belonging to" this employee's current book, matching book_summary's customer_count exactly.
const CURRENT_POLICY_EXISTS = `
  EXISTS (
    SELECT 1 FROM afw_basicpolinfo cp
    WHERE cp.custid = c.custid AND cp.renewalrptflag = 'A' AND cp.polsubtype != 'S' AND cp.status != 'D'
      AND cp.poleffdate <= now() AND cp.polexpdate >= now()
  )
`

const CURRENT_POLICY_CONDITIONS = `
  p.renewalrptflag = 'A' AND p.polsubtype != 'S' AND p.status != 'D'
  AND p.poleffdate <= now() AND p.polexpdate >= now()
`

const CUSTOMER_HEADER_QUERY = `
  SELECT custid, custno, lastname, firstname, dba, active, prod1code, csrcode, entereddate
  FROM afw_customer c
  WHERE (prod1code = ANY($1::varchar[]) OR csrcode = ANY($1::varchar[])) AND ${ CURRENT_POLICY_EXISTS }
`

const CUSTOMER_PERSONNEL_QUERY = `
  SELECT cap.empcode AS matched_empcode, cap.typeofemp,
    c.custid, c.custno, c.lastname, c.firstname, c.dba, c.active, c.entereddate
  FROM afw_custaddpersonnel cap
  JOIN afw_customer c ON cap.custid = c.custid
  WHERE cap.empcode = ANY($1::varchar[]) AND ${ CURRENT_POLICY_EXISTS }
`

const POLICY_HEADER_QUERY = `
  SELECT p.polid, p.polno, p.status, p.poleffdate, p.polexpdate, p.fulltermpremium,
    p.execcode, p.csrcode,
    p.custid, cust.lastname AS customer_lastname, cust.firstname AS customer_firstname, cust.dba AS customer_dba
  FROM afw_basicpolinfo p
  LEFT JOIN afw_customer cust ON p.custid = cust.custid
  WHERE (p.execcode = ANY($1::varchar[]) OR p.csrcode = ANY($1::varchar[])) AND ${ CURRENT_POLICY_CONDITIONS }
`

const POLICY_PERSONNEL_QUERY = `
  SELECT pp.empcode AS matched_empcode, pp.emptype, pp.percentage, pp.flatamount,
    p.polid, p.polno, p.status, p.poleffdate, p.polexpdate, p.fulltermpremium,
    p.custid, cust.lastname AS customer_lastname, cust.firstname AS customer_firstname, cust.dba AS customer_dba
  FROM afw_policypersonnel pp
  JOIN afw_basicpolinfo p ON pp.polid = p.polid
  LEFT JOIN afw_customer cust ON p.custid = cust.custid
  WHERE pp.empcode = ANY($1::varchar[]) AND ${ CURRENT_POLICY_CONDITIONS }
`

// Merges the header-field match (prod1code/csrcode) with afw_custaddpersonnel's *additional*
// producer/CSR assignments, which the header fields alone miss entirely (e.g. a separate
// commercial-lines producer recorded only in afw_custaddpersonnel). A record found via both
// sources for the same anchor collapses into one row with both roles, not two rows.
function mergeCustomerRoles(
  headerRows: Record<string, unknown>[],
  personnelRows: Record<string, unknown>[],
  empcodes: string[],
  limit: number
) {
  const empcodeSet = new Set(empcodes)
  const byAnchor = new Map<string, Map<string, Record<string, unknown> & { roles: Set<string> }>>()

  function recordFor(anchor: string, custid: string, base: Record<string, unknown>) {
    let byRecord = byAnchor.get(anchor)
    if(!byRecord) {
      byRecord = new Map()
      byAnchor.set(anchor, byRecord)
    }
    let row = byRecord.get(custid)
    if(!row) {
      row = { ...base, roles: new Set<string>() }
      byRecord.set(custid, row)
    }
    return row
  }

  for(const row of headerRows) {
    for(const anchor of empcodes) {
      const isProducer = row.prod1code === anchor
      const isCsr = row.csrcode === anchor
      if(!isProducer && !isCsr) continue

      const record = recordFor(anchor, String(row.custid), row)
      if(isProducer) record.roles.add("producer")
      if(isCsr) record.roles.add("csr")
    }
  }

  for(const row of personnelRows) {
    const anchor = String(row.matched_empcode)
    if(!empcodeSet.has(anchor)) continue

    const record = recordFor(anchor, String(row.custid), {
      custid: row.custid, custno: row.custno, lastname: row.lastname, firstname: row.firstname,
      dba: row.dba, active: row.active, entereddate: row.entereddate
    })
    record.roles.add(row.typeofemp === "P" ? "producer" : "csr")
  }

  return finalizeRoleMap(byAnchor, limit, "entereddate")
}

// Same merge as mergeCustomerRoles, at the policy level — header (execcode/csrcode) plus
// afw_policypersonnel's additional assignments, which also carry commission-split detail
// (percentage/flatamount) the header fields don't have at all.
function mergePolicyRoles(
  headerRows: Record<string, unknown>[],
  personnelRows: Record<string, unknown>[],
  empcodes: string[],
  limit: number
) {
  const empcodeSet = new Set(empcodes)
  const byAnchor = new Map<string, Map<string, Record<string, unknown> & { roles: Set<string> }>>()

  function recordFor(anchor: string, polid: string, base: Record<string, unknown>) {
    let byRecord = byAnchor.get(anchor)
    if(!byRecord) {
      byRecord = new Map()
      byAnchor.set(anchor, byRecord)
    }
    let row = byRecord.get(polid)
    if(!row) {
      row = { commission_percentage: null, commission_flat_amount: null, ...base, roles: new Set<string>() }
      byRecord.set(polid, row)
    }
    return row
  }

  for(const row of headerRows) {
    for(const anchor of empcodes) {
      const isProducer = row.execcode === anchor
      const isCsr = row.csrcode === anchor
      if(!isProducer && !isCsr) continue

      const record = recordFor(anchor, String(row.polid), row)
      if(isProducer) record.roles.add("producer")
      if(isCsr) record.roles.add("csr")
    }
  }

  for(const row of personnelRows) {
    const anchor = String(row.matched_empcode)
    if(!empcodeSet.has(anchor)) continue

    const record = recordFor(anchor, String(row.polid), {
      polid: row.polid, polno: row.polno, status: row.status, poleffdate: row.poleffdate,
      polexpdate: row.polexpdate, fulltermpremium: row.fulltermpremium, custid: row.custid,
      customer_lastname: row.customer_lastname, customer_firstname: row.customer_firstname, customer_dba: row.customer_dba
    })
    record.roles.add(row.emptype === "P" ? "producer" : "csr")
    record.commission_percentage = row.percentage ?? record.commission_percentage
    record.commission_flat_amount = row.flatamount ?? record.commission_flat_amount
  }

  return finalizeRoleMap(byAnchor, limit, "poleffdate")
}

// Shared finish for mergeCustomerRoles/mergePolicyRoles: collapse each record's role Set into
// the same "producer"/"csr"/"producer,csr" string attachRoles produces, sort most-recent-first
// (merging two independently-sorted sources doesn't preserve order, so this re-sorts explicitly),
// and cap at `limit` per anchor.
function finalizeRoleMap(
  byAnchor: Map<string, Map<string, Record<string, unknown> & { roles: Set<string> }>>,
  limit: number,
  dateField: string
) {
  const result = new Map<string, Record<string, unknown>[]>()

  for(const [anchor, byRecord] of byAnchor) {
    const rows = [...byRecord.values()]
      .map(({ roles, ...rest }): Record<string, unknown> => ({ ...rest, role: [...roles].join(",") }))
      .sort((a, b) => new Date(b[dateField] as string).getTime() - new Date(a[dateField] as string).getTime())
      .slice(0, limit)

    result.set(anchor, rows)
  }

  return result
}

const CORE_QUERY = `
  SELECT
    e.empcode, e.lastname, e.firstname, e.middlename, e.shortname, e.title, e.status,
    e.isprod, e.isrep, e.istelemarketer, e.isother, e.islicensed, e.fullparttimeind,
    e.email, e.busareacode, e.busphone, e.mobileareacode, e.mobilephone, e.yearemployed,
    e.empsupervisorcode, sup.lastname AS supervisor_lastname, sup.firstname AS supervisor_firstname,
    e.changedby, e.changeddate, e.entereddate
  FROM afw_employee e
  LEFT JOIN afw_employee sup ON e.empsupervisorcode = sup.empcode
`

const SORT_OPTIONS = {
  lastname_asc: "e.lastname ASC, e.firstname ASC",
  lastname_desc: "e.lastname DESC, e.firstname DESC",
  entereddate_asc: "e.entereddate ASC",
  entereddate_desc: "e.entereddate DESC"
} as const

type Sort = keyof typeof SORT_OPTIONS

export function registerEmployeeLookupTool(server: McpServer) {
  server.registerTool(
    "employee_lookup",
    {
      description: "Look up employee(s) by code, or browse/search by name and coarse filters (status, is-producer, is-CSR), with sorting and pagination. With no filters at all, returns a paginated list of all employees. Resolves supervisor name inline. Optionally include the customers, policies, claims, and invoices this employee is tied to (e.g. \"show me Patrick's customers\" or \"Patrick's claims history\") — customers/policies reflect every producer/CSR assignment (the customer/policy header field plus afw_custaddpersonnel/afw_policypersonnel's additional assignments), not just the single header field, and policies include commission split (percentage/flat amount) when sourced from afw_policypersonnel. The `customers`/`policies` includes only reflect the current book — client-confirmed 2026-08-27, matching book_summary/policy_query exactly: a policy must be in force today (not a submission shell, not status='D', and not a bound renewal whose effective date is still in the future or whose term has already expired) to count, and a customer with no current policy at all doesn't show up under this employee even if their header producer/CSR field still points here. `claims`/`invoices` are historical and unaffected by this — they reflect whatever policy term was in force when that claim/invoice happened, not the current one. Each include is capped at include_limit (default 20, max 100) rows, most-recent-first. For the complete, paginated list beyond that cap, use customer_lookup/policy_query/claim_lookup/invoice_lookup directly with producer_code/csr_code. IMPORTANT: `empcode` (and any execcode/csrcode/repcode/prod1code on the customers/policies/claims/invoices includes) is a raw, opaque AMS360 identifier (e.g. \"!!C\") with no meaning to an end user. It's only useful for querying — e.g. as the producer_code/csr_code filter on other tools. Never quote it in an answer; always refer to the employee by their resolved lastname/firstname instead, even when this is the tool you used to look that code up in the first place.",
      inputSchema: {
        empcode: z.string().describe("Exact employee code (afw_employee.empcode)").optional(),
        name: z.string().describe("Partial match against last name, first name, or short name").optional(),
        status: z.string().length(1).describe("Exact match against raw AMS360 status code (afw_employee.status)").optional(),
        is_producer: z.boolean().describe("Filter to employees flagged as a producer (isprod = 'Y')").optional(),
        is_csr: z.boolean().describe("Filter to employees flagged as a CSR/rep (isrep = 'Y')").optional(),
        sort: z.enum(Object.keys(SORT_OPTIONS) as [Sort, ...Sort[]]).default("lastname_asc").describe("Sort order, ignored when empcode is given"),
        offset: z.number().int().min(0).default(0).describe("Number of employees to skip, ignored when empcode is given"),
        include: z.array(z.enum(INCLUDE_OPTIONS)).describe("Related record sets to attach to each employee").optional(),
        include_limit: z.number().int().min(1).max(100).default(20).describe("Max rows per include, most-recent-first"),
        limit: z.number().int().min(1).max(50).default(10).describe("Max employees to return per page")
      }
    },
    async ({ empcode, name, status, is_producer, is_csr, sort, offset, include, include_limit, limit }) => {
      try {
        let sql: string
        let params: unknown[]
        let hasMore = false

        if(empcode) {
          params = [empcode]
          sql = `${ CORE_QUERY } WHERE e.empcode = $1`
        } else {
          const conditions: string[] = []
          params = []

          if(name) {
            params.push(`%${ name }%`)
            conditions.push(`(e.lastname ILIKE $${ params.length } OR e.firstname ILIKE $${ params.length } OR e.shortname ILIKE $${ params.length })`)
          }
          if(status) {
            params.push(status)
            conditions.push(`e.status = $${ params.length }`)
          }
          if(is_producer !== undefined) {
            params.push(is_producer ? "Y" : "N")
            conditions.push(`e.isprod = $${ params.length }`)
          }
          if(is_csr !== undefined) {
            params.push(is_csr ? "Y" : "N")
            conditions.push(`e.isrep = $${ params.length }`)
          }

          const whereClause = conditions.length ? `WHERE ${ conditions.join(" AND ") }` : ""

          sql = `${ CORE_QUERY } ${ whereClause } ORDER BY ${ SORT_OPTIONS[sort] } LIMIT ${ limit + 1 } OFFSET ${ offset }`
        }

        let employees = await runReadOnlyQuery(sql, params)

        if(!empcode && employees.length > limit) {
          hasMore = true
          employees = employees.slice(0, limit)
        }

        if(employees.length === 0) {
          return textResult({ employees: [], has_more: false })
        }

        const empcodes = employees.map((row) => String(row.empcode))

        const includedData: Partial<Record<Include, Map<string, unknown[]>>> = {}

        for(const key of include ?? []) {
          if(key === "customers") {
            const headerRows = await runReadOnlyQuery(CUSTOMER_HEADER_QUERY, [empcodes]) as Record<string, unknown>[]
            const personnelRows = await runReadOnlyQuery(CUSTOMER_PERSONNEL_QUERY, [empcodes]) as Record<string, unknown>[]
            includedData.customers = mergeCustomerRoles(headerRows, personnelRows, empcodes, include_limit)
          } else if(key === "policies") {
            const headerRows = await runReadOnlyQuery(POLICY_HEADER_QUERY, [empcodes]) as Record<string, unknown>[]
            const personnelRows = await runReadOnlyQuery(POLICY_PERSONNEL_QUERY, [empcodes]) as Record<string, unknown>[]
            includedData.policies = mergePolicyRoles(headerRows, personnelRows, empcodes, include_limit)
          } else {
            const rows = await runReadOnlyQuery(SINGLE_SOURCE_INCLUDE_QUERIES[key], [empcodes]) as Record<string, unknown>[]
            includedData[key] = attachRoles(rows, empcodes, SINGLE_SOURCE_ROLE_COLUMNS[key], include_limit)
          }
        }

        const results = employees.map((employee) => {
          const included: Partial<Record<Include, unknown[]>> = {}

          for(const key of include ?? []) {
            included[key] = includedData[key]?.get(String(employee.empcode)) ?? []
          }

          return include?.length ? { ...employee, included } : employee
        })

        return textResult({ employees: results, has_more: hasMore })
      } catch(error) {
        logger.error({ err: error, empcode, name, status, is_producer, is_csr, sort, offset, include, include_limit, limit }, "employee_lookup failed")
        return errorResult(error)
      }
    }
  )
}
