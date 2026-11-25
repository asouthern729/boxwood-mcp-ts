import { sanitizeForFilename } from "./docArchive.js"
import { DocToolError, MAX_TOTAL_PAGES } from "./docToolClaude.js"
import { logger } from "./logger.js"
import { runCoverageGapAnalysis } from "./coverageGapAnalysis.js"
import { buildCoverageGapDoc } from "./coverageGapDoc.js"
import {
  createJob, finishRunning, getJob, getOwnedAttachment, readAttachmentDoc, saveFindings, writeJob, writeReport,
  type GapAttachment, type GapEntry, type GapUser
} from "./coverageGapStore.js"

// Starts and runs one Coverage Gap analysis in the background (a few minutes — longer than nginx
// lets a request wait). Same shape as coverageComparisonRun.ts, with one set of documents.

export class GapRefused extends Error {}

export const MAX_NOTES_LENGTH = 4000

function usLongDate(d = new Date()): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" })
}

function reportFilename(client: string, id: string): string {
  const d = new Date()
  const date = `${ String(d.getMonth() + 1).padStart(2, "0") }-${ String(d.getDate()).padStart(2, "0") }-${ d.getFullYear() }`
  return `${ sanitizeForFilename(client) }_Coverage_Gap_Analysis_${ date }_${ id.slice(0, 8) }.docx`
}

async function executeGapAnalysis(entry: GapEntry, attachments: GapAttachment[]): Promise<void> {
  const started = Date.now()
  try {
    const documents = attachments.map((a) => ({ filename: a.filename, doc: readAttachmentDoc(a), pages: a.profile?.pages ?? 0 }))
    const analysis = await runCoverageGapAnalysis({ documents, notes: entry.notes })
    if(entry.client_name) analysis.client_name = entry.client_name

    // Deleted while it ran: discard the result.
    if(!getJob(entry.id)) {
      logger.info({ analysis: entry.id }, "coverage_gap: deleted while running; result discarded")
      return
    }

    const filename = reportFilename(analysis.client_name, entry.id)
    writeReport(filename, await buildCoverageGapDoc(analysis, { reviewDate: usLongDate(), preparedBy: entry.prepared_by, hasNotes: Boolean(entry.notes) }))
    saveFindings(entry.id, analysis)
    writeJob({
      ...entry,
      status: "done",
      client_name: analysis.client_name,
      filename,
      finished_at: new Date().toISOString(),
      policies: analysis.policies.length,
      counts: {
        gap: analysis.findings.filter((f) => f.status === "GAP").length,
        confirm: analysis.findings.filter((f) => f.status === "CONFIRM").length,
        high: analysis.findings.filter((f) => f.priority === "High").length
      }
    })
    logger.info({ analysis: entry.id, ms: Date.now() - started, findings: analysis.findings.length }, "coverage_gap: finished")
  } catch(error) {
    logger.error({ err: error, analysis: entry.id }, "coverage_gap: failed")
    if(getJob(entry.id)) {
      const message = error instanceof DocToolError ? error.message : "Something went wrong running this gap analysis. Try again; if it keeps failing, let Andrew know."
      writeJob({ ...entry, status: "failed", error: message, finished_at: new Date().toISOString() })
    }
  } finally {
    finishRunning(entry.id)
  }
}

export function startGapAnalysis(user: GapUser, attachmentIds: string[], o: { notes?: string; clientName?: string } = {}): GapEntry {
  const ids = [...new Set(attachmentIds)]
  if(ids.length === 0) throw new GapRefused("Add the account's policy documents (declarations, forms schedules and endorsements) first.")
  const records = ids.map((id) => getOwnedAttachment(id, user.sub))
  const missing = ids.filter((_, i) => !records[i])
  if(missing.length > 0) throw new GapRefused(`These files weren't found among your uploads: ${ missing.join(", ") }`)
  const attachments = records as GapAttachment[]

  const used = attachments.filter((a) => a.job_id)
  if(used.length > 0) throw new GapRefused(`${ used.map((a) => a.filename).join(", ") } already belong(s) to another gap analysis. Upload the file again to use it in a new one.`)
  const reading = attachments.filter((a) => a.status === "processing")
  if(reading.length > 0) throw new GapRefused(`Still reading ${ reading.map((a) => a.filename).join(", ") }. Try again in a moment.`)
  const failed = attachments.filter((a) => a.status === "error")
  if(failed.length > 0) throw new GapRefused(`${ failed.map((a) => a.filename).join(", ") } couldn't be read. Remove it or upload it again.`)

  const pages = attachments.reduce((total, a) => total + (a.profile?.pages ?? 0), 0)
  if(pages > MAX_TOTAL_PAGES) throw new GapRefused(`These documents total ${ pages } pages; a gap analysis can read ${ MAX_TOTAL_PAGES } at most. Upload the declarations, forms schedules and endorsements rather than full policy jackets.`)

  const entry = createJob({
    client_name: o.clientName?.trim() || null,
    created_by: user,
    prepared_by: user.name,
    ...(o.notes?.trim() ? { notes: o.notes.trim().slice(0, MAX_NOTES_LENGTH) } : {}),
    sources: attachments.map((a) => ({ id: a.id, filename: a.filename, role: a.role }))
  }, attachments)
  void executeGapAnalysis(entry, attachments)
  logger.info({ sub: user.sub, analysis: entry.id, files: attachments.length, pages, notes: Boolean(entry.notes) }, "coverage_gap: started")
  return entry
}
