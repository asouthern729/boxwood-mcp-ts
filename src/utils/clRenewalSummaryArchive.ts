import { createDocArchive } from "./docArchive.js"
import type { DocArchiveEntry } from "./docArchive.js"

// scripts/output/cl-renewal-summary/ — same manifest/file conventions as the risk profile archive
// (see docArchive.ts), its own directory so the two index pages stay independent.
const clRenewalSummaryArchive = createDocArchive("cl-renewal-summary")

export type ClRenewalSummaryManifestEntry = DocArchiveEntry

export const CL_RENEWAL_SUMMARY_OUTPUT_DIR = clRenewalSummaryArchive.outputDir
export const readClRenewalSummaryManifest = clRenewalSummaryArchive.readManifest
export const archiveClRenewalSummary = clRenewalSummaryArchive.archive
export const deleteClRenewalSummary = clRenewalSummaryArchive.remove
