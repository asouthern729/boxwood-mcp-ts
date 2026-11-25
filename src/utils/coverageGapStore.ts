import type { GapRole } from "./coverageGapAnalysis.js"
import { createDocToolStore, type BaseJobEntry, type DocToolAttachment, type DocToolUser } from "./docToolStore.js"

// Storage for the Coverage Gap page (Andrew, 2026-11-25), on the shared upload-and-run store
// (docToolStore.ts) under <OUTPUT_ROOT>/coverage-gap/. Every upload has the one role "policy".

export type GapUser = DocToolUser
export type GapAttachment = DocToolAttachment<GapRole>

export type GapEntry = BaseJobEntry<GapRole> & {
  policies?: number
  counts?: { gap: number; confirm: number; high: number }
}

const store = createDocToolStore<GapRole, GapEntry>("coverage-gap")

export const {
  saveAttachment, makeReadable, getOwnedAttachment, updateAttachment, deleteAttachment, readAttachmentDoc,
  writeJob, getJob, listJobs, createJob, finishRunning, saveFindings, readFindings, reportPath, writeReport, reportSize, deleteJob
} = store

export const attachmentSummary = (record: GapAttachment) => store.attachmentSummary(record)
