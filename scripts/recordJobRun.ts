// Records one cron run for its tool page's "last automatic run" line (src/utils/jobStatus.ts).
// Called by finish_job in scripts/cronJob.sh:
//   npx tsx scripts/recordJobRun.ts <job> <started at, ISO> <exit code>
import "dotenv/config"
import { isJobId, recordJobRun } from "../src/utils/jobStatus.js"

const [job, startedAt, exitCode] = process.argv.slice(2)

try {
  if(!job || !isJobId(job)) throw new Error(`unknown job "${ job }"`)
  const started = new Date(startedAt)
  if(Number.isNaN(started.getTime())) throw new Error(`bad start time "${ startedAt }"`)
  recordJobRun(job, started, Number(exitCode))
  console.log(`[recordJobRun] recorded ${ job } (exit ${ exitCode })`)
} catch(error) {
  console.error(`[recordJobRun] couldn't record the run: ${ (error as Error).message }`)
  process.exit(1)
}
