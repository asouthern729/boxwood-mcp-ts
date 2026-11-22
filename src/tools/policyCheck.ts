import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { errorResult, textResult } from "../utils/mcpHelpers.js"
import { logger } from "../utils/logger.js"
import type { PolicyCheckFindings } from "../utils/policyCheckAnalysis.js"
import { CheckRefused, startCheck } from "../utils/policyCheckRun.js"
import { getCheck, listChecks, readFindings, type PolicyCheckUser } from "../utils/policyCheckStore.js"

// Policy Check (Andrew, 2026-11-22): the Policy Check page's chat tools. Only registered on that
// chat's own server (utils/policyCheckChat.ts), bound to the signed-in staff member — not on the
// general MCP endpoint, which has no way to upload files.

type StoredFindings = PolicyCheckFindings & { numbered: { number: number; ref: string }[] }

export function registerPolicyCheckTools(server: McpServer, user: PolicyCheckUser) {
  server.registerTool(
    "policy_check",
    {
      description: "Starts a Policy Check on files the person uploaded to the page's drop zones: the baseline (quote, binder or expiring policy) against the issued or renewal policy, with any reference documents (endorsements, applications, contracts), cross-checked against AMS360. Roles come from the drop zone each file is in. It runs in the background for a few minutes and the report appears in the page's list — this returns as soon as it starts.",
      inputSchema: {
        attachment_ids: z.array(z.string()).describe("Ids of the uploaded files to check, as listed in the message"),
        notes: z.string().optional().describe("Anything the person said to keep in mind for this check (e.g. \"client asked to add Location 4 on 9/29\")"),
        client_name: z.string().optional().describe("Only if the person gives one — otherwise it's read from the documents")
      }
    },
    async ({ attachment_ids, notes, client_name }) => {
      try {
        const entry = startCheck(user, attachment_ids, { notes, clientName: client_name })
        return textResult({ started: true, check_id: entry.id, message: "The check is running. It takes a few minutes; the report will appear in the list on this page." })
      } catch(error) {
        if(error instanceof CheckRefused) return errorResult(error)
        logger.error({ err: error, attachment_ids }, "policy_check tool failed")
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    "policy_check_results",
    {
      description: "Reads the findings of one of the person's Policy Checks so you can answer questions about it (why an item was flagged, what a premium driver was, what AMS360 showed). Without check_id, uses their most recent check. Returns the numbered items, every check row, premium drivers, forms changes and the AMS360 cross-reference.",
      inputSchema: {
        check_id: z.string().optional().describe("A check id from an earlier policy_check result in this conversation")
      }
    },
    async ({ check_id }) => {
      try {
        const entry = check_id ? getCheck(check_id) : listChecks().find((c) => c.created_by.sub === user.sub)
        if(!entry || entry.created_by.sub !== user.sub) return errorResult(new Error("No check of yours was found."))
        if(entry.status === "running") return textResult({ status: "running", message: "That check is still running." })
        if(entry.status === "failed") return textResult({ status: "failed", error: entry.error })

        const findings = readFindings<StoredFindings>(entry.id)
        if(!findings) return errorResult(new Error("This check's findings aren't available."))
        const numberOf = new Map(findings.numbered.map((n) => [n.ref, n.number]))
        return textResult({
          check_id: entry.id,
          client_name: entry.client_name,
          mode: entry.mode,
          banner: entry.banner?.text,
          counts: entry.counts,
          premium_change: entry.premium_change,
          documents: findings.documents_reviewed,
          not_reviewed: findings.not_reviewed,
          rows: findings.rows.map((r) => ({ number: numberOf.get(r.ref) ?? null, ...r })),
          premium_drivers: findings.premium_drivers,
          forms_changed: findings.forms.filter((f) => f.change !== "Same"),
          ams_cross_reference: findings.ams_cross_reference
        })
      } catch(error) {
        logger.error({ err: error, check_id }, "policy_check_results failed")
        return errorResult(error)
      }
    }
  )
}
