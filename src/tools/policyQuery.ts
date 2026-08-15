import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery } from "../db.js"
import { logger } from "../logger.js"
import { errorResult, groupByKey, textResult } from "../mcpHelpers.js"

const INCLUDE_OPTIONS = [
  "transactions",
  "lines_of_business",
  "coverage",
  "personnel",
  "submissions",
  "attributes"
] as const

type Include = typeof INCLUDE_OPTIONS[number]

const INCLUDE_QUERIES: Record<Include, string> = {
  transactions: `
    SELECT polid, effdate, trantype, description, source, billmethodpolt,
      instdaypolt, reasonpolt, premoneffdate, isposted, annualizedpremium, annualizedestrevenue,
      changeddate
    FROM afw_policytransaction
    WHERE polid = ANY($1::uuid[])
    ORDER BY polid, effdate DESC
  `,
  lines_of_business: `
    SELECT l.polid, l.lobid, l.lineofbus, lo.descriptionlobs AS lob_description,
      l.plantype, l.stateplantype, l.writingcocode, l.effdate, l.expdate, l.description
    FROM afw_lineofbusiness l
    LEFT JOIN afw_lobsetup lo ON l.lineofbus = lo.namelobs
    WHERE l.polid = ANY($1::uuid[])
    ORDER BY l.polid, l.sortno
  `,
  coverage: `
    SELECT polid, lobid, coverageid, coveragecode, descrcov, limit1, limit2, limit3,
      deduct1, deduct2, deduct3, fulltermprem, effdate, expdate, status
    FROM afw_coverage
    WHERE polid = ANY($1::uuid[])
    ORDER BY polid, sortno
  `,
  personnel: `
    SELECT p.polid, p.empcode, e.lastname AS employee_lastname, e.firstname AS employee_firstname,
      p.emptype, p.isprimary, p.method, p.percentage, p.flatamount, p.position
    FROM afw_policypersonnel p
    LEFT JOIN afw_employee e ON p.empcode = e.empcode
    WHERE p.polid = ANY($1::uuid[])
    ORDER BY p.polid, p.position
  `,
  submissions: `
    SELECT s.polid, s.submid, s.subgrid, sg.groupno, sg.groupdate
    FROM afw_submission s
    LEFT JOIN afw_submissiongroup sg ON s.subgrid = sg.subgrid
    WHERE s.polid = ANY($1::uuid[])
  `,
  attributes: `
    SELECT a.polid, t.policyattributetypename AS attribute_name,
      a.policyattributevalue AS attribute_value, t.policyattributetypedatatype AS data_type
    FROM afw_policyattribute a
    JOIN afw_policyattributetype t ON a.policyattributetypeid = t.policyattributetypeid
    WHERE a.polid = ANY($1::uuid[])
    ORDER BY t.policyattributetypename
  `
}

const CORE_QUERY = `
  SELECT
    p.polid, p.polno, p.shortpolno, p.status, p.typeofbus, p.poltype, p.polsubtype,
    p.poleffdate, p.polexpdate, p.iscontinuous, p.billmethod, p.fulltermpremium,
    p.custid, cust.lastname AS customer_lastname, cust.firstname AS customer_firstname, cust.dba AS customer_dba,
    p.cocode, co.name AS carrier_name,
    p.writingcocode, wco.name AS writing_carrier_name,
    p.execcode, exec.lastname AS exec_lastname, exec.firstname AS exec_firstname,
    p.csrcode, csr.lastname AS csr_lastname, csr.firstname AS csr_firstname,
    p.brokercode, br.lastname AS broker_lastname, br.firstname AS broker_firstname, br.shortname AS broker_shortname,
    p.anotid, an.description AS notation_description,
    p.paypid, pp.description AS payment_plan_description,
    p.priorpolid, p.sourcepolid,
    p.gldivcode, gld.name AS gldivision_name,
    p.glbrnchcode, glb.name AS glbranch_name,
    p.gldeptcode, gldep.name AS gldepartment_name,
    p.glgrpcode, glg.name AS glgroup_name,
    p.changedby, p.changeddate, p.entereddate
  FROM afw_basicpolinfo p
  LEFT JOIN afw_customer cust ON p.custid = cust.custid
  LEFT JOIN afw_company co ON p.cocode = co.cocode
  LEFT JOIN afw_company wco ON p.writingcocode = wco.cocode
  LEFT JOIN afw_employee exec ON p.execcode = exec.empcode
  LEFT JOIN afw_employee csr ON p.csrcode = csr.empcode
  LEFT JOIN afw_broker br ON p.brokercode = br.brokercode
  LEFT JOIN afw_agencynotation an ON p.anotid = an.anotid
  LEFT JOIN afw_paymentplan pp ON p.paypid = pp.paypid
  LEFT JOIN afw_generalledgerdivision gld ON p.gldivcode = gld.gldivcode
  LEFT JOIN afw_generalledgerbranch glb ON p.glbrnchcode = glb.glbrnchcode
  LEFT JOIN afw_generalledgerdepartment gldep ON p.gldeptcode = gldep.gldeptcode
  LEFT JOIN afw_generalledgergroup glg ON p.glgrpcode = glg.glgrpcode
  WHERE
`

export function registerPolicyQueryTool(server: McpServer) {
  server.registerTool(
    "policy_query",
    {
      description: "Look up policy/policies by ID, policy number, or owning customer, with resolved carrier/producer/CSR/broker/GL names. Optionally include related records (transactions, lines of business, coverage, personnel, submissions, attributes).",
      inputSchema: {
        polid: z.string().uuid().describe("Exact policy ID (afw_basicpolinfo.polid)").optional(),
        polno: z.string().describe("Partial match against policy number or short policy number").optional(),
        custid: z.string().uuid().describe("List all policies belonging to this customer").optional(),
        include: z.array(z.enum(INCLUDE_OPTIONS)).describe("Related record sets to attach to each policy").optional(),
        limit: z.number().int().min(1).max(50).default(10).describe("Max policies to return for polno/custid searches")
      }
    },
    async ({ polid, polno, custid, include, limit }) => {
      try {
        if(!polid && !polno && !custid) {
          return errorResult("Provide at least one of: polid, polno, custid")
        }

        let whereClause: string
        let params: unknown[]

        if(polid) {
          whereClause = "p.polid = $1"
          params = [polid]
        } else if(custid) {
          whereClause = "p.custid = $1"
          params = [custid]
        } else {
          whereClause = "(p.polno ILIKE $1 OR p.shortpolno ILIKE $1)"
          params = [`%${ polno }%`]
        }

        const sql = polid ?
          `${ CORE_QUERY }${ whereClause }` :
          `${ CORE_QUERY }${ whereClause } ORDER BY p.poleffdate DESC LIMIT ${ limit }`

        const policies = await runReadOnlyQuery(sql, params)

        if(policies.length === 0) {
          return textResult({ policies: [] })
        }

        const polids = policies.map((row) => row.polid)

        const includedData: Partial<Record<Include, Map<string, unknown[]>>> = {}

        for(const key of include ?? []) {
          const rows = await runReadOnlyQuery(INCLUDE_QUERIES[key], [polids])
          includedData[key] = groupByKey(rows as Record<string, unknown>[], "polid")
        }

        const results = policies.map((policy) => {
          const included: Partial<Record<Include, unknown[]>> = {}

          for(const key of include ?? []) {
            included[key] = includedData[key]?.get(String(policy.polid)) ?? []
          }

          return include?.length ? { ...policy, included } : policy
        })

        return textResult({ policies: results })
      } catch(error) {
        logger.error({ err: error, polid, polno, custid, include }, "policy_query failed")
        return errorResult(error)
      }
    }
  )
}
