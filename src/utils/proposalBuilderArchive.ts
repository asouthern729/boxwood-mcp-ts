import { createDocArchive } from "./docArchive.js"

// scripts/output/proposal-builder/ — proposals built in the Proposal Builder chat purely from
// uploaded files (proposalBuilderGenerate.ts). Unlike the CL index pages, these belong to the staff
// member who built them, not a CSR: the list defaults to your own, with an "All" view grouped by
// creator, and only the creator can delete one.

export type ProposalCreator = { sub: string; name: string; email: string }

export type ProposalSectionSource = "quote" | "ams"

export type ProposalEntry = {
  filename: string
  client_name: string
  // "commercial" for now — the field leaves room for other proposal types later.
  line_type: "commercial"
  // Who owns it (the Auth0 identity) — the list and delete rights go by this.
  created_by: ProposalCreator
  // The name printed as Prepared By, given in the chat ("Firstname Lastname"). Absent on proposals
  // built before 2026-10-10.
  prepared_by?: string
  generated_at: string
  last_refreshed_at?: string
  last_refresh_reason?: string
  sections: { title: string; carrier: string; source: ProposalSectionSource }[]
  // Every attachment the document is built from, oldest first.
  sources: { id: string; filename: string; kind: "quote_pdf" | "ams_docx" | "ams_pdf" }[]
}

const proposalBuilderArchive = createDocArchive<ProposalEntry>("proposal-builder")

export const PROPOSAL_BUILDER_OUTPUT_DIR = proposalBuilderArchive.outputDir
export const readProposalManifest = proposalBuilderArchive.readManifest
export const archiveProposal = proposalBuilderArchive.archive
export const deleteProposal = proposalBuilderArchive.remove
