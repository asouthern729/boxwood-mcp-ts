import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { errorResult, textResult } from "../utils/mcpHelpers.js"
import { logger } from "../utils/logger.js"
import type { Comparison } from "../utils/coverageComparisonAnalysis.js"
import { ComparisonRefused, startComparison } from "../utils/coverageComparisonRun.js"
import { getJob, listJobs, readFindings, type ComparisonUser } from "../utils/coverageComparisonStore.js"

// CL Coverage Comparison (Andrew, 2026-11-22): the page's chat tools. Only registered on that
// chat's own server (utils/coverageComparisonChat.ts), bound to the signed-in staff member — not
// on the general MCP endpoint, which has no way to upload files.

export function registerCoverageComparisonTools(server: McpServer, user: ComparisonUser) {
  server.registerTool(
    "coverage_comparison",
    {
      description: "Starts a CL Coverage Comparison of the files the person uploaded to the page's two drop zones: Set A (current program, expiring policy or first quote) against Set B (proposed program, renewal or second quote). Sets come from the drop zone each file is in. It runs in the background for a few minutes and the client-facing Word comparison appears in the page's list — this returns as soon as it starts.",
      inputSchema: {
        attachment_ids: z.array(z.string()).describe("Ids of the uploaded files to compare, as listed in the message"),
        notes: z.string().optional().describe("Anything the person said to keep in mind (e.g. \"focus on the umbrella\", \"effective 1/1/2027\")"),
        client_name: z.string().optional().describe("Only if the person gives one — otherwise it's read from the documents"),
        set_a_label: z.string().optional().describe("Column header for Set A, only if the person gives one (e.g. \"Current — Erie\")"),
        set_b_label: z.string().optional().describe("Column header for Set B, only if the person gives one (e.g. \"Proposed — Travelers\")")
      }
    },
    async ({ attachment_ids, notes, client_name, set_a_label, set_b_label }) => {
      try {
        const entry = startComparison(user, attachment_ids, { notes, clientName: client_name, setALabel: set_a_label, setBLabel: set_b_label })
        return textResult({ started: true, comparison_id: entry.id, message: "The comparison is running. It takes a few minutes; the Word document will appear in the list on this page." })
      } catch(error) {
        if(error instanceof ComparisonRefused) return errorResult(error)
        logger.error({ err: error, attachment_ids }, "coverage_comparison tool failed")
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    "coverage_comparison_results",
    {
      description: "Reads one of the person's finished CL Coverage Comparisons so you can answer questions about it (what differs on a line, why something is a gap, the premium difference). Without comparison_id, uses their most recent one.",
      inputSchema: {
        comparison_id: z.string().optional().describe("A comparison id from an earlier coverage_comparison result in this conversation")
      }
    },
    async ({ comparison_id }) => {
      try {
        const entry = comparison_id ? getJob(comparison_id) : listJobs().find((c) => c.created_by.sub === user.sub)
        if(!entry || entry.created_by.sub !== user.sub) return errorResult(new Error("No comparison of yours was found."))
        if(entry.status === "running") return textResult({ status: "running", message: "That comparison is still running." })
        if(entry.status === "failed") return textResult({ status: "failed", error: entry.error })
        const comparison = readFindings<Comparison>(entry.id)
        if(!comparison) return errorResult(new Error("This comparison's details aren't available."))
        return textResult({ comparison_id: entry.id, premium_totals: entry.premium, ...comparison })
      } catch(error) {
        logger.error({ err: error, comparison_id }, "coverage_comparison_results failed")
        return errorResult(error)
      }
    }
  )
}
