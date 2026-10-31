// One-off (2026-10-20): fills in each cron job's last run from its log, for jobs that ran before run
// recording existed (src/utils/jobStatus.ts) — otherwise their tool pages say "No automatic run
// recorded yet" until each next runs (Nov 1 for the monthly ones). Only writes a job with no status
// file yet, so it never overwrites a real recorded run.
//
// Each log section starts "===== <ISO start time> =====" (the cron wrappers write it). Exit codes
// were never logged, so a run's outcome is read from its own output: its "done —" / "sent" line and
// failure lines. Finish times weren't logged either; a backfilled run's finished_at is its start.
//
//   npx tsx scripts/backfillJobStatus.ts [--dry-run]
import "dotenv/config"
import { existsSync, readFileSync } from "node:fs"
import { JOBS, nameList, writeBackfilledRun, type JobId } from "../src/utils/jobStatus.js"

const LOG_ROOT = process.env.LOG_ROOT || "/var/log/boxwood-mcp"

type Outcome = { ok: boolean; summary: string | null }
type Section = { startedAt: Date; text: string }

const plural = (n: number, one: string, many: string) => `${ n } ${ n === 1 ? one : many }`
const failedPart = (names: string[], count = names.length) => (count > 0 ? [`${ count } failed${ names.length > 0 ? `: ${ nameList(names) }` : "" }`] : [])
const all = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1])
const monthName = (iso: string) => new Date(`${ iso }T12:00:00`).toLocaleString("en-US", { month: "long", year: "numeric" })

function monthly(noun: [string, string], tag: string) {
  return (text: string): Outcome => {
    const done = text.match(/done — generated (\d+), skipped \d+, failed (\d+)/)
    if(!done) return { ok: false, summary: null }
    const month = text.match(/target month (\d{4}-\d{2}-\d{2})/)?.[1]
    const names = all(text, new RegExp(`\\[${ tag }\\] FAILED custid=\\S+ \\(([^)]+)\\)`, "g"))
    return {
      ok: Number(done[2]) === 0,
      summary: [`Built ${ plural(Number(done[1]), ...noun) }${ month ? ` for ${ monthName(month) } renewals` : "" }`, ...failedPart(names, Number(done[2]))].join("; ")
    }
  }
}

const READERS: Record<JobId, { log: string; read: (text: string) => Outcome }> = {
  "morning-download": {
    log: "morning-download/morning-download.log",
    read: (text) => {
      const counts = text.match(/(\d+) rep\(s\), (\d+) item\(s\), (\d+) flagged/)
      const ok = text.includes("[sendReportEmail] sent")
      return { ok, summary: ok && counts ? `Report built: ${ counts[2] } items for ${ counts[1] } reps, ${ counts[3] } flagged for review` : null }
    }
  },
  "cl-renewal-summaries": {
    log: "cl-renewal-summaries/cl-renewal-summaries.log",
    read: (text) => {
      const done = text.match(/done — generated (\d+), rebuilt (\d+), .*failed (\d+)/)
      if(!done) return { ok: false, summary: null }
      const names = [...all(text, /FAILED custid=\S* \(([^)]+)\)/g), ...all(text, /FAILED rebuild (.+?) \(/g)]
      const generated = Number(done[1])
      return {
        ok: Number(done[3]) === 0,
        summary: [`Built ${ generated } new ${ generated === 1 ? "summary" : "summaries" }, rebuilt ${ done[2] }`, ...failedPart(names, Number(done[3]))].join("; ")
      }
    }
  },
  "pl-premium-change": {
    log: "pl-premium-change/pl-premium-change.log",
    read: (text) => {
      const groups = text.match(/(\d+) client renewal\(s\)/)
      const failed = /\] failed:|fatal/.test(text)
      if(!groups || failed) return { ok: false, summary: null }
      const archived = (text.match(/^ {2}archived /gm) ?? []).length
      return { ok: true, summary: `Built ${ plural(archived, "workbook", "workbooks") } from ${ plural(Number(groups[1]), "renewal download", "renewal downloads") }` }
    }
  },
  "pl-renewal-summary": {
    log: "pl-renewal-summary/pl-renewal-summary.log",
    read: (text) => {
      const groups = text.match(/(\d+) client renewal\(s\)/)
      if(!groups || /\] failed:|fatal/.test(text)) return { ok: false, summary: null }
      const built = (text.match(/^ {2}renewal summary (?!not built|FAILED)\S/gm) ?? []).length
      const names = all(text, /renewal summary FAILED for (.+?):/g)
      return {
        ok: names.length === 0,
        summary: [`Built ${ plural(built, "summary", "summaries") } from ${ plural(Number(groups[1]), "renewal download", "renewal downloads") }`, ...failedPart(names)].join("; ")
      }
    }
  },
  "renewal-premium-summary-refresh": {
    log: "renewal-premium-summaries/daily-refresh.log",
    read: (text) => {
      const done = text.match(/done — updated (\d+), unchanged (\d+), past renewal \d+, not refreshable \d+, failed (\d+)/)
      if(!done) return { ok: false, summary: null }
      const [updated, unchanged, failed] = [Number(done[1]), Number(done[2]), Number(done[3])]
      const total = updated + unchanged + failed
      return {
        ok: failed === 0,
        summary: [`Updated ${ updated } of ${ total } upcoming ${ total === 1 ? "spreadsheet" : "spreadsheets" }`, ...failedPart([], failed)].join("; ")
      }
    }
  },
  "monthly-renewal-premium-summaries": { log: "renewal-premium-summaries/monthly.log", read: monthly(["spreadsheet", "spreadsheets"], "monthlyRenewalPremiumSummaries") },
  "monthly-risk-profiles": { log: "risk-profiles/monthly-risk-profiles.log", read: monthly(["Pre-Renewal Review", "Pre-Renewal Reviews"], "monthlyRiskProfiles") }
}

function sections(log: string): Section[] {
  const parts = log.split(/^===== (\S+) =====$/m)
  const out: Section[] = []
  for(let i = 1; i < parts.length; i += 2) {
    const startedAt = new Date(parts[i])
    if(!Number.isNaN(startedAt.getTime())) out.push({ startedAt, text: parts[i + 1] ?? "" })
  }
  return out
}

const dryRun = process.argv.includes("--dry-run")

for(const job of Object.keys(JOBS) as JobId[]) {
  const { log, read } = READERS[job]
  const path = `${ LOG_ROOT }/${ log }`
  if(!existsSync(path)) {
    console.log(`${ job }: no log at ${ path } — skipped`)
    continue
  }

  const runs = sections(readFileSync(path, "utf8"))
  const last = runs.at(-1)
  if(!last) {
    console.log(`${ job }: no runs in its log — skipped`)
    continue
  }

  const outcome = read(last.text)
  const lastOk = [...runs].reverse().find((r) => read(r.text).ok)
  const result = writeBackfilledRun(job, {
    started_at: last.startedAt.toISOString(),
    finished_at: last.startedAt.toISOString(),
    ok: outcome.ok,
    summary: outcome.summary
  }, lastOk?.startedAt.toISOString() ?? null, { dryRun })

  console.log(`${ job }: ${ result } — last run ${ last.startedAt.toISOString() } ${ outcome.ok ? "ok" : "FAILED" }: ${ outcome.summary ?? "(no summary)" }; last success ${ lastOk?.startedAt.toISOString() ?? "none" }`)
}
