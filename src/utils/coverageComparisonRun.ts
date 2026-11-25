import { sanitizeForFilename } from "./docArchive.js"
import { DocToolError, MAX_TOTAL_PAGES } from "./docToolClaude.js"
import { logger } from "./logger.js"
import { runCoverageComparison, type Comparison } from "./coverageComparisonAnalysis.js"
import { buildCoverageComparisonDoc } from "./coverageComparisonDoc.js"
import {
  createJob, finishRunning, getJob, getOwnedAttachment, readAttachmentDoc, saveFindings, writeJob, writeReport,
  type ComparisonAttachment, type ComparisonEntry, type ComparisonUser
} from "./coverageComparisonStore.js"

// Starts and runs one CL Coverage Comparison in the background (a few minutes — longer than nginx
// lets a request wait). Same shape as policyCheckRun.ts, without the AMS360 step.

export class ComparisonRefused extends Error {}

// The Premium Summary's total row (or the sum of the numeric rows when there's no total row).
function premiumTotals(c: Comparison): ComparisonEntry["premium"] {
  const total = c.premium.rows.find((r) => r.total)
  const num = (v: unknown) => (typeof v === "number" ? v : null)
  const sum = (key: "a" | "b") => {
    const values = c.premium.rows.filter((r) => !r.total).map((r) => num(r[key]))
    return values.some((v) => v !== null) ? values.reduce<number>((s, v) => s + (v ?? 0), 0) : null
  }
  const a = total ? num(total.a) : sum("a")
  const b = total ? num(total.b) : sum("b")
  return { a, b, difference: a !== null && b !== null ? Math.round((b - a) * 100) / 100 : null }
}

function usLongDate(d = new Date()): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" })
}

function reportFilename(client: string, id: string): string {
  const d = new Date()
  const date = `${ String(d.getMonth() + 1).padStart(2, "0") }-${ String(d.getDate()).padStart(2, "0") }-${ d.getFullYear() }`
  return `${ sanitizeForFilename(client) }_Coverage_Comparison_${ date }_${ id.slice(0, 8) }.docx`
}

async function executeComparison(entry: ComparisonEntry, attachments: ComparisonAttachment[]): Promise<void> {
  const started = Date.now()
  try {
    const documents = attachments.map((a) => ({ role: a.role, filename: a.filename, doc: readAttachmentDoc(a), pages: a.profile?.pages ?? 0 }))
    const comparison = await runCoverageComparison({ documents, notes: entry.notes, labels: entry.requested_labels })
    if(entry.client_name) comparison.client.name = entry.client_name

    // Deleted while it ran: discard the result.
    if(!getJob(entry.id)) {
      logger.info({ comparison: entry.id }, "coverage_comparison: deleted while running; result discarded")
      return
    }

    const filename = reportFilename(comparison.client.name, entry.id)
    writeReport(filename, await buildCoverageComparisonDoc(comparison, usLongDate()))
    saveFindings(entry.id, comparison)
    writeJob({
      ...entry,
      status: "done",
      client_name: comparison.client.name,
      filename,
      finished_at: new Date().toISOString(),
      sets: { a: comparison.set_a.label, b: comparison.set_b.label },
      premium: premiumTotals(comparison),
      key_points: comparison.key_points.length
    })
    logger.info({ comparison: entry.id, ms: Date.now() - started, lines: comparison.lines.length }, "coverage_comparison: finished")
  } catch(error) {
    logger.error({ err: error, comparison: entry.id }, "coverage_comparison: failed")
    if(getJob(entry.id)) {
      const message = error instanceof DocToolError ? error.message : "Something went wrong running this comparison. Try again; if it keeps failing, let Andrew know."
      writeJob({ ...entry, status: "failed", error: message, finished_at: new Date().toISOString() })
    }
  } finally {
    finishRunning(entry.id)
  }
}

export function startComparison(user: ComparisonUser, attachmentIds: string[], o: { notes?: string; clientName?: string; setALabel?: string; setBLabel?: string } = {}): ComparisonEntry {
  const ids = [...new Set(attachmentIds)]
  if(ids.length === 0) throw new ComparisonRefused("Add the documents for both sets: Set A (current, expiring or first quote) and Set B (proposed, renewal or second quote).")
  const records = ids.map((id) => getOwnedAttachment(id, user.sub))
  const missing = ids.filter((_, i) => !records[i])
  if(missing.length > 0) throw new ComparisonRefused(`These files weren't found among your uploads: ${ missing.join(", ") }`)
  const attachments = records as ComparisonAttachment[]

  const used = attachments.filter((a) => a.job_id)
  if(used.length > 0) throw new ComparisonRefused(`${ used.map((a) => a.filename).join(", ") } already belong(s) to another comparison. Upload the file again to use it in a new one.`)
  const reading = attachments.filter((a) => a.status === "processing")
  if(reading.length > 0) throw new ComparisonRefused(`Still reading ${ reading.map((a) => a.filename).join(", ") }. Try again in a moment.`)
  const failed = attachments.filter((a) => a.status === "error")
  if(failed.length > 0) throw new ComparisonRefused(`${ failed.map((a) => a.filename).join(", ") } couldn't be read. Remove it or upload it again.`)
  if(!attachments.some((a) => a.role === "set_a")) throw new ComparisonRefused("Add at least one document to Set A (current, expiring or first quote).")
  if(!attachments.some((a) => a.role === "set_b")) throw new ComparisonRefused("Add at least one document to Set B (proposed, renewal or second quote).")

  const pages = attachments.reduce((total, a) => total + (a.profile?.pages ?? 0), 0)
  if(pages > MAX_TOTAL_PAGES) throw new ComparisonRefused(`These documents total ${ pages } pages; a comparison can read ${ MAX_TOTAL_PAGES } at most. Upload only the relevant quotes or policy sections.`)

  const labels = { ...(o.setALabel?.trim() ? { a: o.setALabel.trim().slice(0, 80) } : {}), ...(o.setBLabel?.trim() ? { b: o.setBLabel.trim().slice(0, 80) } : {}) }
  const entry = createJob({
    client_name: o.clientName?.trim() || null,
    created_by: user,
    prepared_by: user.name,
    ...(o.notes?.trim() ? { notes: o.notes.trim().slice(0, 2000) } : {}),
    ...(labels.a || labels.b ? { requested_labels: labels } : {}),
    sources: attachments.map((a) => ({ id: a.id, filename: a.filename, role: a.role }))
  }, attachments)
  void executeComparison(entry, attachments)
  logger.info({ sub: user.sub, comparison: entry.id, files: attachments.length, pages }, "coverage_comparison: started")
  return entry
}
