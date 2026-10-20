// Emails a cron job's failure to Andrew (2026-10-20: until then a failed job only wrote its log and
// exited nonzero, and nobody heard about it). Called by notify_failure in scripts/notifyFailure.sh:
//   npx tsx scripts/sendAlert.ts <job> <exit code> <log file>
// The body is that job's latest run, from its last "=====" header to the end of the log, so the
// failure arrives with its own output. ALERT_TO overrides the recipient.
import "dotenv/config"
import { readFileSync } from "node:fs"
import { sendMail } from "../src/utils/mailer.js"

const DEFAULT_RECIPIENT = "andrew@tyneside.io"
const MAX_BODY_CHARS = 12_000

function latestRun(logPath: string): string {
  try {
    const log = readFileSync(logPath, "utf8")
    const run = log.slice(Math.max(log.lastIndexOf("\n====="), 0)).trim()
    return run.length > MAX_BODY_CHARS ? `…\n${ run.slice(-MAX_BODY_CHARS) }` : run
  } catch(error) {
    return `(couldn't read ${ logPath }: ${ (error as Error).message })`
  }
}

async function main() {
  const [job, exitCode, logPath] = process.argv.slice(2)
  if(!job || !exitCode || !logPath) throw new Error("usage: sendAlert.ts <job> <exit code> <log file>")

  await sendMail({
    to: process.env.ALERT_TO || DEFAULT_RECIPIENT,
    subject: `boxwood-mcp ${ job } FAILED (exit ${ exitCode })`,
    text: `${ job } exited with code ${ exitCode } on ${ new Date().toISOString() }.\nLog: ${ logPath }\n\n${ latestRun(logPath) }`
  })
  console.log(`[sendAlert] sent failure alert for ${ job }`)
}

main().catch((error) => {
  console.error(`[sendAlert] couldn't send the alert: ${ (error as Error).message }`)
  process.exit(1)
})
