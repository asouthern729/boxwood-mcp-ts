export const AGENCY_TIMEZONE = "America/Chicago"

// Every afw_* timestamp column is Postgres `timestamp without time zone` — AMS360 is legacy
// on-prem desktop software with no timezone concept, so these are agency-local wall-clock values
// exactly as staff typed them. `synced_at` is the one exception: it's populated by our own sync
// process using a real UTC clock, not sourced from AMS360.
//
// ASSUMPTION, not yet empirically verified against real production data (only synthetic seed data
// was available when this was written — see project memory): AMS360-sourced columns are reinterpreted
// as agency-local (no arithmetic shift), not treated as true UTC instants. Reinterpreting is also the
// only choice that doesn't risk shifting date-only fields (poleffdate, polexpdate, dob — all stored
// at midnight) onto the wrong calendar day, which a genuine UTC->Central conversion would do for any
// negative offset. If this assumption is ever confirmed wrong, only formatSourceTimestamp needs to
// change to call convertUtcInstantToLocal instead.
const TRUE_UTC_COLUMNS = new Set(["synced_at"])

export function formatTimestampColumn(date: Date, column: string): string {
  return TRUE_UTC_COLUMNS.has(column)
    ? convertUtcInstantToLocal(date)
    : reinterpretAsLocal(date)
}

function reinterpretAsLocal(date: Date): string {
  const y = date.getUTCFullYear()
  const mo = pad(date.getUTCMonth() + 1)
  const d = pad(date.getUTCDate())
  const h = pad(date.getUTCHours())
  const mi = pad(date.getUTCMinutes())
  const s = pad(date.getUTCSeconds())
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0")

  return `${ y }-${ mo }-${ d }T${ h }:${ mi }:${ s }.${ ms }${ offsetSuffixFor(date) }`
}

function convertUtcInstantToLocal(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AGENCY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date)

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00"
  const hour = get("hour") === "24" ? "00" : get("hour")
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0")

  return `${ get("year") }-${ get("month") }-${ get("day") }T${ hour }:${ get("minute") }:${ get("second") }.${ ms }${ offsetSuffixFor(date) }`
}

// Computes AGENCY_TIMEZONE's UTC offset (handles CST/CDT) for the given instant.
function offsetSuffixFor(date: Date): string {
  const tzName = new Intl.DateTimeFormat("en-US", {
    timeZone: AGENCY_TIMEZONE,
    timeZoneName: "shortOffset"
  }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "GMT+0"

  const match = tzName.match(/GMT([+-]\d+)(?::(\d+))?/)
  const hours = match ? Number(match[1]) : 0
  const minutes = match?.[2] ? Number(match[2]) : 0
  const sign = hours < 0 ? "-" : "+"

  return `${ sign }${ pad(Math.abs(hours)) }:${ pad(minutes) }`
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

// Inverse of reinterpretAsLocal: given a real instant, or explicit local wall-clock fields,
// produce a Date whose UTC digits equal the desired agency-local wall-clock digits — the form
// node-postgres needs to bind correctly against a naive (local-wall-clock) timestamp column.
// download_report's overnight window needs this: binding a true UTC instant directly against
// these columns (what activity_feed's since/until does today) is a known ~5-6 hour boundary bug
// (see the activity skill) — for a feature specifically about "overnight," that's worth avoiding.
export function agencyWallClockParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AGENCY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date)

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0")
  const hour = get("hour") === 24 ? 0 : get("hour")

  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute"), second: get("second") }
}

export function bindableAgencyDate(parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number }): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0))
}

// The most recent occurrence of a given agency-local hour (yesterday's, if that hour hasn't
// happened yet today) — download_report's default "since 8am agency-local" window edge.
export function mostRecentAgencyHour(hour: number): Date {
  const nowParts = agencyWallClockParts(new Date())
  const candidate = bindableAgencyDate({ ...nowParts, hour, minute: 0, second: 0 })

  if(candidate.getTime() > bindableAgencyDate(nowParts).getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() - 1)
  }

  return candidate
}

// The Boxwood ETL sync (~/scripts/ams360-etl) pulls fresh AMS360 data starting at 7:30am
// agency-local and typically finishes within minutes — the download report script itself doesn't
// fire until 8am, so 8am is the earliest point each day the sync is reliably guaranteed complete.
// "today's download activity" has to mean the full 8am-to-8am span, not a rolling "since 8am
// through whenever this tool happens to run" window. download_report's default window is this
// fixed, firm 24h span (most recent 8am back to the 8am before that) rather than anchoring its
// upper bound to `now`, so the same "today" query returns the same window no matter what time of
// day it's run.
export const SYNC_CUTOFF_HOUR = 8

export function mostRecentAgencySyncWindow(): { since: Date; until: Date } {
  const until = mostRecentAgencyHour(SYNC_CUTOFF_HOUR)
  const since = new Date(until)
  since.setUTCDate(since.getUTCDate() - 1)

  return { since, until }
}
