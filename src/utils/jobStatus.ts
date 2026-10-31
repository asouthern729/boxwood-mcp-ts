import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { stateDir } from "../config/config.js"

// Last-run status of each scheduled cron job, for the "last automatic run" line on its tool page
// (Andrew, 2026-10-20: kept with each tool's page rather than on the AMS360 Sync dashboard).
//
// Two files per job under <STATE_ROOT>/jobs/:
//   <job>.summary.json — one line the job script writes about what it did (recordJobSummary)
//   <job>.json         — the run itself, written by the cron wrapper when the run ends
//                        (scripts/recordJobRun.ts via finish_job in scripts/cronJob.sh), which
//                        picks up the summary only if it was written during that run.
// The wrapper, not the job, records the run so a job that crashes before writing anything still
// shows up as failed.

type Schedule = { days: "weekdays" | "first-of-month"; hour: number; minute: number }

// Mirrors the crontab (times America/Chicago). Change both together.
export const JOBS = {
  "morning-download": { label: "Morning Download Report", schedule: { days: "weekdays", hour: 8, minute: 0 } },
  "pl-premium-change": { label: "PL Renewal Premium Change", schedule: { days: "weekdays", hour: 8, minute: 30 } },
  "pl-renewal-summary": { label: "PL Renewal Summaries", schedule: { days: "weekdays", hour: 9, minute: 0 } },
  "cl-renewal-summaries": { label: "CL Renewal Summaries", schedule: { days: "weekdays", hour: 9, minute: 0 } },
  "renewal-premium-summary-refresh": { label: "Renewal Premium Spreadsheet refresh", schedule: { days: "weekdays", hour: 9, minute: 0 } },
  "monthly-renewal-premium-summaries": { label: "Monthly Renewal Premium Spreadsheets", schedule: { days: "first-of-month", hour: 8, minute: 30 } },
  "monthly-risk-profiles": { label: "Monthly Pre-Renewal Reviews", schedule: { days: "first-of-month", hour: 8, minute: 30 } }
} as const satisfies Record<string, { label: string; schedule: Schedule }>

export type JobId = keyof typeof JOBS

export const isJobId = (value: string): value is JobId => Object.hasOwn(JOBS, value)

type JobRun = { started_at: string; finished_at: string; ok: boolean; summary: string | null }
type JobFile = { last_run: JobRun; last_success_at: string | null }

export type JobStatus = {
  job: JobId
  label: string
  schedule: string
  last_run: JobRun | null
  last_success_at: string | null
  overdue: boolean
  expected_at: string | null
  next_run_at: string | null
}

// A run counts as on time if it started at most this long before its scheduled minute (cron fires
// on the minute; the wrapper takes its start time a moment later).
const EARLY_TOLERANCE_MS = 10 * 60_000
// How long after the scheduled time a job can still be running before it reads as overdue.
const OVERDUE_GRACE_MS = 2 * 60 * 60_000

const statusPath = (job: JobId) => stateDir("jobs", `${ job }.json`)
const summaryPath = (job: JobId) => stateDir("jobs", `${ job }.summary.json`)

function readJson<T>(file: string): T | null {
  if(!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return null
  }
}

// Written to a temp file and renamed, so the page never reads a half-written file.
function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${ file }.tmp`
  writeFileSync(tmp, `${ JSON.stringify(value, null, 2) }\n`)
  renameSync(tmp, file)
}

// Called by a job script once it knows what it did. Staff see this line on the tool page, so keep
// it to counts and client names — no ids, paths or stack traces.
export function recordJobSummary(job: JobId, summary: string): void {
  writeJson(summaryPath(job), { summary, at: new Date().toISOString() })
}

export function recordJobRun(job: JobId, startedAt: Date, exitCode: number): void {
  const written = readJson<{ summary: string; at: string }>(summaryPath(job))
  const summary = written && new Date(written.at) >= startedAt ? written.summary : null
  const finishedAt = new Date().toISOString()
  const ok = exitCode === 0
  const previous = readJson<JobFile>(statusPath(job))

  writeJson(statusPath(job), {
    last_run: { started_at: startedAt.toISOString(), finished_at: finishedAt, ok, summary },
    last_success_at: ok ? finishedAt : previous?.last_success_at ?? null
  } satisfies JobFile)
}

// For scripts/backfillJobStatus.ts: a run read back from a job's log, written only when the job has
// no status file yet — a real recorded run always wins.
export function writeBackfilledRun(job: JobId, run: JobRun, lastSuccessAt: string | null, { dryRun = false } = {}): "written" | "would write" | "kept existing" {
  if(existsSync(statusPath(job))) return "kept existing"
  if(dryRun) return "would write"
  writeJson(statusPath(job), { last_run: run, last_success_at: lastSuccessAt } satisfies JobFile)
  return "written"
}

// ---------- Schedule ----------

const CHICAGO = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", hourCycle: "h23",
  year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric"
})

function chicagoParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = Object.fromEntries(CHICAGO.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]))
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second }
}

// The instant a Chicago wall-clock time happens. Two passes settle the offset across a DST change.
function chicagoToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  let guess = wall
  for(let i = 0; i < 2; i++) {
    const p = chicagoParts(new Date(guess))
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess
    guess = wall - offset
  }
  return new Date(guess)
}

function runsOn(schedule: Schedule, year: number, month: number, day: number): boolean {
  if(schedule.days === "first-of-month") return day === 1
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return weekday >= 1 && weekday <= 5
}

// The latest scheduled run that should have finished by now (scheduled time + grace has passed).
export function expectedRun(schedule: Schedule, now: Date): Date | null {
  const today = chicagoParts(now)
  for(let back = 0; back <= 40; back++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day - back))
    const [year, month, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
    if(!runsOn(schedule, year, month, day)) continue
    const at = chicagoToUtc(year, month, day, schedule.hour, schedule.minute)
    if(at.getTime() + OVERDUE_GRACE_MS <= now.getTime()) return at
  }
  return null
}

// The next scheduled run after now.
export function nextRun(schedule: Schedule, now: Date): Date | null {
  const today = chicagoParts(now)
  for(let ahead = 0; ahead <= 40; ahead++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead))
    const [year, month, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
    if(!runsOn(schedule, year, month, day)) continue
    const at = chicagoToUtc(year, month, day, schedule.hour, schedule.minute)
    if(at.getTime() > now.getTime()) return at
  }
  return null
}

function scheduleLabel(schedule: Schedule): string {
  const hour12 = schedule.hour % 12 || 12
  const time = `${ hour12 }:${ String(schedule.minute).padStart(2, "0") }${ schedule.hour < 12 ? "am" : "pm" } CT`
  return schedule.days === "weekdays" ? `Weekdays at ${ time }` : `1st of each month at ${ time }`
}

export function readJobStatus(job: JobId, now = new Date()): JobStatus {
  const { label, schedule } = JOBS[job]
  const file = readJson<JobFile>(statusPath(job))
  const expected = expectedRun(schedule, now)
  const lastStart = file ? new Date(file.last_run.started_at).getTime() : null
  // No file yet (a job not run since this was deployed) reads as "no run recorded", not overdue;
  // a job that stops running after that is caught.
  const overdue = expected !== null && lastStart !== null && lastStart < expected.getTime() - EARLY_TOLERANCE_MS

  return {
    job,
    label,
    schedule: scheduleLabel(schedule),
    last_run: file?.last_run ?? null,
    last_success_at: file?.last_success_at ?? null,
    overdue,
    expected_at: expected?.toISOString() ?? null,
    next_run_at: nextRun(schedule, now)?.toISOString() ?? null
  }
}

// "Smith Co, Jones LLC and 3 more" — for a summary line's failure list.
export function nameList(names: string[], max = 3): string {
  const shown = names.slice(0, max)
  const more = names.length - shown.length
  return more > 0 ? `${ shown.join(", ") } and ${ more } more` : shown.join(", ")
}
