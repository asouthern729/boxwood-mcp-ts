import { sanitizeForFilename } from "./docArchive.js"
import { logger } from "./logger.js"
import { pullAmsCrossCheck } from "./policyCheckAms.js"
import { MAX_TOTAL_PAGES, PolicyCheckError, runPolicyCheck, type CheckDocument, type CheckRowFindings, type DocumentProfile, type PolicyCheckFindings } from "./policyCheckAnalysis.js"
import { buildPolicyCheckDoc } from "./policyCheckDoc.js"
import {
  createCheck, finishRunning, getCheck, getOwnedAttachment, readAttachmentDoc, saveFindings, writeCheck, writeReport,
  type CheckEntry, type PolicyCheckAttachment, type PolicyCheckUser
} from "./policyCheckStore.js"

// Runs one Policy Check in the background (it takes minutes — longer than nginx lets a request
// wait) and turns the analysis into the report. Everything the skill wants exact — item numbers,
// priority order, scorecard counts, the banner, premium totals and the driver reconciliation — is
// computed here from the findings rather than trusted to the model.

export type Priority = 1 | 2 | 3
export type NumberedItem = CheckRowFindings & { number: number; pri: Priority }

export type PremiumSummary = {
  lines: PolicyCheckFindings["premium_by_line"]
  drivers: PolicyCheckFindings["premium_drivers"]
  baseline: number | null
  compared: number | null
  change: number | null
  percent: number | null
}

export type ProcessedCheck = {
  findings: PolicyCheckFindings
  items: NumberedItem[]
  numberByRef: Map<string, number>
  counts: { correction: number; confirm: number; housekeeping: number; match: number }
  banner: { level: "red" | "amber" | "green"; text: string }
  premium: PremiumSummary
}

const FLAGGED = new Set(["ERROR", "MISSING", "ADDED", "CHANGED", "VERIFY"])

function priorityOf(row: CheckRowFindings): Priority {
  if(row.priority === "1" || row.priority === "2" || row.priority === "3") return Number(row.priority) as Priority
  // A flagged row the model left unprioritised: the skill makes ERROR/MISSING/ADDED corrections.
  return row.status === "ERROR" || row.status === "MISSING" || row.status === "ADDED" ? 1 : 2
}

const sum = (values: (number | null)[]) => (values.some((v) => v !== null) ? values.reduce<number>((total, v) => total + (v ?? 0), 0) : null)
const round2 = (n: number) => Math.round(n * 100) / 100

function summarizePremium(findings: PolicyCheckFindings): { premium: PremiumSummary; unexplained: number } {
  const baseline = sum(findings.premium_by_line.map((l) => l.baseline))
  const compared = sum(findings.premium_by_line.map((l) => l.compared))
  const change = baseline !== null && compared !== null ? round2(compared - baseline) : null
  const percent = change !== null && baseline ? round2((change / baseline) * 100) : null

  // Table 2 must sum exactly to the total change: whatever the drivers don't explain becomes one
  // Unexplained row (the skill's "never force a reconciliation").
  const drivers = findings.premium_drivers.filter((d) => d.kind !== "Unexplained")
  const explained = round2(drivers.reduce((total, d) => total + d.impact, 0))
  const unexplained = change === null ? 0 : round2(change - explained)
  if(Math.abs(unexplained) >= 0.01) {
    drivers.push({ kind: "Unexplained", line: "Program", detail: "Not traceable to the rating detail in the documents", impact: unexplained, ref: null })
  }
  drivers.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))

  return { premium: { lines: findings.premium_by_line, drivers, baseline, compared, change, percent }, unexplained }
}

export function processFindings(findings: PolicyCheckFindings): ProcessedCheck {
  const { premium, unexplained } = summarizePremium(findings)
  const rows = [...findings.rows]

  // An unexplained premium difference is a Confirm item (skill, Table 2 "Unexplained").
  if(Math.abs(unexplained) >= 1 && !rows.some((r) => r.ref === "premium-unexplained")) {
    rows.push({
      ref: "premium-unexplained", section: "A", line: "Program", item: "Premium change not explained by the documents",
      baseline: "—", compared: `$${ unexplained.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) } unexplained`,
      status: "VERIFY", priority: "2", action: "Ask the underwriter what drove the remaining premium change", citation: "Premium Change Schedule", correction_text: null
    })
  }

  // Line order: first appearance, with "Program" first.
  const lineOrder = [...new Set(["Program", ...rows.map((r) => r.line)])]
  const flagged = rows
    .filter((r) => FLAGGED.has(r.status))
    .map((r, index) => ({ row: r, pri: priorityOf(r), index }))
    .sort((a, b) => a.pri - b.pri || lineOrder.indexOf(a.row.line) - lineOrder.indexOf(b.row.line) || a.index - b.index)

  const items: NumberedItem[] = flagged.map(({ row, pri }, i) => ({ ...row, number: i + 1, pri }))
  const numberByRef = new Map(items.map((item) => [item.ref, item.number]))

  const counts = {
    correction: items.filter((i) => i.pri === 1).length,
    confirm: items.filter((i) => i.pri === 2).length,
    housekeeping: items.filter((i) => i.pri === 3).length,
    match: rows.filter((r) => r.status === "MATCH").length
  }

  const plural = (n: number, one: string, many: string) => `${ n } ${ n === 1 ? one : many }`
  const banner = counts.correction > 0
    ? { level: "red" as const, text: `ACTION REQUIRED — ${ plural(counts.correction, "item needs", "items need") } correction before delivery` }
    : counts.confirm + counts.housekeeping > 0
      ? { level: "amber" as const, text: `REVIEW — ${ plural(counts.confirm + counts.housekeeping, "item", "items") } to confirm` }
      : { level: "green" as const, text: "NO DISCREPANCIES FOUND" }

  return { findings: { ...findings, rows }, items, numberByRef, counts, banner, premium }
}

// ---------- Document labels and the AMS360 window ----------

const LABEL: Record<DocumentProfile["document_type"], string> = {
  quote: "Quote", binder: "Binder", expiring_policy: "Expiring", issued_policy: "Issued", renewal_policy: "Renewal",
  endorsement: "Endorsement", application: "Application", contract: "Contract", other: "Reference"
}

export function labelDocuments(attachments: PolicyCheckAttachment[]): CheckDocument[] {
  const used = new Map<string, number>()
  return attachments.map((a) => {
    const base = a.profile ? LABEL[a.profile.document_type] : a.role === "compared" ? "Issued" : a.role === "baseline" ? "Baseline" : "Reference"
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    const count = attachments.filter((b) => (b.profile ? LABEL[b.profile.document_type] : null) === base).length
    return { label: count > 1 ? `${ base } ${ n }` : base, filename: a.filename, role: a.role, doc: readAttachmentDoc(a), pages: a.profile?.pages ?? 0, profile: a.profile }
  })
}

// ~60 days before the baseline's date (skill 3E), from the document date or the term's start.
function activitySince(docs: CheckDocument[]): string {
  const dates = docs
    .filter((d) => d.role === "baseline")
    .flatMap((d) => [d.profile?.document_date, d.profile?.policy_period?.match(/\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}/)?.[0]])
    .map((s) => (s ? Date.parse(s) : NaN))
    .filter((t) => !Number.isNaN(t))
  const anchor = dates.length > 0 ? Math.min(...dates) : Date.now() - 60 * 86_400_000
  return new Date(anchor - 60 * 86_400_000).toISOString().slice(0, 10)
}

const MODE_LABEL: Record<PolicyCheckFindings["mode"], string> = { quote_to_issued: "Quote to Issued", expiring_to_renewal: "Expiring to Renewal", both: "Quote and Expiring to Renewal" }

function reportFilename(client: string, mode: PolicyCheckFindings["mode"], id: string): string {
  const d = new Date()
  const date = `${ String(d.getMonth() + 1).padStart(2, "0") }-${ String(d.getDate()).padStart(2, "0") }-${ d.getFullYear() }`
  return `${ sanitizeForFilename(client) }_Policy_Check_${ sanitizeForFilename(MODE_LABEL[mode]) }_${ date }_${ id.slice(0, 8) }.docx`
}

// ---------- Starting a check (the page's Run button and the chat's policy_check tool) ----------

export class CheckRefused extends Error {}

export function startCheck(user: PolicyCheckUser, attachmentIds: string[], o: { notes?: string; clientName?: string } = {}): CheckEntry {
  const ids = [...new Set(attachmentIds)]
  if(ids.length === 0) throw new CheckRefused("Add at least a baseline (quote, binder or expiring policy) and the issued or renewal policy.")
  const records = ids.map((id) => getOwnedAttachment(id, user.sub))
  const missing = ids.filter((_, i) => !records[i])
  if(missing.length > 0) throw new CheckRefused(`These files weren't found among your uploads: ${ missing.join(", ") }`)
  const attachments = records as PolicyCheckAttachment[]

  const used = attachments.filter((a) => a.job_id)
  if(used.length > 0) throw new CheckRefused(`${ used.map((a) => a.filename).join(", ") } already belong(s) to another check. Upload the file again to use it in a new one.`)
  const reading = attachments.filter((a) => a.status === "processing")
  if(reading.length > 0) throw new CheckRefused(`Still reading ${ reading.map((a) => a.filename).join(", ") }. Try again in a moment.`)
  const failed = attachments.filter((a) => a.status === "error")
  if(failed.length > 0) throw new CheckRefused(`${ failed.map((a) => a.filename).join(", ") } couldn't be read. Remove it or upload it again.`)
  if(!attachments.some((a) => a.role === "baseline")) throw new CheckRefused("Add the baseline: the quote, binder or expiring policy.")
  if(!attachments.some((a) => a.role === "compared")) throw new CheckRefused("Add the issued or renewal policy to check.")

  const pages = attachments.reduce((total, a) => total + (a.profile?.pages ?? 0), 0)
  if(pages > MAX_TOTAL_PAGES) throw new CheckRefused(`These documents total ${ pages } pages; a check can read ${ MAX_TOTAL_PAGES } at most. Remove reference documents or upload only the relevant policy sections.`)

  const entry = createCheck({
    client_name: o.clientName?.trim() || null,
    created_by: user,
    prepared_by: user.name,
    ...(o.notes?.trim() ? { notes: o.notes.trim().slice(0, 2000) } : {}),
    mode: null,
    sources: attachments.map((a) => ({ id: a.id, filename: a.filename, role: a.role }))
  }, attachments)
  void executeCheck(entry, attachments)
  logger.info({ sub: user.sub, check: entry.id, files: attachments.length, pages }, "policy_check: check started")
  return entry
}

// ---------- The job ----------

export async function executeCheck(entry: CheckEntry, attachments: PolicyCheckAttachment[]): Promise<void> {
  const started = Date.now()
  try {
    const documents = labelDocuments(attachments)
    const policyNumbers = documents.filter((d) => d.role !== "reference").map((d) => d.profile?.policy_number).filter((p): p is string => Boolean(p))
    const namedInsured = documents.find((d) => d.role === "compared")?.profile?.named_insured ?? documents.find((d) => d.profile?.named_insured)?.profile?.named_insured ?? null

    const ams = await pullAmsCrossCheck({ policyNumbers, namedInsured, since: activitySince(documents) })
    const findings = await runPolicyCheck({ documents, ams, notes: entry.notes })
    const processed = processFindings(findings)

    // Deleted while it ran: discard the result.
    if(!getCheck(entry.id)) {
      logger.info({ check: entry.id }, "policy_check: check deleted while running; result discarded")
      return
    }

    const clientName = entry.client_name ?? findings.client_name
    const filename = reportFilename(clientName, findings.mode, entry.id)
    const buffer = await buildPolicyCheckDoc(processed, {
      clientName,
      preparedFor: entry.prepared_by,
      documents,
      amsPulledAt: ams.customer ? ams.pulled_at : null
    })

    writeReport(filename, buffer)
    saveFindings(entry.id, { ...processed.findings, numbered: processed.items.map((i) => ({ number: i.number, ref: i.ref })), ams })
    writeCheck({
      ...entry,
      status: "done",
      client_name: clientName,
      mode: findings.mode,
      filename,
      finished_at: new Date().toISOString(),
      banner: processed.banner,
      counts: processed.counts,
      premium_change: { baseline: processed.premium.baseline, compared: processed.premium.compared, change: processed.premium.change, percent: processed.premium.percent }
    })
    logger.info({ check: entry.id, ms: Date.now() - started, items: processed.items.length, banner: processed.banner.level }, "policy_check: check finished")
  } catch(error) {
    logger.error({ err: error, check: entry.id }, "policy_check: check failed")
    if(getCheck(entry.id)) {
      const message = error instanceof PolicyCheckError ? error.message : "Something went wrong running this check. Try again; if it keeps failing, let Andrew know."
      writeCheck({ ...entry, status: "failed", error: message, finished_at: new Date().toISOString() })
    }
  } finally {
    finishRunning(entry.id)
  }
}
