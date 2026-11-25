import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerPolicyCheckTools } from "../tools/policyCheck.js"
import type { PolicyCheckAttachment, PolicyCheckUser } from "./policyCheckStore.js"
import { runScopedChatTurn, type ScopedChatTurn } from "./scopedToolChat.js"

// The Policy Check page's chat. Files go in the page's three drop zones (baseline, compared,
// reference); each turn lists what's currently loaded so Claude can start a check or answer
// questions about a finished one.
const TOOL_NAMES = ["mcp__boxwood__policy_check", "mcp__boxwood__policy_check_results"]

const SYSTEM_PROMPT = `You are the assistant on Boxwood's "Policy Check" page, used by commercial lines account managers. They drop files (PDF, Word, Excel or images) into three zones: Baseline (the quote, binder or expiring policy — what the policy should be), Compared (the issued or renewal policy — what the carrier issued) and Reference (endorsements, applications, leases, contracts). A Policy Check compares them line by line against Boxwood's checklist, cross-checks AMS360, and produces a Word report with a "Check These First" summary.

Each message may start with a "[Files on the page]" block listing the uploaded files: id, filename, zone, whether it has been read, and what the first read found (document type, insured, carrier, policy number). Use those ids — never invent them.

- Start a check with policy_check only when the person asks (or presses Run check, which the page handles itself). Pass every listed file that has been read, and put anything they told you to keep in mind into notes. A check needs a Baseline and a Compared file; if one is missing, say which.
- Before starting, mention anything that looks off from the first reads: a file whose type doesn't fit its zone (e.g. an issued policy in Baseline), or files naming different insureds.
- A check takes a few minutes and appears in the list on the page — say so, and don't wait for it.
- For questions about a finished check ("why is #3 flagged?", "what drove the premium increase?"), use policy_check_results and answer from it, citing item numbers and pages. Never guess what a document says beyond what the results show.
- If something isn't in the results, say so and suggest checking the policy or AMS360 directly.

You have exactly these two tools. Keep replies brief — this is a small chat panel.`

function fileBlock(attachments: PolicyCheckAttachment[]): string {
  if(attachments.length === 0) return ""
  const zone = { baseline: "Baseline", compared: "Compared", reference: "Reference" }
  const lines = attachments.map((a) => {
    const status = a.status === "processing" ? "still being read" : a.status === "done" ? "read" : `couldn't be read: ${ a.error }`
    const p = a.profile
    const found = p ? `; looks like ${ p.document_type.replace(/_/g, " ") }${ p.named_insured ? ` for ${ p.named_insured }` : "" }${ p.carrier ? `, ${ p.carrier }` : "" }${ p.policy_number ? `, #${ p.policy_number }` : "" }` : ""
    return `- id ${ a.id }: "${ a.filename }" in ${ zone[a.role] } — ${ status }${ found }`
  })
  return `[Files on the page]\n${ lines.join("\n") }\n\n`
}

export async function runPolicyCheckChatTurn(message: string, resumeSessionId: string | undefined, user: PolicyCheckUser, attachments: PolicyCheckAttachment[]): Promise<ScopedChatTurn> {
  const server = new McpServer({ name: "boxwood-mcp-ts", version: "1.0.0" })
  registerPolicyCheckTools(server, user)
  return runScopedChatTurn(`${ fileBlock(attachments) }${ message }`, resumeSessionId, {
    toolNames: TOOL_NAMES,
    systemPrompt: SYSTEM_PROMPT,
    logLabel: "policy_check_chat",
    server
  })
}
