import { createDocArchive } from "./docArchive.js"
import type { DocArchiveEntry } from "./docArchive.js"

// scripts/output/pl-renewal-summary/ — same manifest/file conventions as the CL renewal summary
// archive (see docArchive.ts), its own directory so the personal and commercial index pages stay
// independent.
const plRenewalSummaryArchive = createDocArchive("pl-renewal-summary")

export type PlRenewalSummaryManifestEntry = DocArchiveEntry

export const PL_RENEWAL_SUMMARY_OUTPUT_DIR = plRenewalSummaryArchive.outputDir
export const readPlRenewalSummaryManifest = plRenewalSummaryArchive.readManifest
export const archivePlRenewalSummary = plRenewalSummaryArchive.archive
export const deletePlRenewalSummary = plRenewalSummaryArchive.remove
