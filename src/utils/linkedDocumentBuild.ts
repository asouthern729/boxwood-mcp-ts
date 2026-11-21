import { formatDate, resolvePolicyTerms, type ResolvedPolicy } from "./clPolicyData.js"
import { existsSync } from "node:fs"
import path from "node:path"
import { CL_RENEWAL_SUMMARY_OUTPUT_DIR, readClRenewalSummaryManifest } from "./clRenewalSummaryArchive.js"
import { archivedPolids, generateClRenewalSummary } from "./clRenewalSummaryGenerate.js"
import { isTermArchived } from "./docArchive.js"
import { documentId, findClRenewalSummary, findSpreadsheet, linksForClRenewalSummary, linksForRenewalPremiumSummary, spreadsheetPolids } from "./documentLinks.js"
import { resolveTargetMonthWindow } from "./monthlyRenewalWindow.js"
import { splitBondOnly } from "./policyLineOfBusiness.js"
import { readManifest as readPremiumManifest } from "./renewalPremiumSummaryArchive.js"
import { NoCommercialPoliciesError, generateRenewalPremiumSummary, renewalMonthOf } from "./renewalPremiumSummaryGenerate.js"

// Builds the missing half of a linked pair from the dashboard (Andrew, 2026-11-21): from a Renewal
// Premium Spreadsheet's preview, its CL Renewal Summary; from a summary's, its spreadsheet. Each uses
// the same build and archive as the scheduled jobs, so what an agent creates here is the document
// the job would have built.
//
// - A summary may be built before the daily job's 30-day window — renewals sometimes come in early.
//   Once archived, the job leaves its terms alone (it only builds terms with no document) and
//   rebuilds it in place as renewal terms land in AMS360, keeping any uploaded quotes.
// - A spreadsheet is built for the summary's renewal month, as the monthly job would; workbooks are
//   per account per month, so this never replaces the account's workbook for another month.
//
// Both return the id of the document to open: the new one, or the existing one when the other side
// is already there (created: false) — a second click, or a document that appeared since the page
// loaded, opens it rather than building a duplicate.

export class LinkedBuildError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message)
  }
}

export type LinkedBuildResult = { id: string; created: boolean }

function chicagoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

// The terms, in the order given, that are still in force — one customer's.
async function liveTerms(polids: string[]): Promise<ResolvedPolicy[]> {
  const found = await resolvePolicyTerms(polids)
  const today = chicagoToday()
  const terms = polids.flatMap((polid) => found.filter((m) => m.polid === polid)).filter((m) => formatDate(m.polexpdate) >= today)
  if(terms.length === 0) throw new LinkedBuildError("None of this document's policy terms are still current in AMS360.", 409)
  if(new Set(terms.map((m) => m.custid)).size !== 1) throw new LinkedBuildError("This document's policies no longer belong to one customer in AMS360.", 409)
  return terms
}

export async function buildClRenewalSummaryForSpreadsheet(spreadsheetId: string): Promise<LinkedBuildResult> {
  const sheet = findSpreadsheet(spreadsheetId)
  if(!sheet) throw new LinkedBuildError("This spreadsheet doesn't exist.", 404)

  const existing = linksForRenewalPremiumSummary(sheet)[0]
  if(existing) return { id: existing.id, created: false }

  const polids = [...spreadsheetPolids(sheet)]
  if(polids.length === 0) {
    throw new LinkedBuildError("This spreadsheet's policy terms haven't been recorded yet. They're filled in by Refresh (weekdays at 9am, or the Refresh button) — refresh it, then try again.", 409)
  }

  const { kept, bonds } = await splitBondOnly(await liveTerms(polids))
  if(kept.length === 0) throw new LinkedBuildError(`Only bonds are left on this spreadsheet (${ bonds.map((b) => b.polno.trim()).join(", ") }), and bonds have no Renewal Summary.`, 409)

  // Terms that already have a summary are left to it (the daily job's own rule); with all of them
  // covered, the link would already have been found above unless the document landed just now.
  const manifest = readClRenewalSummaryManifest()
  const uncovered = kept.filter((m) => !isTermArchived(manifest, { polid: m.polid, polno: m.polno, renewalDate: formatDate(m.polexpdate) }))
  if(uncovered.length === 0) {
    // Only one still on disk — the index page lists no other, so it's the only one the page can open.
    const covering = manifest.find((entry) => existsSync(path.join(CL_RENEWAL_SUMMARY_OUTPUT_DIR, entry.filename))
      && archivedPolids(entry)?.some((polid) => kept.some((m) => m.polid === polid)))
    if(covering) return { id: documentId("cl-renewal-summary", covering.filename), created: false }
    throw new LinkedBuildError("These policy terms already have a Renewal Summary.", 409)
  }

  const result = await generateClRenewalSummary(uncovered, uncovered[0].customer_name?.trim() || "[NOT PROVIDED — PLEASE CONFIRM]")
  return { id: documentId("cl-renewal-summary", result.archiveFilename), created: true }
}

export async function buildSpreadsheetForClRenewalSummary(summaryId: string): Promise<LinkedBuildResult> {
  const summary = findClRenewalSummary(summaryId)
  if(!summary) throw new LinkedBuildError("This renewal summary doesn't exist.", 404)

  const existing = linksForClRenewalSummary(summary)[0]
  if(existing) return { id: existing.id, created: false }

  const polids = archivedPolids(summary)
  if(!polids) throw new LinkedBuildError("This renewal summary predates recording its policy terms — rebuild it from the chat, then try again.", 409)
  const terms = await liveTerms(polids)
  const custid = terms[0].custid

  // The summary's renewal month (its soonest term), built the way the monthly job builds a month.
  const month = renewalMonthOf(summary.renewal_date)
  const sameMonth = readPremiumManifest().find((entry) => entry.custid === custid && renewalMonthOf(entry.renewal_date) === month)
  if(sameMonth) {
    throw new LinkedBuildError("This account already has a Renewal Premium Spreadsheet for this renewal month, but it doesn't share these policy terms yet. Refresh it so its terms are recorded.", 409)
  }

  const { startDate, renewalWithinDays } = resolveTargetMonthWindow(month)
  try {
    const result = await generateRenewalPremiumSummary({ custid, renewalWithinDays, windowStartDate: startDate })
    if(result.status !== "generated") throw new LinkedBuildError(`No policies on this account renew in ${ month } any more.`, 409)
    return { id: documentId("renewal-premium-summary", result.archiveFilename), created: true }
  } catch(error) {
    if(error instanceof NoCommercialPoliciesError) throw new LinkedBuildError(error.message, 409)
    throw error
  }
}
