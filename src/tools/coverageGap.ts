import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { errorResult, textResult } from "../utils/mcpHelpers.js"
import { logger } from "../utils/logger.js"
import type { GapAnalysis } from "../utils/coverageGapAnalysis.js"
import { GapRefused, startGapAnalysis } from "../utils/coverageGapRun.js"
import { getJob, listJobs, readFindings, type GapUser } from "../utils/coverageGapStore.js"

// Coverage Gap (Andrew, 2026-11-25): the page's chat tools. Only registered on that chat's own
// server (utils/coverageGapChat.ts), bound to the signed-in staff member — not on the general MCP
// endpoint, which has no way to upload files.

export function registerCoverageGapTools(server: McpServer, user: GapUser) {
  server.registerTool(
    "coverage_gap_analysis",
    {
      description: "Starts a Coverage Gap Analysis of the commercial policy documents the person uploaded to the page: Boxwood's 11-step review (named insureds, terms, locations, limits vs exposures, exclusions, conditions, umbrella underlying, missing lines, client questions). It runs in the background for a few minutes and the internal Word report appears in the page's list — this returns as soon as it starts.",
      inputSchema: {
        attachment_ids: z.array(z.string()).describe("Ids of the uploaded policy files, as listed in the message"),
        notes: z.string().optional().describe("Account information the person gave that the policies may not show: operations, revenue, payroll, employee count, contract requirements, what the client said. Include what's in the page's account notes box if they ask you to start it."),
        client_name: z.string().optional().describe("Only if the person gives one — otherwise it's read from the documents")
      }
    },
    async ({ attachment_ids, notes, client_name }) => {
      try {
        const entry = startGapAnalysis(user, attachment_ids, { notes, clientName: client_name })
        return textResult({ started: true, analysis_id: entry.id, message: "The gap analysis is running. It takes a few minutes; the Word report will appear in the list on this page." })
      } catch(error) {
        if(error instanceof GapRefused) return errorResult(error)
        logger.error({ err: error, attachment_ids }, "coverage_gap_analysis tool failed")
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    "coverage_gap_results",
    {
      description: "Reads one of the person's finished Coverage Gap Analyses so you can answer questions about it (why something is a gap, what to ask the client, which form a finding cites). Without analysis_id, uses their most recent one.",
      inputSchema: {
        analysis_id: z.string().optional().describe("An analysis id from an earlier coverage_gap_analysis result in this conversation")
      }
    },
    async ({ analysis_id }) => {
      try {
        const entry = analysis_id ? getJob(analysis_id) : listJobs().find((j) => j.created_by.sub === user.sub)
        if(!entry || entry.created_by.sub !== user.sub) return errorResult(new Error("No gap analysis of yours was found."))
        if(entry.status === "running") return textResult({ status: "running", message: "That gap analysis is still running." })
        if(entry.status === "failed") return textResult({ status: "failed", error: entry.error })
        const analysis = readFindings<GapAnalysis>(entry.id)
        if(!analysis) return errorResult(new Error("This gap analysis's details aren't available."))
        return textResult({ analysis_id: entry.id, account_notes: entry.notes ?? null, ...analysis })
      } catch(error) {
        logger.error({ err: error, analysis_id }, "coverage_gap_results failed")
        return errorResult(error)
      }
    }
  )
}
