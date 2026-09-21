import { query } from "@anthropic-ai/claude-agent-sdk"
import { createServer } from "../mcpServer.js"
import { logger } from "./logger.js"

// Same reasoning as boardChat.ts/scripts/morningDownload.ts: force API-key auth (never an ambient
// OAuth session) and fail fast if it's missing, since this is what actually authenticates every call.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

if(!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY must be set (see .env.example) for the renewal premium summary chat feature")
}

// customer_lookup is included alongside the tools this chat is actually for, purely so a CSR
// can give Claude a client name instead of having to already know/paste a custid UUID — it's
// read-only and scoped no wider than resolving that one identifier. upcoming_renewals lets this
// chat also answer book-wide "what's renewing soon" questions (e.g. "give me a commercial client
// renewing in 30 days") before optionally drilling into one account via renewal_premium_summary.
// employee_lookup is included just as narrowly: resolving a rep's name to their empcode so it can
// be passed as upcoming_renewals' producer_code/csr_code filter (e.g. "Patrick's renewals in
// December") — not for browsing employees or pulling their customers/claims/invoices includes.
// Deliberately nothing else (no policy_query/claims/activity/board tools): this chat's job is
// finding renewal candidates and building a Renewal Premium Summary, not general book browsing.
const RENEWAL_PREMIUM_SUMMARY_TOOL_NAMES = [
  "mcp__boxwood__customer_lookup",
  "mcp__boxwood__upcoming_renewals",
  "mcp__boxwood__renewal_premium_summary",
  "mcp__boxwood__employee_lookup"
]

const SYSTEM_PROMPT = `You are the assistant embedded on Boxwood's "CL Renewal Premium Summary" tool page. Your job is helping an account manager or CSR find commercial accounts renewing soon and build Patrick's "Commercial Renewal Premium Summary" workbook for one of them.

You have exactly four tools: customer_lookup (resolve a client's name to their custid), upcoming_renewals (find what's renewing soon across the book — use book_type: "commercial" unless asked about personal lines, which this workbook doesn't apply to), renewal_premium_summary (build the workbook for one account, once you have its custid), and employee_lookup (resolve a rep's name to their empcode). Use customer_lookup first when the person gives you a client name instead of a custid. When the person names a producer or CSR instead of a client (e.g. "give me Patrick's customers renewing in December"), use employee_lookup to resolve that name to an empcode, then pass it as upcoming_renewals' producer_code or csr_code filter — don't use employee_lookup's customers/claims/invoices includes or browse employees generally, it's only here for that one name-to-code lookup. You have no access to anything else in this system — no policy_query/claims/activity/board data, no other tool.

When someone asks you to browse/list what's renewing over a date range or window (rather than name one specific account), call upcoming_renewals normally first — its default excludes accounts that have already renewed, and that's the list to lead with, since this workbook is for policies still being shopped at renewal. Then call upcoming_renewals again for the exact same window with include_already_renewed: true, and compare the two result sets. If the second call includes any accounts the first one didn't (i.e. accounts that already renewed), end your reply with a short note naming them — e.g. "Note: Acme Corp and Beta LLC already renewed for this period and were excluded above." — so nothing vanishes invisibly, but the main list stays focused on what still needs a renewal review.

If a name matches more than one customer, list the candidates and ask which one they mean rather than guessing. Once you have a custid, call renewal_premium_summary with sensible defaults (renewal_within_days=90 unless they say otherwise) and report back the download link and a brief summary of what's in it. There's no email delivery — the download link (or the site's index page) is the only way to get the workbook.

Keep replies brief and conversational — this is a small chat panel, not a report.`

export type RenewalPremiumSummaryChatTurn = {
  reply: string
  sessionId: string
  toolCalls: { name: string, input: unknown }[]
}

export async function runRenewalPremiumSummaryChatTurn(message: string, resumeSessionId: string | undefined): Promise<RenewalPremiumSummaryChatTurn> {
  const server = createServer()

  const result = query({
    prompt: message,
    options: {
      model: "claude-sonnet-5",
      mcpServers: { boxwood: { type: "sdk", name: "boxwood", instance: server } },
      // `tools` actually restricts the toolset (unlike `allowedTools`, which only pre-approves
      // without narrowing it) — both together mean this chat only ever has the 2 tools above.
      tools: RENEWAL_PREMIUM_SUMMARY_TOOL_NAMES,
      allowedTools: RENEWAL_PREMIUM_SUMMARY_TOOL_NAMES,
      // Isolates this from the project's own accumulated .claude/settings.json permissions (see
      // boardChat.ts's comment on the same option) — only `tools`/`allowedTools` above govern what
      // this run can touch.
      settingSources: [],
      permissionMode: "default",
      maxTurns: 20,
      systemPrompt: SYSTEM_PROMPT,
      resume: resumeSessionId,
      env: { ...process.env, ANTHROPIC_API_KEY }
    }
  })

  let sessionId: string | undefined
  let reply = ""
  const toolCalls: { name: string, input: unknown }[] = []

  for await (const msg of result) {
    sessionId = msg.session_id

    if(msg.type === "assistant") {
      for(const block of msg.message.content) {
        if(block.type === "text") {
          reply += block.text
        } else if(block.type === "tool_use") {
          toolCalls.push({ name: block.name, input: block.input })
        }
      }
    } else if(msg.type === "result" && msg.subtype !== "success") {
      logger.warn({ subtype: msg.subtype }, "[renewal_premium_summary_chat] turn ended without a clean success result")
    }
  }

  if(!sessionId) {
    throw new Error("renewal premium summary chat turn produced no messages")
  }

  return { reply: reply.trim(), sessionId, toolCalls }
}
