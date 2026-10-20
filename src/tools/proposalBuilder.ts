import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../config/config.js"
import { storeDownload } from "../utils/downloadStore.js"
import { errorResult, textResult } from "../utils/mcpHelpers.js"
import { logger } from "../utils/logger.js"
import { getAttachment, getOwnedAttachment, markAttachmentsUsed, type ProposalAttachment } from "../utils/proposalAttachments.js"
import { archiveProposal, readProposalManifest, type ProposalCreator } from "../utils/proposalBuilderArchive.js"
import { buildProposal } from "../utils/proposalBuilderGenerate.js"

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// Reading a file takes a minute or two. The chat request sits behind nginx's 300s read timeout, so
// the tool waits well inside that and otherwise says what's still being read.
const WAIT_MS = 200_000
const POLL_MS = 3_000

// "Firstname Lastname": at least two words, letters (plus . ' -), no email or username.
export const PERSON_NAME = /^(?!.*@)[\p{L}][\p{L}.'’-]*(?: [\p{L}][\p{L}.'’-]*)+$/u

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForReads(ids: string[]): Promise<ProposalAttachment[]> {
  const deadline = Date.now() + WAIT_MS
  for(;;) {
    const records = ids.map((id) => getAttachment(id)).filter((r): r is ProposalAttachment => r !== null)
    if(records.every((r) => r.status !== "processing") || Date.now() >= deadline) return records
    await sleep(POLL_MS)
  }
}

// Proposal Builder (Andrew, 2026-10-10): builds a branded proposal in the CL Renewal Summary's layout
// purely from files dropped on its chat — carrier quote PDFs and AMS360-generated proposals. Only
// registered on the Proposal Builder chat's own server (utils/proposalBuilderChat.ts), bound to the
// signed-in staff member, who owns what it builds; it isn't on the general MCP endpoint, which has no
// way to upload files.
export function registerProposalBuilderTool(server: McpServer, user: ProposalCreator) {
  server.registerTool(
    "proposal_builder",
    {
      description: "Builds (or updates) a branded Commercial Insurance Proposal .docx from files the person attached in this chat — carrier quote PDFs and/or AMS360-generated proposals (.docx or PDF). An AMS360 proposal supplies the current program (coverage sections, schedules, named insureds, locations, service team); each quote replaces the same line from the same carrier or adds a new section. A Premium Summary lists each quoted line's annual premium (or the current premium for AMS360-only lines). Waits for files still being read (up to a few minutes). To add files to a proposal already built in this conversation, pass its filename as proposal_filename together with the new attachment_ids — the proposal is rebuilt in place with every file it was built from plus the new ones. To change an existing proposal without new files (e.g. leave a section out), pass proposal_filename with an empty attachment_ids. Returns a download link; the proposal also appears on the Proposal Builder page.",
      inputSchema: {
        attachment_ids: z.array(z.string()).describe("Ids of the attachments to build from, as listed in the message — may be empty only when proposal_filename is given"),
        proposal_filename: z.string().optional().describe("An existing proposal's filename (from an earlier proposal_builder result in this conversation) to add these files to"),
        client_name: z.string().optional().describe("The client's name as it should print, only if the person gives one — otherwise it's read from the files"),
        prepared_by: z.string().describe("Who the proposal is prepared by, as \"Firstname Lastname\" — exactly as the person told you in this chat. Ask for it if they haven't said; never guess it or use an email or username"),
        omit_sections: z.array(z.string()).optional().describe("Coverage section titles to leave out, as proposal_builder reported them (e.g. \"Cyber Liability\"), only when the person asks. On a rebuild, omit it to keep the proposal's earlier choice; pass [] to put every section back")
      }
    },
    async ({ attachment_ids, proposal_filename, client_name, prepared_by, omit_sections }) => {
      const refuse = (reason: string) => {
        logger.warn({ sub: user.sub, attachment_ids, proposal_filename, reason }, "proposal_builder refused")
        return errorResult(new Error(reason))
      }

      try {
        logger.info({ sub: user.sub, attachment_ids, proposal_filename }, "proposal_builder called")
        const preparedBy = prepared_by.trim().replace(/\s+/g, " ")
        if(!PERSON_NAME.test(preparedBy)) {
          return refuse(`"${ prepared_by }" isn't a first and last name. Ask the person who the proposal is prepared by (first and last name), then try again.`)
        }
        if(attachment_ids.length === 0 && !proposal_filename) return refuse("Pass the attachment ids to build from, or proposal_filename to rebuild an existing proposal.")
        const unknown = attachment_ids.filter((id) => !getOwnedAttachment(id, user.sub))
        if(unknown.length > 0) return refuse(`These attachment ids weren't found among the files you uploaded: ${ unknown.join(", ") }`)

        const existing = proposal_filename ? readProposalManifest().find((e) => e.filename === proposal_filename) : undefined
        if(proposal_filename && !existing) return refuse(`No proposal named ${ proposal_filename } exists.`)
        if(existing && existing.created_by.sub !== user.sub) return refuse("That proposal belongs to someone else; only its creator can add to it.")

        const elsewhere = attachment_ids.map((id) => getAttachment(id)!).filter((a) => a.proposal_filename && a.proposal_filename !== existing?.filename)
        if(elsewhere.length > 0) return refuse(`${ elsewhere.map((a) => a.filename).join(", ") } already belong(s) to another proposal (${ elsewhere[0].proposal_filename }). Upload the file again to use it here.`)

        const ids = [...new Set([...(existing?.sources.map((s) => s.id) ?? []), ...attachment_ids])]
        const records = await waitForReads(ids)

        const stillReading = records.filter((r) => r.status === "processing")
        if(stillReading.length > 0) {
          logger.warn({ sub: user.sub, still_reading: stillReading.map((r) => r.id) }, "proposal_builder: files still being read, nothing built")
          return textResult({
            built: false,
            message: `Still reading ${ stillReading.map((r) => r.filename).join(", ") }. Nothing was built yet — try again in a minute or two.`
          })
        }

        const failed = records.filter((r) => r.status === "error")
        const usable = records.filter((r) => r.status === "done")
        if(usable.length === 0) {
          return refuse(`None of the files could be read: ${ failed.map((r) => `${ r.filename } (${ r.error })`).join("; ") }`)
        }

        const newNames = records.filter((r) => attachment_ids.includes(r.id) && !existing?.sources.some((s) => s.id === r.id)).map((r) => r.filename)
        const { buffer, entry, includedSections } = await buildProposal({
          attachments: usable,
          creator: user,
          preparedBy,
          clientName: client_name,
          existing,
          omitSections: omit_sections,
          refreshReason: newNames.length > 0 ? `Added: ${ newNames.join(", ") }` : "Rebuilt"
        })

        archiveProposal(buffer, entry)
        markAttachmentsUsed(usable.map((r) => r.id), entry.filename)
        logger.info({ sub: user.sub, filename: entry.filename, sections: includedSections.length, updated: Boolean(existing) }, "proposal_builder built")

        const token = storeDownload(buffer, entry.filename, DOCX_MIME_TYPE)
        return textResult({
          built: true,
          message: `${ existing ? "Updated" : "Built" } the proposal for ${ entry.client_name } — ${ includedSections.length } section(s): ${ includedSections.join(", ") }.`,
          proposal_filename: entry.filename,
          download_url: `${ publicBaseUrl }/downloads/${ token }`,
          sections: entry.sections,
          ...(entry.omitted_sections ? { omitted_sections: entry.omitted_sections } : {}),
          ...(failed.length > 0 ? { files_not_used: failed.map((r) => ({ filename: r.filename, error: r.error })) } : {})
        })
      } catch(error) {
        logger.error({ err: error, attachment_ids, proposal_filename }, "proposal_builder failed")
        return errorResult(error)
      }
    }
  )
}
