// Emails an already-built download report workbook (from scripts/output/, produced by
// scripts/morningDownload.ts) as an attachment, without re-running the whole Claude Agent SDK flow.
// This is the production sender the daily cron job (see scripts/dailyMorningDownload.sh) calls —
// also handy standalone for an ad hoc resend of a specific day's report.
//
// Usage: npx tsx scripts/sendReportEmail.ts [to] [filePath]
//   to       defaults to andrew@tyneside.io
//   filePath defaults to the most recently modified .xlsx in scripts/output/

import "dotenv/config"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { sendMailWithAttachment } from "../src/utils/mailer.js"

const OUTPUT_DIR = path.join(import.meta.dirname, "output")
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DATE_PATTERN = /\d{4}-\d{2}-\d{2}/

const [toArg, filePathArg] = process.argv.slice(2)
const to = toArg ?? "andrew@tyneside.io"

function findLatestWorkbook(): string {
  const candidates = readdirSync(OUTPUT_DIR)
    .filter((name) => name.endsWith(".xlsx"))
    .map((name) => path.join(OUTPUT_DIR, name))

  if(candidates.length === 0) {
    throw new Error(`No .xlsx files found in ${ OUTPUT_DIR } — run scripts/morningDownload.ts first, or pass a file path explicitly`)
  }

  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

async function main() {
  const filePath = filePathArg ?? findLatestWorkbook()
  const buffer = readFileSync(filePath)
  const filename = path.basename(filePath)
  const dateLabel = filename.match(DATE_PATTERN)?.[0] ?? filename

  console.log(`[sendReportEmail] sending ${ filename } (${ buffer.length } bytes) to ${ to }`)

  await sendMailWithAttachment({
    to,
    subject: `Boxwood Morning Download Action List — ${ dateLabel }`,
    text: "Attached is this morning's Boxwood download report — one Summary tab plus one tab per representative, each as a filterable/sortable Excel table.",
    attachment: { filename, content: buffer, contentType: XLSX_MIME_TYPE }
  })

  console.log("[sendReportEmail] sent")
}

main().catch((error) => {
  console.error("[sendReportEmail] failed:", error)
  process.exit(1)
})
