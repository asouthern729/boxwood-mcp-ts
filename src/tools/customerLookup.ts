import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { logger } from "../logger.js"
import { errorResult, groupByKey, textResult } from "../mcpHelpers.js"

const INCLUDE_OPTIONS = [
  "contacts",
  "dependents",
  "loss_history",
  "attributes",
  "relationships",
  "xrefs",
  "expiring_business",
  "service_team"
] as const

type Include = typeof INCLUDE_OPTIONS[number]

const INCLUDE_QUERIES: Record<Include, string> = {
  contacts: `
    SELECT custid, ccntid, contactname, title, isofficer, isdirector,
      email, busareacode, busphone, resareacode, resphone, mobileareacode, mobilephone,
      contactmethod, notes
    FROM afw_custcontact
    WHERE custid = ANY($1::uuid[])
    ORDER BY contactname
  `,
  dependents: `
    SELECT custid, depdid, firstname, midname, lastname, dob, relationship,
      occupation, married, educationlevel, email
    FROM afw_dependent
    WHERE custid = ANY($1::uuid[])
    ORDER BY lastname, firstname
  `,
  loss_history: `
    SELECT custid, closshistid, claimid, company, polno, kindofloss, lineofbus,
      poleffdate, polexpdate, amountpaid, dateofloss, claimstatus, claimno, closeddate,
      lossdescclhis
    FROM afw_custlosshist
    WHERE custid = ANY($1::uuid[])
    ORDER BY dateofloss DESC
  `,
  attributes: `
    SELECT a.custid, t.customerattributetypename AS attribute_name,
      a.customerattributevalue AS attribute_value, t.customerattributetypedatatype AS data_type
    FROM afw_customerattribute a
    JOIN afw_customerattributetype t ON a.customerattributetypeid = t.customerattributetypeid
    WHERE a.custid = ANY($1::uuid[])
    ORDER BY t.customerattributetypename
  `,
  relationships: `
    SELECT cr.custid, r.relationshipdescription, cr.role,
      rt.category, rt.relationshiptypedescription, rt.primary AS primary_label, rt.secondary AS secondary_label
    FROM afw_customerrelationship cr
    JOIN afw_relationship r ON cr.relationshipid = r.relationshipid
    LEFT JOIN afw_relationshiptype rt ON r.relationshiptypeid = rt.relationshiptypeid
    WHERE cr.custid = ANY($1::uuid[])
  `,
  xrefs: `
    SELECT x.custid, x.xreference, t.description AS xref_type_description
    FROM afw_custxref x
    JOIN afw_agencyxreftype t ON x.axrefid = t.axrefid
    WHERE x.custid = ANY($1::uuid[])
  `,
  expiring_business: `
    SELECT custid, xdatid, lineofbus, policyno, expdate, coname, agent,
      premium, acctsize, interestlevel, remarks
    FROM afw_xdate
    WHERE custid = ANY($1::uuid[])
    ORDER BY expdate
  `,
  service_team: `
    SELECT p.custid, e.empcode, e.lastname AS employee_lastname, e.firstname AS employee_firstname,
      p.typeofemp, p.typeofbus, p.isprimary
    FROM afw_custaddpersonnel p
    LEFT JOIN afw_employee e ON p.empcode = e.empcode
    WHERE p.custid = ANY($1::uuid[])
  `
}

const CORE_QUERY = `
  SELECT
    c.custid, c.custno, c.lastname, c.firstname, c.dba, c.typecust, c.typeentity, c.active,
    c.addr1, c.addr2, c.city, c.state, c.zipcode, c.country,
    c.resareacode, c.resphone, c.busareacode, c.busphone, c.email,
    c.mastersubtype, c.mastercustid,
    c.prod1code, prod.lastname AS producer_lastname, prod.firstname AS producer_firstname,
    c.csrcode, csr.lastname AS csr_lastname, csr.firstname AS csr_firstname,
    c.brokercode, br.lastname AS broker_lastname, br.firstname AS broker_firstname, br.shortname AS broker_shortname,
    c.anotid, an.description AS notation_description,
    c.gldivcode, gld.name AS gldivision_name,
    c.glbrnchcode, glb.name AS glbranch_name,
    c.gldeptcode, gldep.name AS gldepartment_name,
    c.glgrpcode, glg.name AS glgroup_name,
    c.changedby, c.changeddate, c.entereddate
  FROM afw_customer c
  LEFT JOIN afw_employee prod ON c.prod1code = prod.empcode
  LEFT JOIN afw_employee csr ON c.csrcode = csr.empcode
  LEFT JOIN afw_broker br ON c.brokercode = br.brokercode
  LEFT JOIN afw_agencynotation an ON c.anotid = an.anotid
  LEFT JOIN afw_generalledgerdivision gld ON c.gldivcode = gld.gldivcode
  LEFT JOIN afw_generalledgerbranch glb ON c.glbrnchcode = glb.glbrnchcode
  LEFT JOIN afw_generalledgerdepartment gldep ON c.gldeptcode = gldep.gldeptcode
  LEFT JOIN afw_generalledgergroup glg ON c.glgrpcode = glg.glgrpcode
  WHERE
`

export function registerCustomerLookupTool(server: McpServer) {
  server.registerTool(
    "customer_lookup",
    {
      description: "Look up customer(s) by ID, customer number, or name, with resolved producer/CSR/broker/GL names. Optionally include related records (contacts, dependents, loss history, attributes, relationships, cross-references, expiring outside business, service team).",
      inputSchema: {
        custid: z.string().uuid().describe("Exact customer ID (afw_customer.custid)").optional(),
        custno: z.number().int().describe("Exact customer number (afw_customer.custno)").optional(),
        name: z.string().describe("Partial match against last name, first name, or DBA").optional(),
        include: z.array(z.enum(INCLUDE_OPTIONS)).describe("Related record sets to attach to each customer").optional(),
        limit: z.number().int().min(1).max(50).default(10).describe("Max customers to return for name searches")
      }
    },
    async ({ custid, custno, name, include, limit }) => {
      try {
        if(!custid && !custno && !name) {
          return errorResult("Provide at least one of: custid, custno, name")
        }

        let whereClause: string
        let params: unknown[]

        if(custid) {
          whereClause = "c.custid = $1"
          params = [custid]
        } else if(custno) {
          whereClause = "c.custno = $1"
          params = [custno]
        } else {
          whereClause = "(c.lastname ILIKE $1 OR c.firstname ILIKE $1 OR c.dba ILIKE $1)"
          params = [`%${ name }%`]
        }

        const sql = custid || custno ?
          `${ CORE_QUERY }${ whereClause }` :
          `${ CORE_QUERY }${ whereClause } ORDER BY c.lastname, c.firstname LIMIT ${ limit }`

        const customers = await runReadOnlyQuery(sql, params)

        if(customers.length === 0) {
          return textResult({ customers: [] })
        }

        const custids = customers.map((row) => row.custid)

        const includedData: Partial<Record<Include, Map<string, unknown[]>>> = {}

        for(const key of include ?? []) {
          const rows = await runReadOnlyQuery(INCLUDE_QUERIES[key], [custids])
          includedData[key] = groupByKey(rows as Record<string, unknown>[], "custid")
        }

        const results = customers.map((customer) => {
          const included: Partial<Record<Include, unknown[]>> = {}

          for(const key of include ?? []) {
            included[key] = includedData[key]?.get(String(customer.custid)) ?? []
          }

          return include?.length ? { ...customer, included } : customer
        })

        return textResult({ customers: results })
      } catch(error) {
        logger.error({ err: error, custid, custno, name, include }, "customer_lookup failed")
        return errorResult(error)
      }
    }
  )
}
