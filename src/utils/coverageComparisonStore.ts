import type { ComparisonRole } from "./coverageComparisonAnalysis.js"
import { createDocToolStore, type BaseJobEntry, type DocToolAttachment, type DocToolUser } from "./docToolStore.js"

// Storage for the CL Coverage Comparison page (Andrew, 2026-11-22), on the shared upload-and-run
// store (docToolStore.ts) under <OUTPUT_ROOT>/coverage-comparison/.

export type ComparisonUser = DocToolUser
export type ComparisonAttachment = DocToolAttachment<ComparisonRole>

export type ComparisonEntry = BaseJobEntry<ComparisonRole> & {
  // Column labels the staff member gave, if any; otherwise read from the documents.
  requested_labels?: { a?: string; b?: string }
  sets?: { a: string; b: string }
  premium?: { a: number | null; b: number | null; difference: number | null }
  key_points?: number
}

const store = createDocToolStore<ComparisonRole, ComparisonEntry>("coverage-comparison")

export const {
  saveAttachment, getOwnedAttachment, updateAttachment, deleteAttachment, readAttachmentFile,
  writeJob, getJob, listJobs, createJob, finishRunning, saveFindings, readFindings, reportPath, writeReport, reportSize, deleteJob
} = store

export const attachmentSummary = (record: ComparisonAttachment) => store.attachmentSummary(record)
