import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { outputDir } from "../config/config.js"
import type { DocumentProfile } from "./policyCheckAnalysis.js"
import { deleteUpload, readUpload, saveUpload, uploadFilePath, writeUploadRecord, type UploadRecord } from "./uploadStore.js"

// Shared storage for the upload-and-run document tools (Policy Check, CL Coverage Comparison):
// staff upload PDFs into named roles, a background job reads them all and writes a Word report.
// Everything is owned by whoever uploaded/ran it (like the Proposal Builder).
//   <OUTPUT_ROOT>/<subdir>/attachments/<id>.pdf + <id>.json   uploads (uploadStore.ts)
//   <OUTPUT_ROOT>/<subdir>/jobs/<id>.json                      one record per run
//   <OUTPUT_ROOT>/<subdir>/jobs/<id>.findings.json             what the analysis returned (chat follow-ups read it)
//   <OUTPUT_ROOT>/<subdir>/<filename>.docx                     the report

// A first read that never finished (server restarted mid-read) would otherwise poll forever.
const STALE_READ_MS = 20 * 60 * 1000

export type DocToolUser = { sub: string; name: string; email: string }

export type DocToolAttachment<Role extends string> = UploadRecord & {
  role: Role
  owner_sub: string
  profile?: DocumentProfile
  // Set once a run is started from it; it can't be moved or removed on its own after that.
  job_id?: string
}

export type JobStatus = "running" | "failed" | "done"

// The fields every run record has; each tool adds its own summary fields.
export type BaseJobEntry<Role extends string> = {
  id: string
  client_name: string | null
  status: JobStatus
  error?: string
  created_by: DocToolUser
  prepared_by: string
  notes?: string
  generated_at: string
  finished_at?: string
  filename?: string
  sources: { id: string; filename: string; role: Role }[]
}

export function createDocToolStore<Role extends string, Entry extends BaseJobEntry<Role>>(subdir: string) {
  const OUTPUT_DIR = outputDir(subdir)
  const ATTACHMENTS_DIR = path.join(OUTPUT_DIR, "attachments")
  const JOBS_DIR = path.join(OUTPUT_DIR, "jobs")
  type Attachment = DocToolAttachment<Role>

  // ---------- Attachments ----------

  function saveAttachment(file: Buffer, filename: string, role: Role, ownerSub: string): Attachment {
    return saveUpload<Attachment>(ATTACHMENTS_DIR, file, { filename, role, owner_sub: ownerSub, ext: "pdf" } as Omit<Attachment, "id" | "uploaded_at" | "status">)
  }

  function getAttachment(id: string): Attachment | null {
    const record = readUpload<Attachment>(ATTACHMENTS_DIR, id)
    if(record?.status === "processing" && Date.now() - Date.parse(record.uploaded_at) > STALE_READ_MS) {
      return writeUploadRecord(ATTACHMENTS_DIR, { ...record, status: "error", error: "Reading this file was interrupted. Upload it again." })
    }
    return record
  }

  // Only its owner sees an attachment; anyone else gets the same answer as for a missing one.
  function getOwnedAttachment(id: string, ownerSub: string): Attachment | null {
    const record = getAttachment(id)
    return record && record.owner_sub === ownerSub ? record : null
  }

  const updateAttachment = (record: Attachment): Attachment => writeUploadRecord(ATTACHMENTS_DIR, record)
  const deleteAttachment = (id: string): boolean => deleteUpload(ATTACHMENTS_DIR, id)
  const readAttachmentFile = (record: Attachment): Buffer => readFileSync(uploadFilePath(ATTACHMENTS_DIR, record))

  // What the API returns — the profile, never the file. `extraProfile` adds tool-specific fields
  // (Policy Check's suggested_role).
  function attachmentSummary(record: Attachment, extraProfile?: (profile: DocumentProfile) => Record<string, unknown>) {
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
          ...extraProfile?.(record.profile)
        }
      } : {})
    }
  }

  // ---------- Jobs ----------

  // Runs in this process. A record that says "running" but isn't here was interrupted by a
  // restart, and reads as failed.
  const running = new Set<string>()

  const jobPath = (id: string) => path.join(JOBS_DIR, `${ id }.json`)
  const findingsPath = (id: string) => path.join(JOBS_DIR, `${ id }.findings.json`)
  const validId = (id: string) => /^[0-9a-f-]{36}$/i.test(id)

  function writeJob(entry: Entry): Entry {
    mkdirSync(JOBS_DIR, { recursive: true })
    writeFileSync(jobPath(entry.id), JSON.stringify(entry, null, 2))
    return entry
  }

  function interrupted(entry: Entry): Entry {
    return entry.status === "running" && !running.has(entry.id)
      ? { ...entry, status: "failed", error: "This run was interrupted (the server restarted). Run it again." }
      : entry
  }

  function getJob(id: string): Entry | null {
    if(!validId(id) || !existsSync(jobPath(id))) return null
    try {
      return interrupted(JSON.parse(readFileSync(jobPath(id), "utf8")) as Entry)
    } catch {
      return null
    }
  }

  // Newest first.
  function listJobs(): Entry[] {
    if(!existsSync(JOBS_DIR)) return []
    return readdirSync(JOBS_DIR)
      .filter((name) => name.endsWith(".json") && !name.endsWith(".findings.json"))
      .flatMap((name) => {
        const entry = getJob(name.slice(0, -".json".length))
        return entry ? [entry] : []
      })
      .sort((a, b) => b.generated_at.localeCompare(a.generated_at))
  }

  // Records the run, marks its attachments as used, and registers it as running.
  function createJob(fields: Omit<Entry, "id" | "status" | "generated_at">, attachments: Attachment[]): Entry {
    const entry = { ...fields, id: randomUUID(), status: "running", generated_at: new Date().toISOString() } as Entry
    running.add(entry.id)
    writeJob(entry)
    for(const a of attachments) updateAttachment({ ...a, job_id: entry.id })
    return entry
  }

  const finishRunning = (id: string) => void running.delete(id)
  const saveFindings = (id: string, findings: unknown) => writeFileSync(findingsPath(id), JSON.stringify(findings))

  function readFindings<T>(id: string): T | null {
    if(!validId(id) || !existsSync(findingsPath(id))) return null
    try {
      return JSON.parse(readFileSync(findingsPath(id), "utf8")) as T
    } catch {
      return null
    }
  }

  // Only names a run actually produced — never a path from the request.
  function reportPath(filename: string): string | null {
    if(!listJobs().some((j) => j.filename === filename)) return null
    const file = path.join(OUTPUT_DIR, filename)
    return existsSync(file) ? file : null
  }

  function writeReport(filename: string, buffer: Buffer): void {
    mkdirSync(OUTPUT_DIR, { recursive: true })
    writeFileSync(path.join(OUTPUT_DIR, filename), buffer)
  }

  function reportSize(filename: string): number | undefined {
    const file = path.join(OUTPUT_DIR, filename)
    return existsSync(file) ? statSync(file).size : undefined
  }

  // Removes the run, its report (and cached PDF), its findings and the files it was built from.
  function deleteJob(entry: Entry): void {
    running.delete(entry.id)
    for(const file of [jobPath(entry.id), findingsPath(entry.id)]) if(existsSync(file)) unlinkSync(file)
    if(entry.filename) {
      const docx = path.join(OUTPUT_DIR, entry.filename)
      for(const file of [docx, docx.replace(/\.docx$/i, ".pdf")]) if(existsSync(file)) unlinkSync(file)
    }
    for(const source of entry.sources) deleteAttachment(source.id)
  }

  return {
    OUTPUT_DIR,
    saveAttachment, getAttachment, getOwnedAttachment, updateAttachment, deleteAttachment, readAttachmentFile, attachmentSummary,
    writeJob, getJob, listJobs, createJob, finishRunning, saveFindings, readFindings, reportPath, writeReport, reportSize, deleteJob,
    isRunning: (id: string) => running.has(id)
  }
}
