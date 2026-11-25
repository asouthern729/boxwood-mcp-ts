import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerCoverageGapTools } from "../tools/coverageGap.js"
import type { GapAttachment, GapUser } from "./coverageGapStore.js"
import { runScopedChatTurn, type ScopedChatTurn } from "./scopedToolChat.js"

// The Coverage Gap page's chat. Files go in the page's one drop zone; each turn lists what's loaded
// (and the account notes box, if filled) so Claude can start an analysis or answer questions.
const TOOL_NAMES = ["mcp__boxwood__coverage_gap_analysis", "mcp__boxwood__coverage_gap_results"]

const SYSTEM_PROMPT = `You are the assistant on Boxwood's "Coverage Gap" page. Staff upload a commercial account's policy PDFs (declarations, forms schedules, endorsements) and get an internal Word report from Boxwood's 11-step coverage gap review: a scorecard, priority findings (GAP / CONFIRM, High / Medium / Low), supporting exhibits, client validation questions and recommendations. The page also has an account notes box for things the policies don't show (operations, revenue, payroll, employee count, contract requirements, what the client said).

Each message may start with a "[Files on the page]" block listing the uploaded files (id, filename, whether it has been read, and what the first read found) and an "[Account notes]" block. Use those ids — never invent them.

- Start an analysis with coverage_gap_analysis only when the person asks (or presses Run, which the page handles itself). Pass every listed file that has been read, and pass the account notes plus anything else they told you in this chat as notes.
- Before starting, mention anything that looks off from the first reads, such as files naming different insureds, or only one policy for an account that clearly has more. If there are no account notes, you may suggest adding revenue, payroll or operations, since the review turns missing exposures into client questions — but don't insist.
- An analysis takes a few minutes and appears in the list on the page — say so, and don't wait for it.
- For questions about a finished analysis, use coverage_gap_results and answer from it. Never guess what a policy says beyond what the results show. This is an internal working review, not a coverage opinion.

You have exactly these two tools. Keep replies brief — this is a small chat panel.`

function contextBlock(attachments: GapAttachment[], accountNotes: string | undefined): string {
  const parts: string[] = []
  if(attachments.length > 0) {
    const lines = attachments.map((a) => {
      const status = a.status === "processing" ? "still being read" : a.status === "done" ? "read" : `couldn't be read: ${ a.error }`
      const p = a.profile
      const found = p ? `; looks like ${ p.document_type.replace(/_/g, " ") }${ p.named_insured ? ` for ${ p.named_insured }` : "" }${ p.carrier ? `, ${ p.carrier }` : "" }${ p.policy_number ? `, #${ p.policy_number }` : "" }` : ""
      return `- id ${ a.id }: "${ a.filename }" — ${ status }${ found }`
    })
    parts.push(`[Files on the page]\n${ lines.join("\n") }`)
  }
  if(accountNotes?.trim()) parts.push(`[Account notes]\n${ accountNotes.trim() }`)
  return parts.length > 0 ? `${ parts.join("\n\n") }\n\n` : ""
}

export async function runCoverageGapChatTurn(message: string, resumeSessionId: string | undefined, user: GapUser, attachments: GapAttachment[], accountNotes?: string): Promise<ScopedChatTurn> {
  const server = new McpServer({ name: "boxwood-mcp-ts", version: "1.0.0" })
  registerCoverageGapTools(server, user)
  return runScopedChatTurn(`${ contextBlock(attachments, accountNotes) }${ message }`, resumeSessionId, {
    toolNames: TOOL_NAMES,
    systemPrompt: SYSTEM_PROMPT,
    logLabel: "coverage_gap_chat",
    server
  })
}
