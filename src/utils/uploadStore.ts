import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

// Uploaded files that Claude reads in the background, with a JSON record per upload beside the file:
// <dir>/<id>.<ext> + <id>.json. Shared by the CL Renewal Summary's quote uploads (clQuoteStore.ts,
// one directory per archived document) and the Proposal Builder's chat attachments
// (proposalAttachments.ts, one directory for all of them).

export type UploadStatus = "processing" | "done" | "error"

export type UploadRecord = {
  id: string
  filename: string
  uploaded_at: string
  status: UploadStatus
  error?: string
  // The stored file's extension, without the dot. Absent on quote records from before 2026-10-10,
  // which are always PDFs.
  ext?: string
}

export function uploadFilePath(dir: string, record: Pick<UploadRecord, "id" | "ext">): string {
  return path.join(dir, `${ record.id }.${ record.ext ?? "pdf" }`)
}

function recordPath(dir: string, id: string): string {
  return path.join(dir, `${ id }.json`)
}

export function writeUploadRecord<R extends UploadRecord>(dir: string, record: R): R {
  writeFileSync(recordPath(dir, record.id), JSON.stringify(record, null, 2))
  return record
}

export function saveUpload<R extends UploadRecord>(dir: string, file: Buffer, fields: Omit<R, "id" | "uploaded_at" | "status">): R {
  mkdirSync(dir, { recursive: true })

  const record = { ...fields, id: randomUUID(), uploaded_at: new Date().toISOString(), status: "processing" } as R
  writeFileSync(uploadFilePath(dir, record), file)
  return writeUploadRecord(dir, record)
}

export function readUpload<R extends UploadRecord>(dir: string, id: string): R | null {
  // ids are UUIDs; anything else can't name a record (and can't walk out of the directory).
  if(!/^[0-9a-f-]{36}$/i.test(id) || !existsSync(recordPath(dir, id))) return null
  try {
    return JSON.parse(readFileSync(recordPath(dir, id), "utf8")) as R
  } catch {
    return null
  }
}

// Oldest first.
export function listUploads<R extends UploadRecord>(dir: string): R[] {
  if(!existsSync(dir)) return []

  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(path.join(dir, name), "utf8")) as R]
      } catch {
        return []
      }
    })
    .sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at))
}

export function deleteUpload(dir: string, id: string): boolean {
  const record = readUpload(dir, id)
  if(!record) return false

  unlinkSync(recordPath(dir, id))
  const file = uploadFilePath(dir, record)
  if(existsSync(file)) unlinkSync(file)
  return true
}

export function deleteUploadDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
