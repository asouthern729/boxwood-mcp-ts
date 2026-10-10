import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerCustomerLookupTool } from "../tools/customers/customerLookup.js"
import { registerProposalBuilderTool } from "../tools/proposalBuilder.js"
import type { ProposalAttachment } from "./proposalAttachments.js"
import type { ProposalCreator } from "./proposalBuilderArchive.js"
import { runScopedChatTurn, type ScopedChatTurn } from "./scopedToolChat.js"

// The Proposal Builder page's chat: files are dropped on the chat box (routes/proposalBuilder.ts
// uploads and reads them), and each turn tells Claude which attachments came with it. Its own server
// holds proposal_builder bound to the signed-in user (who owns what's built) and customer_lookup,
// for checking a client's name against AMS360.
const TOOL_NAMES = ["mcp__boxwood__customer_lookup", "mcp__boxwood__proposal_builder"]

const SYSTEM_PROMPT = `You are the assistant embedded on Boxwood's "Proposal Builder" page. Staff drop files on this chat — carrier quote PDFs and AMS360-generated proposals (.docx or PDF) — and you build a branded Commercial Insurance Proposal from them with proposal_builder.

Each message may start with an "[Attachments with this message]" block listing the files the person attached: id, filename, kind (quote_pdf, ams_docx, ams_pdf) and whether it has been read yet. Use those ids with proposal_builder — never invent ids. When files are attached and the person wants a proposal (or just says something like "build it", or attaches files without saying much), call proposal_builder with them. Once a proposal has been built in this conversation, files attached later are usually meant for that same proposal: pass its proposal_filename (from the earlier result) with the new attachment ids, unless the person says it's a different client or a new proposal. If proposal_builder says a file is still being read, tell the person and ask them to send a message again shortly. If a file couldn't be read, say which and why.

Before the first build, you need who the proposal is "Prepared By", as their first and last name. If the person hasn't told you in this conversation, ask for it (e.g. "Who should I show as preparing this proposal — first and last name?") and build once they answer. Never guess it, and never use an email address or username. Pass it as prepared_by; on later turns for the same proposal reuse the same name unless the person gives a different one. If proposal_builder rejects the name, ask again.

The document never shows premiums. An AMS360 proposal provides the current program; a quote replaces the same line from the same carrier. Every section built from a file carries a Word comment asking the account manager to verify it.

You have exactly two tools: proposal_builder and customer_lookup (only to check a client's name in AMS360 if the person asks). You can't see the files' contents beyond what proposal_builder reports. Report the download link and the sections included. Keep replies brief — this is a small chat panel.`

function attachmentBlock(attachments: ProposalAttachment[]): string {
  if(attachments.length === 0) return ""
  const lines = attachments.map((a) => `- id ${ a.id }: "${ a.filename }" (${ a.kind }) — ${ a.status === "processing" ? "still being read" : a.status === "done" ? "read" : `couldn't be read: ${ a.error }` }`)
  return `[Attachments with this message]\n${ lines.join("\n") }\n\n`
}

// The frontend remembers the last Prepared By name used in this browser and sends it with each turn
// (already checked against PERSON_NAME by the route), so Claude needn't ask every time.
function preparedByBlock(savedPreparedBy: string | undefined): string {
  return savedPreparedBy
    ? `[Saved Prepared By] The user's saved Prepared By name is ${ savedPreparedBy }. Use it for proposal_builder without asking, unless the user gives a different name in this conversation.\n\n`
    : ""
}

export async function runProposalBuilderChatTurn(
  message: string, resumeSessionId: string | undefined, user: ProposalCreator, attachments: ProposalAttachment[], savedPreparedBy?: string
): Promise<ScopedChatTurn> {
  const server = new McpServer({ name: "boxwood-mcp-ts", version: "1.0.0" })
  registerCustomerLookupTool(server)
  registerProposalBuilderTool(server, user)

  return runScopedChatTurn(`${ preparedByBlock(savedPreparedBy) }${ attachmentBlock(attachments) }${ message }`, resumeSessionId, {
    toolNames: TOOL_NAMES,
    systemPrompt: SYSTEM_PROMPT,
    logLabel: "proposal_builder_chat",
    server
  })
}
