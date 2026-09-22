import { createDocArchive } from "./docArchive.js"
import type { DocArchiveEntry } from "./docArchive.js"

// scripts/output/cl-risk-profile/ — sibling to scripts/output/download-report/, keeping it
// independent of that report's file-naming pattern reports.ts already parses via regex. See
// docArchive.ts for the manifest/file conventions (shared with cl_renewal_summary's archive).
const riskProfileArchive = createDocArchive("cl-risk-profile")

export type RiskProfileManifestEntry = DocArchiveEntry
export { sanitizeForFilename } from "./docArchive.js"

export const RISK_PROFILE_OUTPUT_DIR = riskProfileArchive.outputDir
export const readManifest = riskProfileArchive.readManifest
export const archiveRiskProfile = riskProfileArchive.archive
export const deleteRiskProfile = riskProfileArchive.remove
