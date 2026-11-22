import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerCoverageComparisonTools } from "../tools/coverageComparison.js"
import type { ComparisonAttachment, ComparisonUser } from "./coverageComparisonStore.js"
import { runScopedChatTurn, type ScopedChatTurn } from "./scopedToolChat.js"

// The CL Coverage Comparison page's chat. Files go in the page's two drop zones (Set A, Set B);
// each turn lists what's loaded so Claude can start a comparison or answer questions about one.
const TOOL_NAMES = ["mcp__boxwood__coverage_comparison", "mcp__boxwood__coverage_comparison_results"]

const SYSTEM_PROMPT = `You are the assistant on Boxwood's "CL Coverage Comparison" page. Staff compare two sets of commercial insurance PDFs — Set A (the current program, expiring policy or first quote) and Set B (the proposed program, renewal or second quote) — and get a branded Word comparison to review with the client: At a Glance, Premium Summary, Key Points, a side-by-side table per coverage line, and a forms appendix.

Each message may start with a "[Files on the page]" block listing the uploaded files: id, filename, set, whether it has been read, and what the first read found (document type, insured, carrier, policy number). Use those ids — never invent them.

- Start a comparison with coverage_comparison only when the person asks (or presses Compare, which the page handles itself). Pass every listed file that has been read. Put anything they told you to keep in mind into notes, and column labels they give into set_a_label / set_b_label. Each set needs at least one file; if one is empty, say which.
- Before starting, mention anything that looks off from the first reads, such as files naming different insureds.
- A comparison takes a few minutes and appears in the list on the page — say so, and don't wait for it.
- For questions about a finished comparison, use coverage_comparison_results and answer from it. Never guess what a document says beyond what the results show, and don't recommend which option to buy.

You have exactly these two tools. Keep replies brief — this is a small chat panel.`

function fileBlock(attachments: ComparisonAttachment[]): string {
  if(attachments.length === 0) return ""
  const set = { set_a: "Set A", set_b: "Set B" }
  const lines = attachments.map((a) => {
    const status = a.status === "processing" ? "still being read" : a.status === "done" ? "read" : `couldn't be read: ${ a.error }`
    const p = a.profile
    const found = p ? `; looks like ${ p.document_type.replace(/_/g, " ") }${ p.named_insured ? ` for ${ p.named_insured }` : "" }${ p.carrier ? `, ${ p.carrier }` : "" }${ p.policy_number ? `, #${ p.policy_number }` : "" }` : ""
    return `- id ${ a.id }: "${ a.filename }" in ${ set[a.role] } — ${ status }${ found }`
  })
  return `[Files on the page]\n${ lines.join("\n") }\n\n`
}

export async function runCoverageComparisonChatTurn(message: string, resumeSessionId: string | undefined, user: ComparisonUser, attachments: ComparisonAttachment[]): Promise<ScopedChatTurn> {
  const server = new McpServer({ name: "boxwood-mcp-ts", version: "1.0.0" })
  registerCoverageComparisonTools(server, user)
  return runScopedChatTurn(`${ fileBlock(attachments) }${ message }`, resumeSessionId, {
    toolNames: TOOL_NAMES,
    systemPrompt: SYSTEM_PROMPT,
    logLabel: "coverage_comparison_chat",
    server
  })
}
