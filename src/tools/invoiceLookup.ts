import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { logger } from "../logger.js"
import { errorResult, groupByKey, textResult } from "../mcpHelpers.js"

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
  WHERE
`

export function registerInvoiceLookupTool(server: McpServer) {
  server.registerTool(
    "invoice_lookup",
    {
      description: "Look up invoice(s) by ID, invoice number, owning customer, or policy, with resolved customer/policy/broker/rep/GL names. Optionally include related policy activity log entries.",
      inputSchema: {
        invid: z.string().uuid().describe("Exact invoice ID (afw_invoice.invid)").optional(),
        invno: z.number().int().describe("Exact invoice number (afw_invoice.invno)").optional(),
        custid: z.string().uuid().describe("List all invoices for this customer").optional(),
        polid: z.string().uuid().describe("List all invoices for this policy").optional(),
        include: z.array(z.enum(INCLUDE_OPTIONS)).describe("Related record sets to attach to each invoice").optional(),
        limit: z.number().int().min(1).max(50).default(10).describe("Max invoices to return for custid/polid searches")
      }
    },
    async ({ invid, invno, custid, polid, include, limit }) => {
      try {
        if(!invid && !invno && !custid && !polid) {
          return errorResult("Provide at least one of: invid, invno, custid, polid")
        }

        let whereClause: string
        let params: unknown[]

        if(invid) {
          whereClause = "i.invid = $1"
          params = [invid]
        } else if(invno) {
          whereClause = "i.invno = $1"
          params = [invno]
        } else if(custid) {
          whereClause = "i.custid = $1"
          params = [custid]
        } else {
          whereClause = "i.polid = $1"
          params = [polid]
        }

        const sql = invid || invno ?
          `${ CORE_QUERY }${ whereClause }` :
          `${ CORE_QUERY }${ whereClause } ORDER BY i.inveffdate DESC LIMIT ${ limit }`

        const invoices = await runReadOnlyQuery(sql, params)

        if(invoices.length === 0) {
          return textResult({ invoices: [] })
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

        return textResult({ invoices: results })
      } catch(error) {
        logger.error({ err: error, invid, invno, custid, polid, include }, "invoice_lookup failed")
        return errorResult(error)
      }
    }
  )
}
