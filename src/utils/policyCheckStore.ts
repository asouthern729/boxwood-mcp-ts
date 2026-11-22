import type { PolicyCheckFindings, PolicyCheckRole } from "./policyCheckAnalysis.js"
import { createDocToolStore, type BaseJobEntry, type DocToolAttachment, type DocToolUser } from "./docToolStore.js"

// Storage for the Policy Check page (Andrew, 2026-11-22), on the shared upload-and-run store
// (docToolStore.ts) under <OUTPUT_ROOT>/policy-check/.

export type PolicyCheckUser = DocToolUser
export type PolicyCheckAttachment = DocToolAttachment<PolicyCheckRole>
export type CheckStatus = "running" | "failed" | "done"

export type CheckEntry = BaseJobEntry<PolicyCheckRole> & {
  mode: PolicyCheckFindings["mode"] | null
  banner?: { level: "red" | "amber" | "green"; text: string }
  counts?: { correction: number; confirm: number; housekeeping: number; match: number }
  premium_change?: { baseline: number | null; compared: number | null; change: number | null; percent: number | null }
}

const store = createDocToolStore<PolicyCheckRole, CheckEntry>("policy-check")

export const POLICY_CHECK_OUTPUT_DIR = store.OUTPUT_DIR
export const {
  saveAttachment, getAttachment, getOwnedAttachment, updateAttachment, deleteAttachment, readAttachmentFile,
  writeJob: writeCheck, getJob: getCheck, listJobs: listChecks, createJob: createCheck, finishRunning,
  saveFindings, readFindings, reportPath, writeReport, reportSize, deleteJob: deleteCheck, isRunning
} = store

export const attachmentSummary = (record: PolicyCheckAttachment) =>
  store.attachmentSummary(record, (profile) => ({ suggested_role: profile.suggested_role }))
