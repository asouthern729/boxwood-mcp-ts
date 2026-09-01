// Unattended morning-download automation: drives download_report -> accuracy judgment ->
// download_report_workbook end to end via the Claude Agent SDK, then writes the resulting .xlsx
// to scripts/output/. Runs its own in-process McpServer instance (createServer()) — no subprocess,
// no HTTP, no Auth0 — since this script always runs on the same machine as the deployed server, and
// reads the generated file straight out of its own in-process downloadStore rather than fetching
// the public download link download_report_workbook returns (see the comment above
// findDownloadToken for why that link isn't fetchable from here). Email delivery is separate, later
// work; this script's job ends at "file on disk."
//
// Usage: npx tsx scripts/morningDownload.ts [since] [until]
//   since/until are optional and passed through verbatim to download_report's own since/until
//   format (relative shorthand like "24h", or an agency-local timestamp) — omit both to use
//   download_report's own default window (5pm agency-local yesterday through now).

import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { createServer } from "../src/mcpServer.js"
import { getDownload } from "../src/utils/downloadStore.js"

const OUTPUT_DIR = path.join(import.meta.dirname, "output")

const [since, until] = process.argv.slice(2)

const windowInstruction = since || until
  ? `Use since=${ JSON.stringify(since ?? "(omit)") } and until=${ JSON.stringify(until ?? "(omit)") } when calling download_report.`
  : "Call download_report with no since/until args, so it uses its own default overnight window."

const PROMPT = `Run Boxwood's morning download review end to end.

1. Call download_report. ${ windowInstruction }
2. For every item in each rep's flagged_items, read its candidate_prior_activity (the staff
   notes) and decide an accuracy verdict: "matches" (the download lines up with a documented
   client request), "no_match" or "rejected" (it doesn't, or nothing documented explains it), or
   "verify" (plausible but not confidently confirmed). Base every verdict strictly on what the
   notes actually say — if candidate_prior_activity is empty or doesn't clearly support a
   confident call, use "verify" rather than guessing. Write a one-to-two sentence note citing what
   you found (or didn't).
3. Call download_report_workbook, passing the exact report_token download_report returned, and a
   verdicts array with one {item_id, accuracy} entry for every flagged item you judged.
4. Reply with nothing but a one-line confirmation of what you built (rep count, item count,
   flagged count) — no other commentary.`

// Both download_report (the JSON report link) and download_report_workbook (the finished .xlsx)
// return a plain https://mcp.boxwoodins.com/downloads/<uuid> link (see src/routes/downloads.ts)
// rather than embedding their payload — but that URL points at the *deployed* pm2 server. This
// script's createServer() below is a separate in-process McpServer in this script's own Node
// process, with its own separate downloadStore module state, so fetching that public URL would hit
// the deployed server's store instead and 404 (it never saw this token). Since this script runs in
// the same process that generated the token, it reads the file straight out of its own in-process
// downloadStore instead — only the token (the URL's last path segment) needs extracting, searched
// generically across every message since the agent's reply text is the likely place but not
// guaranteed to be the only one.
const DOWNLOAD_TOKEN_PATTERN = /\/downloads\/([0-9a-fA-F-]{36})/

function findDownloadToken(value: unknown): string | undefined {
  if(typeof value === "string") return value.match(DOWNLOAD_TOKEN_PATTERN)?.[1]
  if(value === null || typeof value !== "object") return undefined

  if(Array.isArray(value)) {
    for(const item of value) {
      const found = findDownloadToken(item)
      if(found) return found
    }
    return undefined
  }

  for(const key of Object.keys(value as Record<string, unknown>)) {
    const found = findDownloadToken((value as Record<string, unknown>)[key])
    if(found) return found
  }

  return undefined
}

async function main() {
  const server = createServer()

  const result = query({
    prompt: PROMPT,
    options: {
      model: "claude-sonnet-5",
      mcpServers: { boxwood: { type: "sdk", name: "boxwood", instance: server } },
      // `tools` restricts the actual toolset (unlike `allowedTools`, which only pre-approves
      // without removing anything else) — without this the agent still has its full normal Claude
      // Code toolset (Bash, Write, ...) and, when a tool result is too large to fit in context,
      // will improvise shelling out to inspect/filter a dumped file rather than failing cleanly.
      // `allowedTools` is still required alongside it — `tools` alone restricts availability but
      // doesn't pre-approve, so under permissionMode "default" it stops to ask for permission on
      // the only tools it has, with nobody there to answer.
      tools: ["mcp__boxwood__download_report", "mcp__boxwood__download_report_workbook"],
      allowedTools: ["mcp__boxwood__download_report", "mcp__boxwood__download_report_workbook"],
      // Without this, query() still loads this project's .claude/settings.json (and user/local
      // settings) the way the interactive CLI does — and this project's settings.json has
      // accumulated permissions.allow entries from past interactive sessions (mcp__postgres-mcp__*,
      // including run_write_query; a couple of mcp__claude_ai_Boxwood_MCP__* tools) that silently
      // pre-approve those tools here too, regardless of `tools`/`allowedTools` above. Confirmed live:
      // a run that hit an oversized download_report result queried Postgres directly via
      // mcp__postgres-mcp__run_query to route around it — completely bypassing the MCP layer this
      // server exists to enforce. `settingSources: []` is the SDK's documented isolation mode for
      // exactly this — no filesystem settings load, so only `tools`/`allowedTools` above govern what
      // this run can touch.
      settingSources: [],
      permissionMode: "default",
      maxTurns: 20
    }
  })

  let token: string | undefined
  let succeeded = false

  // download_report's own response now also contains a /downloads/<uuid> link (the JSON report,
  // not the workbook) — and, observed live, the agent doesn't reliably stop calling download_report
  // once it's already built the workbook (it keeps exploring narrower sub-windows after finishing).
  // So a generic "take whichever link appeared most recently" scan is unsafe — a later, unrelated
  // download_report call would win and this script would save that JSON as if it were the .xlsx.
  // Instead, track which tool_use_id belongs to the download_report_workbook call and only ever
  // pull a token out of *that* call's own tool_result.
  const workbookToolUseIds = new Set<string>()

  for await (const message of result) {
    if(message.type === "assistant") {
      for(const block of message.message.content) {
        if(block.type === "tool_use") {
          const inputSize = JSON.stringify(block.input).length
          console.log(`[morningDownload] tool_use: ${ block.name } (input ${ inputSize } chars)`)
          if(block.name.endsWith("download_report_workbook")) workbookToolUseIds.add(block.id)
        } else if(block.type === "text") {
          console.log(`[morningDownload] assistant text: ${ block.text.slice(0, 200) }`)
        }
      }
    } else if(message.type === "user" && !message.isSynthetic) {
      const content = message.message.content
      if(Array.isArray(content)) {
        for(const block of content) {
          if(block.type === "tool_result") {
            const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content)
            console.log(`[morningDownload] tool_result (error=${ !!block.is_error }): ${ text?.slice(0, 300) }`)

            if(!block.is_error && workbookToolUseIds.has(block.tool_use_id)) {
              const found = findDownloadToken(block.content)
              if(found) token = found
            }
          }
        }
      }
    }

    if(message.type === "result") {
      succeeded = message.subtype === "success"
      console.log(`[morningDownload] agent run finished: ${ message.subtype }`)
    }
  }

  if(!token) {
    console.error("[morningDownload] no download link found in the agent's output — nothing written")
    process.exit(1)
  }

  const entry = getDownload(token)
  if(!entry) {
    console.error(`[morningDownload] token ${ token } not found in this process's download store (unexpected — should be the same process that created it)`)
    process.exit(1)
  }

  // Name the file after the report's own window, not wall-clock "now" — this script runs the tool
  // against a fixed 24h window (its whole point is often backtesting a past day), so "now" would
  // silently collide and overwrite different days' runs made on the same calendar day. workbook's
  // own filename (download_report_workbook's `dateSlug`, derived from window.until) already carries
  // this date, so pull it from there rather than re-deriving it.
  const dateMatch = entry.filename.match(/\d{4}-\d{2}-\d{2}/)
  const dateSlug = dateMatch?.[0] ?? new Date().toISOString().slice(0, 10)

  mkdirSync(OUTPUT_DIR, { recursive: true })
  const outPath = path.join(OUTPUT_DIR, `${ dateSlug }_download_report.xlsx`)
  writeFileSync(outPath, entry.buffer)
  console.log(`[morningDownload] wrote ${ outPath }`)

  process.exit(succeeded ? 0 : 1)
}

main().catch((error) => {
  console.error("[morningDownload] failed:", error)
  process.exit(1)
})
