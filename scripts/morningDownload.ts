// Unattended morning-download automation: drives download_report -> accuracy judgment ->
// download_report_workbook end to end via the Claude Agent SDK, then writes the resulting .xlsx
// to scripts/output/download-report/. Runs its own in-process McpServer instance (createServer()) — no subprocess,
// no HTTP, no Auth0 — since this script always runs on the same machine as the deployed server, and
// reads the generated file straight out of its own in-process downloadStore rather than fetching
// the public download link download_report_workbook returns (see the comment above
// findDownloadToken for why that link isn't fetchable from here). Email delivery is separate, later
// work; this script's job ends at "file on disk."
//
// Usage: npx tsx scripts/morningDownload.ts [since] [until]
//   since/until are optional CLI overrides, passed through verbatim to download_report's own
//   since/until format (relative shorthand like "24h", or an agency-local timestamp) — this is for
//   manual/backtesting runs against a specific past window, and deliberately bypasses the
//   watermark logic below entirely (an explicit override shouldn't perturb the automation's own
//   state).
//
//   With no CLI args (the normal cron path — see dailyMorningDownload.sh), this script instead
//   reads a persisted watermark (src/utils/downloadReportWatermark.ts) and drives download_report's
//   `synced_since` bound from it — see the 2026-09-16/17 vendor-download-gap incident for why a
//   plain entereddate-windowed default isn't enough: a row entered in AMS360 just before one
//   morning's sync, but not actually synced into Postgres until the *next* day, otherwise falls
//   into the gap between two entereddate windows and is never reported at all. The watermark only
//   advances after a run actually succeeds end to end (report generated, file written), so a
//   failed run just makes the next run's lookback wider rather than losing that window's data.

import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { createServer } from "../src/mcpServer.js"
import { readDownloadReportWatermark, writeDownloadReportWatermark } from "../src/utils/downloadReportWatermark.js"
import { getDownload } from "../src/utils/downloadStore.js"

const OUTPUT_DIR = path.join(import.meta.dirname, "output", "download-report")

// This script runs unattended via cron (see scripts/dailyMorningDownload.sh), so it must not
// depend on whatever `claude login` session happens to be active on the box — that's a personal,
// interactive credential that can expire or get logged out from under a scheduled job with nobody
// there to re-auth. Requiring ANTHROPIC_API_KEY here, and passing it explicitly below, forces the
// Claude Agent SDK's subprocess to authenticate as this key rather than silently falling back to
// an ambient OAuth session (ANTHROPIC_API_KEY outranks a logged-in session when both are present,
// but only if it's actually set — hence the fail-fast check).
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

if(!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY must be set (see .env.example) — generate one in the Anthropic Console rather than relying on a logged-in claude session")
}

const [argvSince, argvUntil] = process.argv.slice(2)
const isExplicitOverride = Boolean(argvSince || argvUntil)

// Captured once, up front — used both to size the watermark-driven lookback below and, on success,
// as the new watermark itself (see writeDownloadReportWatermark call near the bottom).
const runStartedAt = new Date()

let since = argvSince
let until = argvUntil
let syncedSince: string | undefined

if(!isExplicitOverride) {
  const watermark = readDownloadReportWatermark()

  if(watermark) {
    // entereddate-side lookback is just a generous sanity/performance bound here, not the
    // correctness mechanism — synced_since (below) is what actually guarantees nothing gets
    // skipped. +1 day of slack on top of the watermark's own age covers a transaction entered in
    // AMS360 shortly before the watermark but not synced until after it (exactly what happened
    // 2026-09-17).
    const lookbackDays = Math.max(1, Math.ceil((runStartedAt.getTime() - watermark.getTime()) / 86_400_000) + 1)
    since = `${ lookbackDays }d`
    syncedSince = watermark.toISOString()
  }
  // No watermark yet (first run ever) — leave since/until/syncedSince all unset, so
  // download_report falls back to its own default (today's fixed entereddate window). The
  // watermark starts accumulating from this run's success onward.
}

const windowInstruction = since || until || syncedSince
  ? `Use since=${ JSON.stringify(since ?? "(omit)") }, until=${ JSON.stringify(until ?? "(omit)") }, and synced_since=${ JSON.stringify(syncedSince ?? "(omit)") } when calling download_report (omit any argument marked "(omit)" entirely rather than passing that literal string).`
  : "Call download_report with no since/until/synced_since args, so it uses its own default overnight window."

const PROMPT = `Run Boxwood's morning download review end to end.

1. Call download_report. ${ windowInstruction }
2. For every item in each rep's flagged_items, read its candidate_prior_activity (the staff
   notes) and decide an accuracy verdict: "matches" (the download lines up with a documented
   client request), "no_match" or "rejected" (it doesn't, or nothing documented explains it), or
   "verify" (plausible but not confidently confirmed). Base every verdict strictly on what the
   notes actually say — if candidate_prior_activity is empty or doesn't clearly support a
   confident call, use "verify" rather than guessing. Write a one-to-two sentence note citing what
   you found (or didn't) — this note is shown to reps verbatim in the finished workbook, so write
   it in plain language a rep would understand, never referencing an item_id or any other internal
   identifier. Cross-referencing another item on this report is still valuable and you should still
   do it whenever it's genuinely true (e.g. noticing the same change is documented on a different
   transaction for this policy) — just identify that other item by its content instead of its
   number (the customer, the policy number, the date, or what it actually says). Don't drop a real
   cross-reference just to avoid an item_id — rephrase it, don't omit it.
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
      maxTurns: 20,
      // `env` REPLACES the subprocess environment rather than merging with it, so process.env is
      // spread through here to keep PATH/HOME/etc — ANTHROPIC_API_KEY is called out explicitly so
      // it's unmistakable that this run authenticates via API key, not a logged-in session.
      env: { ...process.env, ANTHROPIC_API_KEY }
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

  // Only advance the watermark for the normal unattended cron path, and only once the report has
  // actually been built successfully end to end — an explicit CLI override run (backtesting a past
  // window) must never perturb the automation's own state, and a failed run should leave the
  // watermark alone so the next run's lookback naturally widens to cover what was missed instead
  // of silently skipping it.
  if(succeeded && !isExplicitOverride) {
    writeDownloadReportWatermark(runStartedAt)
    console.log(`[morningDownload] advanced watermark to ${ runStartedAt.toISOString() }`)
  }

  process.exit(succeeded ? 0 : 1)
}

main().catch((error) => {
  console.error("[morningDownload] failed:", error)
  process.exit(1)
})
