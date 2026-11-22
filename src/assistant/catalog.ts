// The Boxwood Assistant's map of the tools app. It is the only list of pages the assistant may
// link to (as boxwood://tool/<path>), and it says which MCP tool each page's chat can run.
// Paths are the UI routes in boxwood-tools-vite-ts (src/App.tsx) without the leading slash;
// titles and descriptions follow its TeamContainer/utils.ts and pages/Tool/utils.ts.

export type AssistantPage = {
  path: string
  title: string
  team: "Commercial" | "Personal"
  summary: string
  whenToUse: string
  outputs: ("xlsx" | "docx" | "pdf")[]
  schedule?: string
  // MCP tools the page's own chat can run (from the toolNames in src/utils/*Chat.ts).
  mcpCapabilities: string[]
}

export const ASSISTANT_PAGES: AssistantPage[] = [
  {
    path: "commercial",
    title: "Commercial tools",
    team: "Commercial",
    summary: "The Commercial team's home page, with a card for each commercial tool.",
    whenToUse: "Browsing what the commercial tools are.",
    outputs: [],
    mcpCapabilities: []
  },
  {
    path: "commercial/renewal-premium-summary",
    title: "Renewal Premium Spreadsheet",
    team: "Commercial",
    summary: "Builds the renewal premium spreadsheet so account managers can review and adjust it before the renewal conversation.",
    whenToUse: "Comparing expiring vs. renewal premium by line of business for a commercial account.",
    outputs: ["xlsx"],
    schedule: "1st of each month at 8:30 AM CT (built); weekdays at 9:00 AM CT (renewal premiums refreshed from AMS360)",
    mcpCapabilities: ["customer_lookup", "upcoming_renewals", "renewal_premium_spreadsheet", "employee_lookup"]
  },
  {
    path: "commercial/renewal-summary",
    title: "CL Renewal Summary",
    team: "Commercial",
    summary: "Generates a branded pre-renewal review document for a commercial policy, ready to send or walk through with the client.",
    whenToUse: "Preparing the client-facing renewal review document for a commercial account, including renewal quotes.",
    outputs: ["docx", "pdf"],
    schedule: "Weekdays at 9:00 AM CT",
    mcpCapabilities: ["customer_lookup", "upcoming_renewals", "cl_renewal_summary", "employee_lookup"]
  },
  {
    path: "commercial/pre-renewal-risk-profile",
    title: "Pre-Renewal Risk Profile",
    team: "Commercial",
    summary: "Pulls current exposures to prep for a client's pre-renewal meeting, with no premiums or coverages included.",
    whenToUse: "Getting the client to update their exposures (payroll, sales, vehicles, locations) ahead of renewal.",
    outputs: ["docx"],
    schedule: "1st of each month at 8:30 AM CT",
    mcpCapabilities: ["customer_lookup", "upcoming_renewals", "risk_profile", "employee_lookup"]
  },
  {
    path: "commercial/proposal-builder",
    title: "Proposal Builder",
    team: "Commercial",
    summary: "Builds a branded client proposal from carrier quotes and AMS360 proposals dropped into the chat.",
    whenToUse: "Turning carrier quote PDFs into a client-ready proposal for new business or a remarket.",
    outputs: ["docx", "pdf"],
    mcpCapabilities: ["customer_lookup", "proposal_builder"]
  },
  {
    path: "commercial/policy-check",
    title: "Policy Check",
    team: "Commercial",
    summary: "Checks an issued or renewal policy against the quote, binder or expiring policy, line by line, with an AMS360 cross-check. Produces an internal report: every discrepancy by priority on page one, matches included, a premium change schedule, a forms comparison and a draft correction request for the carrier.",
    whenToUse: "An issued policy or renewal has come in from the carrier and the account manager needs to confirm it matches what was quoted/bound or carries forward the expiring term correctly, before it goes to the client.",
    outputs: ["docx", "pdf"],
    mcpCapabilities: ["policy_check", "policy_check_results"]
  },
  {
    path: "commercial/coverage-comparison",
    title: "CL Coverage Comparison",
    team: "Commercial",
    summary: "Compares two sets of commercial quote or policy PDFs (current vs proposed, quote vs quote, expiring vs renewal) into a branded Word document to review with the client: At a Glance, Premium Summary, Key Points to Review, a side-by-side table for each coverage line, and a forms appendix.",
    whenToUse: "Shopping or remarketing a commercial account and showing the client how two carriers' quotes, or their current program and a proposal, differ line by line. Works from uploaded PDFs only; it doesn't read AMS360.",
    outputs: ["docx", "pdf"],
    mcpCapabilities: ["coverage_comparison", "coverage_comparison_results"]
  },
  {
    path: "personal",
    title: "Personal tools",
    team: "Personal",
    summary: "The Personal team's home page, with a card for each personal-lines tool.",
    whenToUse: "Browsing what the personal-lines tools are.",
    outputs: [],
    mcpCapabilities: []
  },
  {
    path: "personal/download-change-report",
    title: "Download Change Report",
    team: "Personal",
    summary: "Reviews the overnight carrier download and flags what changed, so team members can confirm items.",
    whenToUse: "Working the daily carrier download: renewals, endorsements, cancellations and other changes to confirm.",
    outputs: ["xlsx"],
    schedule: "Weekdays at 8:00 AM CT",
    mcpCapabilities: []
  },
  {
    path: "personal/premium-change-tool",
    title: "Premium Change Tool",
    team: "Personal",
    summary: "Checks a policy's premium against the prior term to validate rate changes and flag ones that may need remarketing.",
    whenToUse: "Checking a personal-lines renewal's premium increase and deciding whether to remarket.",
    outputs: ["xlsx"],
    schedule: "Weekdays at 8:30 AM CT",
    mcpCapabilities: ["customer_lookup", "upcoming_renewals", "pl_renewal_premium_change", "employee_lookup"]
  },
  {
    path: "personal/renewal-summary",
    title: "PL Renewal Summary",
    team: "Personal",
    summary: "Puts together a renewal summary for a personal lines account so it's ready to review with the client ahead of renewal.",
    whenToUse: "Preparing the client-facing portfolio summary for a personal-lines renewal.",
    outputs: ["docx", "pdf"],
    schedule: "Weekdays at 9:00 AM CT",
    mcpCapabilities: ["customer_lookup", "upcoming_renewals", "pl_renewal_summary", "employee_lookup"]
  }
]

// MCP tools that no page chat runs (they're only reachable through the Claude.ai connector, which
// not every user has). Deliberately kept out of the prompt: the assistant only talks about what the
// tools app itself offers. Listed here so scripts/checkAssistantCatalog.ts accounts for every tool.
export const NOT_IN_APP_TOOLS: string[] = [
  "policy_query", "invoice_lookup", "claim_lookup", "certificate_lookup", "activity_feed", "book_summary",
  "download_report", "download_report_workbook",
  "board_summary", "board_update_item", "board_comment", "board_create_item", "board_delete_item",
  "board_delete_comment", "board_edit_comment"
]

// What the page-chat tools do, in plain words, for the prompt.
const CAPABILITY_LABELS: Record<string, string> = {
  customer_lookup: "look up customers",
  upcoming_renewals: "list upcoming renewals",
  employee_lookup: "look up employees (producers, CSRs)",
  renewal_premium_spreadsheet: "build or rebuild a renewal premium spreadsheet",
  cl_renewal_summary: "build or rebuild a CL Renewal Summary",
  risk_profile: "build or rebuild a Pre-Renewal Risk Profile",
  proposal_builder: "build a proposal from uploaded quotes",
  pl_renewal_premium_change: "build a premium change calculator for a PL renewal",
  pl_renewal_summary: "build or rebuild a PL Renewal Summary"
}

export const ALLOWED_TOOL_PATHS = new Set(ASSISTANT_PAGES.map((page) => page.path))

export const toolLink = (page: AssistantPage) => `[Open ${ page.title }](boxwood://tool/${ page.path })`

export function renderCatalogForPrompt(): string {
  const pages = ASSISTANT_PAGES.map((page) => {
    const lines = [
      `### ${ page.title } (${ page.team })`,
      `- Link: ${ toolLink(page) }`,
      `- What it does: ${ page.summary }`,
      `- Use it for: ${ page.whenToUse }`
    ]

    if(page.outputs.length) lines.push(`- Produces: ${ page.outputs.join(", ") }`)
    if(page.schedule) lines.push(`- Runs automatically: ${ page.schedule }`)
    if(page.mcpCapabilities.length) {
      lines.push(`- Its chat can: ${ page.mcpCapabilities.map((name) => CAPABILITY_LABELS[name] ?? name).join("; ") }`)
    }

    return lines.join("\n")
  })

  return [
    "## Pages you can link to",
    "These are the only pages that exist. Use each link exactly as written.",
    "",
    pages.join("\n\n")
  ].join("\n")
}

const BOXWOOD_LINK = /boxwood:\/\/tool\/([^)\s\]]+)/g

export function unknownToolPaths(text: string): string[] {
  return [...text.matchAll(BOXWOOD_LINK)].map((match) => match[1]).filter((path) => !ALLOWED_TOOL_PATHS.has(path))
}
