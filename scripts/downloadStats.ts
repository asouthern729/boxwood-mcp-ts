// Download counts from the log src/utils/downloadLog.ts keeps (<STATE_ROOT>/downloads/*.jsonl):
//   npx tsx scripts/downloadStats.ts [--by file|user|tool|day] [--since 2026-10-01] [--tool risk-profile] [--file <substring>]
// Default --by file. Logging started 2026-10-24; earlier downloads are only in nginx's access log (14 days).
import "dotenv/config"
import { parseArgs } from "node:util"
import { readDownloads } from "../src/utils/downloadLog.js"
import type { DownloadRecord } from "../src/utils/downloadLog.js"

const { values } = parseArgs({
  options: {
    by: { type: "string", default: "file" },
    since: { type: "string" },
    tool: { type: "string" },
    file: { type: "string" }
  }
})

const keyOf: Record<string, (r: DownloadRecord) => string> = {
  file: (r) => `${ r.tool }  ${ r.filename }`,
  user: (r) => r.name ?? (r.sub ? r.sub : "(chat link, no login)"),
  tool: (r) => r.tool,
  day: (r) => r.at.slice(0, 10)
}

const key = keyOf[values.by!]
if(!key) {
  console.error(`--by must be one of: ${ Object.keys(keyOf).join(", ") }`)
  process.exit(1)
}

const records = readDownloads().filter((r) =>
  (!values.since || r.at >= values.since) &&
  (!values.tool || r.tool === values.tool) &&
  (!values.file || r.filename.toLowerCase().includes(values.file.toLowerCase())))

const counts = new Map<string, { count: number; users: Set<string>; last: string }>()
for(const r of records) {
  const k = key(r)
  const row = counts.get(k) ?? { count: 0, users: new Set(), last: "" }
  row.count++
  row.users.add(r.name ?? r.sub ?? "chat link")
  if(r.at > row.last) row.last = r.at
  counts.set(k, row)
}

const rows = [...counts.entries()].sort((a, b) => values.by === "day" ? a[0].localeCompare(b[0]) : b[1].count - a[1].count)
for(const [k, { count, users, last }] of rows) {
  const who = values.by === "user" ? "" : `  (${ users.size } user${ users.size === 1 ? "" : "s" })`
  console.log(`${ String(count).padStart(5) }  ${ k }${ who }  last ${ last.slice(0, 16).replace("T", " ") } UTC`)
}
console.log(`\n${ records.length } download${ records.length === 1 ? "" : "s" }`)
