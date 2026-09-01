// afw_policytransaction.source='D' rows are exactly AMS360's overnight carrier-download feed —
// confirmed against real data: every 'D' row's description is DNLD/-prefixed, vs. plain text for
// 'I' (manually entered) and 'T' (bulk transfer) rows on the same trantype. This table maps that
// population's trantype codes to a plain-language category, sampled from 14 days of live 'D'
// transactions (RWQ/RWL/PCH/XLC/REW/REI/RIX/NBS/PAB/SYN cover 100% of rows seen).
//
// `flagged` mirrors download_report's redefinition of "needs review": AMS360's own [WARNING]/
// GROUP REJECT flags come from its live download-processing log, which isn't replicated into any
// table this MCP can query (no reject/warning field exists on afw_policytransaction, afw_claim,
// or afw_transaction — checked isposted/isuploaded and searched commenttran for "reject", nothing
// resembling AMS360's GROUP REJECT concept turned up). So flagging is redefined structurally: any
// category where a client could plausibly have requested something is flagged for an accuracy
// check; carrier-driven renewals/audits, which no one asked for, are routine.
export type DownloadCategory = {
  category: string
  flagged: boolean
  nextStep: string
}

const CATEGORIES: Record<string, DownloadCategory> = {
  RWQ: { category: "Renewal quote", flagged: false, nextStep: "Review the renewal quote for accuracy/pricing before it binds." },
  RWL: { category: "Renew policy", flagged: false, nextStep: "Routine renewal — spot-check the dec page against expiring coverage; no action needed if it matches." },
  PCH: { category: "Policy change", flagged: true, nextStep: "Review the endorsement for accuracy; confirm it matches what the client requested." },
  XLC: { category: "Cancellation confirmation", flagged: true, nextStep: "Confirm this cancellation was expected; contact the carrier if not." },
  REW: { category: "Rewrite", flagged: true, nextStep: "Review the rewrite for accuracy; confirm terms match what was quoted or requested." },
  REI: { category: "Reinstatement", flagged: true, nextStep: "Confirm the reinstatement matches what was requested and that coverage is back in force as expected." },
  RIX: { category: "Reissue", flagged: true, nextStep: "Review the reissued policy for accuracy against the original." },
  NBS: { category: "New business", flagged: true, nextStep: "Review the new business issuance for accuracy against the application or quote." },
  PAB: { category: "Premium audit", flagged: false, nextStep: "Review the audit result; confirm the premium adjustment is expected." },
  // Low-confidence: never seen in the one real morning file reviewed so far. Defaulted to
  // routine/unflagged on the assumption it's a backend sync artifact, not a client-facing event —
  // revisit once a real download_report run surfaces some and a human can confirm what they are.
  SYN: { category: "Policy synchronization", flagged: false, nextStep: "No client-facing action expected — routine backend sync." }
}

// An unrecognized trantype is exactly the kind of thing that should get human eyes, not silently
// vanish from the report — flagged rather than assumed routine.
export function categorizeTransaction(trantype: string): DownloadCategory {
  return CATEGORIES[trantype] ?? {
    category: `Unrecognized transaction (${ trantype })`,
    flagged: true,
    nextStep: "Unrecognized download transaction type — pull up in AMS360 to see what this is."
  }
}

// Real claimstatus values seen include "Closed", "Closed and hold", "Closed, no claim", "Closed
// without payment", "Declined", "Open", "Open, hold for submission", "Open, pending subrogation",
// "Open, in Litigation", "Re-opened" — matched by prefix/exact rather than a fixed set so new
// carrier-specific status text still resolves sensibly instead of falling through to "open."
export function claimNextStep(claimstatus: string | null): string {
  const status = claimstatus?.toLowerCase() ?? ""
  const isSettled = status.startsWith("closed") || status === "declined"

  return isSettled
    ? "No action required — claim is closed. FYI only, unless client has follow-up questions."
    : "Open claim — confirm client is aware and follow up on status if it's been open a while."
}
