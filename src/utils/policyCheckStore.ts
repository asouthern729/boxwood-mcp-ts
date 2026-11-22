import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { outputDir } from "../config/config.js"
import type { DocumentProfile, PolicyCheckFindings, PolicyCheckRole } from "./policyCheckAnalysis.js"
import { deleteUpload, readUpload, saveUpload, uploadFilePath, writeUploadRecord, type UploadRecord } from "./uploadStore.js"

// Storage for the Policy Check page (Andrew, 2026-11-22). Owner-scoped like the Proposal Builder:
//   <OUTPUT_ROOT>/policy-check/attachments/<id>.pdf + <id>.json   uploads (uploadStore.ts)
//   <OUTPUT_ROOT>/policy-check/checks/<id>.json                    one record per check
//   <OUTPUT_ROOT>/policy-check/checks/<id>.findings.json           what the analysis returned (chat follow-ups read it)
//   <OUTPUT_ROOT>/policy-check/<filename>.docx                     the report

export const POLICY_CHECK_OUTPUT_DIR = outputDir("policy-check")
const ATTACHMENTS_DIR = path.join(POLICY_CHECK_OUTPUT_DIR, "attachments")
const CHECKS_DIR = path.join(POLICY_CHECK_OUTPUT_DIR, "checks")

// A first read that never finished (server restarted mid-read) would otherwise poll forever.
const STALE_READ_MS = 20 * 60 * 1000

export type PolicyCheckUser = { sub: string; name: string; email: string }

// ---------- Attachments ----------

export type PolicyCheckAttachment = UploadRecord & {
  role: PolicyCheckRole
  owner_sub: string
  profile?: DocumentProfile
  // Set once a check is started from it; it can't be moved or removed on its own after that.
  check_id?: string
}

export function saveAttachment(file: Buffer, filename: string, role: PolicyCheckRole, ownerSub: string): PolicyCheckAttachment {
  return saveUpload<PolicyCheckAttachment>(ATTACHMENTS_DIR, file, { filename, role, owner_sub: ownerSub, ext: "pdf" })
}

export function getAttachment(id: string): PolicyCheckAttachment | null {
  const record = readUpload<PolicyCheckAttachment>(ATTACHMENTS_DIR, id)
  if(record?.status === "processing" && Date.now() - Date.parse(record.uploaded_at) > STALE_READ_MS) {
    return writeUploadRecord(ATTACHMENTS_DIR, { ...record, status: "error", error: "Reading this file was interrupted. Upload it again." })
  }
  return record
}

// Only its owner sees an attachment; anyone else gets the same answer as for a missing one.
export function getOwnedAttachment(id: string, ownerSub: string): PolicyCheckAttachment | null {
  const record = getAttachment(id)
  return record && record.owner_sub === ownerSub ? record : null
}

export function updateAttachment(record: PolicyCheckAttachment): PolicyCheckAttachment {
  return writeUploadRecord(ATTACHMENTS_DIR, record)
}

export function deleteAttachment(id: string): boolean {
  return deleteUpload(ATTACHMENTS_DIR, id)
}

export function readAttachmentFile(record: PolicyCheckAttachment): Buffer {
  return readFileSync(uploadFilePath(ATTACHMENTS_DIR, record))
}

// What the API returns — the profile, never the file.
export function attachmentSummary(record: PolicyCheckAttachment) {
  return {
    id: record.id,
    filename: record.filename,
    role: record.role,
    status: record.status,
    ...(record.error ? { error: record.error } : {}),
    ...(record.status === "done" && record.profile ? {
      profile: {
        document_type: record.profile.document_type,
        named_insured: record.profile.named_insured,
        carrier: record.profile.carrier,
        policy_number: record.profile.policy_number,
        policy_period: record.profile.policy_period,
        pages: record.profile.pages,
        suggested_role: record.profile.suggested_role
      }
    } : {})
  }
}

// ---------- Checks ----------

export type CheckStatus = "running" | "failed" | "done"

export type CheckEntry = {
  id: string
  client_name: string | null
  status: CheckStatus
  error?: string
  mode: PolicyCheckFindings["mode"] | null
  created_by: PolicyCheckUser
  prepared_by: string
  notes?: string
  generated_at: string
  finished_at?: string
  filename?: string
  banner?: { level: "red" | "amber" | "green"; text: string }
  counts?: { correction: number; confirm: number; housekeeping: number; match: number }
  premium_change?: { baseline: number | null; compared: number | null; change: number | null; percent: number | null }
  sources: { id: string; filename: string; role: PolicyCheckRole }[]
}

// Checks running in this process. A record that says "running" but isn't here was interrupted by a
// restart, and reads as failed.
const running = new Set<string>()

const checkPath = (id: string) => path.join(CHECKS_DIR, `${ id }.json`)
const findingsPath = (id: string) => path.join(CHECKS_DIR, `${ id }.findings.json`)
const validId = (id: string) => /^[0-9a-f-]{36}$/i.test(id)

export function writeCheck(entry: CheckEntry): CheckEntry {
  mkdirSync(CHECKS_DIR, { recursive: true })
  writeFileSync(checkPath(entry.id), JSON.stringify(entry, null, 2))
  return entry
}

function interrupted(entry: CheckEntry): CheckEntry {
  return entry.status === "running" && !running.has(entry.id)
    ? { ...entry, status: "failed", error: "This check was interrupted (the server restarted). Run it again." }
    : entry
}

export function getCheck(id: string): CheckEntry | null {
  if(!validId(id) || !existsSync(checkPath(id))) return null
  try {
    return interrupted(JSON.parse(readFileSync(checkPath(id), "utf8")) as CheckEntry)
  } catch {
    return null
  }
}

export function listChecks(): CheckEntry[] {
  if(!existsSync(CHECKS_DIR)) return []
  return readdirSync(CHECKS_DIR)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".findings.json"))
    .flatMap((name) => {
      const entry = getCheck(name.slice(0, -".json".length))
      return entry ? [entry] : []
    })
    .sort((a, b) => b.generated_at.localeCompare(a.generated_at))
}

export function createCheck(fields: Omit<CheckEntry, "id" | "status" | "generated_at" | "mode" | "client_name"> & { client_name?: string | null }): CheckEntry {
  const entry: CheckEntry = { client_name: null, ...fields, id: randomUUID(), status: "running", mode: null, generated_at: new Date().toISOString() }
  running.add(entry.id)
  return writeCheck(entry)
}

export function finishRunning(id: string): void {
  running.delete(id)
}

export function saveFindings(id: string, findings: unknown): void {
  writeFileSync(findingsPath(id), JSON.stringify(findings))
}

export function readFindings<T = PolicyCheckFindings>(id: string): T | null {
  if(!validId(id) || !existsSync(findingsPath(id))) return null
  try {
    return JSON.parse(readFileSync(findingsPath(id), "utf8")) as T
  } catch {
    return null
  }
}

export function reportPath(filename: string): string | null {
  // Only names a check actually produced — never a path from the request.
  if(!listChecks().some((c) => c.filename === filename)) return null
  const file = path.join(POLICY_CHECK_OUTPUT_DIR, filename)
  return existsSync(file) ? file : null
}

export function writeReport(filename: string, buffer: Buffer): void {
  mkdirSync(POLICY_CHECK_OUTPUT_DIR, { recursive: true })
  writeFileSync(path.join(POLICY_CHECK_OUTPUT_DIR, filename), buffer)
}

export function reportSize(filename: string): number | undefined {
  const file = path.join(POLICY_CHECK_OUTPUT_DIR, filename)
  return existsSync(file) ? statSync(file).size : undefined
}

// Removes the check, its report (and cached PDF), its findings and the files it was built from.
export function deleteCheck(entry: CheckEntry): void {
  running.delete(entry.id)
  for(const file of [checkPath(entry.id), findingsPath(entry.id)]) if(existsSync(file)) unlinkSync(file)
  if(entry.filename) {
    const docx = path.join(POLICY_CHECK_OUTPUT_DIR, entry.filename)
    for(const file of [docx, docx.replace(/\.docx$/i, ".pdf")]) if(existsSync(file)) unlinkSync(file)
  }
  for(const source of entry.sources) deleteAttachment(source.id)
}

export const isRunning = (id: string) => running.has(id)
