import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { logger } from "../utils/logger.js"
import { errorResult, groupByKey, textResult } from "../utils/mcpHelpers.js"

const INCLUDE_OPTIONS = ["activity"] as const

type Include = typeof INCLUDE_OPTIONS[number]

const INCLUDE_QUERIES: Record<Include, string> = {
  activity: `
    SELECT polid, tranid, trantype, trandate, commenttran, empcode, execcode, csrcode
    FROM afw_transaction
    WHERE polid = ANY($1::uuid[])
    ORDER BY polid, trandate DESC
  `
}

const CORE_QUERY = `
  SELECT
    i.invid, i.invno, i.invtype, i.inveffdate, i.invdate, i.duedate, i.billmethod,
    i.polrelation, i.isinstallment, i.iscancelled, i.closedstatus, i.arclosedstatus,
    i.custid, cust.lastname AS customer_lastname, cust.firstname AS customer_firstname, cust.dba AS customer_dba,
    i.polid, pol.polno,
    i.brokercode, br.lastname AS broker_lastname, br.firstname AS broker_firstname, br.shortname AS broker_shortname,
    i.execcode, exec.lastname AS exec_lastname, exec.firstname AS exec_firstname,
    i.repcode, rep.lastname AS rep_lastname, rep.firstname AS rep_firstname,
    i.originalinvidinv, orig.invno AS original_invno,
    i.voidinvidinv, void.invno AS void_invno,
    i.gldivcode, gld.name AS gldivision_name,
    i.glbrnchcode, glb.name AS glbranch_name,
    i.gldeptcode, gldep.name AS gldepartment_name,
    i.glgrpcode, glg.name AS glgroup_name,
    i.changedby, i.changeddate, i.entereddate
  FROM afw_invoice i
  LEFT JOIN afw_customer cust ON i.custid = cust.custid
  LEFT JOIN afw_basicpolinfo pol ON i.polid = pol.polid
  LEFT JOIN afw_broker br ON i.brokercode = br.brokercode
  LEFT JOIN afw_employee exec ON i.execcode = exec.empcode
  LEFT JOIN afw_employee rep ON i.repcode = rep.empcode
  LEFT JOIN afw_invoice orig ON i.originalinvidinv = orig.invid
  LEFT JOIN afw_invoice void ON i.voidinvidinv = void.invid
  LEFT JOIN afw_generalledgerdivision gld ON i.gldivcode = gld.gldivcode
  LEFT JOIN afw_generalledgerbranch glb ON i.glbrnchcode = glb.glbrnchcode
  LEFT JOIN afw_generalledgerdepartment gldep ON i.gldeptcode = gldep.gldeptcode
  LEFT JOIN afw_generalledgergroup glg ON i.glgrpcode = glg.glgrpcode
`

const SORT_OPTIONS = {
  inveffdate_desc: "i.inveffdate DESC",
  inveffdate_asc: "i.inveffdate ASC",
  invno_asc: "i.invno ASC",
  invno_desc: "i.invno DESC",
  duedate_asc: "i.duedate ASC",
  duedate_desc: "i.duedate DESC"
} as const

type Sort = keyof typeof SORT_OPTIONS

export function registerInvoiceLookupTool(server: McpServer) {
  server.registerTool(
    "invoice_lookup",
    {
      description: "Look up invoice(s) by ID or invoice number, or browse/search invoices by owning customer, policy, and coarse filters (cancelled, closed status, invoice type), with sorting and pagination. With no filters at all, returns a paginated list of all invoices. Resolves customer/policy/broker/rep/GL names inline. Optionally include related policy activity log entries.",
      inputSchema: {
        invid: z.string().uuid().describe("Exact invoice ID (afw_invoice.invid)").optional(),
        invno: z.number().int().describe("Exact invoice number (afw_invoice.invno)").optional(),
        custid: z.string().uuid().describe("Filter to invoices for this customer").optional(),
        polid: z.string().uuid().describe("Filter to invoices for this policy").optional(),
        iscancelled: z.enum(["Y", "N"]).describe("Filter by cancelled status").optional(),
        closedstatus: z.enum(["A", "X"]).describe("Exact match against afw_invoice.closedstatus. Real values are 'A' and 'X' (not 'Y'/'N' despite how that might read) — 'A' is the overwhelming majority; 'X' is rare and its precise meaning against arclosedstatus hasn't been confirmed, so don't treat this as a reliable \"outstanding balance\" proxy").optional(),
        invtype: z.number().int().describe("Exact match against invoice type code (afw_invoice.invtype)").optional(),
        sort: z.enum(Object.keys(SORT_OPTIONS) as [Sort, ...Sort[]]).default("inveffdate_desc").describe("Sort order, ignored when invid/invno is given"),
        offset: z.number().int().min(0).default(0).describe("Number of invoices to skip, ignored when invid/invno is given"),
        include: z.array(z.enum(INCLUDE_OPTIONS)).describe("Related record sets to attach to each invoice").optional(),
        limit: z.number().int().min(1).max(50).default(10).describe("Max invoices to return per page")
      }
    },
    async ({ invid, invno, custid, polid, iscancelled, closedstatus, invtype, sort, offset, include, limit }) => {
      try {
        let sql: string
        let params: unknown[]
        let hasMore = false

        if(invid || invno) {
          const whereClause = invid ? "i.invid = $1" : "i.invno = $1"
          params = [invid ?? invno]
          sql = `${ CORE_QUERY } WHERE ${ whereClause }`
        } else {
          const conditions: string[] = []
          params = []

          if(custid) {
            params.push(custid)
            conditions.push(`i.custid = $${ params.length }`)
          }
          if(polid) {
            params.push(polid)
            conditions.push(`i.polid = $${ params.length }`)
          }
          if(iscancelled) {
            params.push(iscancelled)
            conditions.push(`i.iscancelled = $${ params.length }`)
          }
          if(closedstatus) {
            params.push(closedstatus)
            conditions.push(`i.closedstatus = $${ params.length }`)
          }
          if(invtype !== undefined) {
            params.push(invtype)
            conditions.push(`i.invtype = $${ params.length }`)
          }

          const whereClause = conditions.length ? `WHERE ${ conditions.join(" AND ") }` : ""

          sql = `${ CORE_QUERY } ${ whereClause } ORDER BY ${ SORT_OPTIONS[sort] } LIMIT ${ limit + 1 } OFFSET ${ offset }`
        }

        let invoices = await runReadOnlyQuery(sql, params)

        if(!invid && !invno && invoices.length > limit) {
          hasMore = true
          invoices = invoices.slice(0, limit)
        }

        if(invoices.length === 0) {
          return textResult({ invoices: [], has_more: false })
        }

        const polids = invoices.map((row) => row.polid).filter((id) => id !== null)

        const includedData: Partial<Record<Include, Map<string, unknown[]>>> = {}

        for(const key of include ?? []) {
          const rows = polids.length > 0 ? await runReadOnlyQuery(INCLUDE_QUERIES[key], [polids]) : []
          includedData[key] = groupByKey(rows as Record<string, unknown>[], "polid")
        }

        const results = invoices.map((invoice) => {
          const included: Partial<Record<Include, unknown[]>> = {}

          for(const key of include ?? []) {
            included[key] = invoice.polid ? includedData[key]?.get(String(invoice.polid)) ?? [] : []
          }

          return include?.length ? { ...invoice, included } : invoice
        })

        return textResult({ invoices: results, has_more: hasMore })
      } catch(error) {
        logger.error({ err: error, invid, invno, custid, polid, iscancelled, closedstatus, invtype, sort, offset, include }, "invoice_lookup failed")
        return errorResult(error)
      }
    }
  )
}
