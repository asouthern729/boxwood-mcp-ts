# Sourced by the cron wrappers (scripts/*.sh). Around each job's run:
#   STARTED_AT=$(date -Iseconds)
#   { ...run the job... } >> "$LOG" 2>&1
#   CODE=$?
#   finish_job <job> "$STARTED_AT" "$CODE" "$LOG"
# finish_job records the run for the job's tool page (scripts/recordJobRun.ts → <STATE_ROOT>/jobs/)
# and, when the exit code isn't 0, emails the failure (scripts/sendAlert.ts). Both append their
# own output to the job's log, and neither changes the job's exit code.

notify_failure() {
  local job="$1" code="$2" log="$3"
  [ "$code" -eq 0 ] && return 0
  npx tsx scripts/sendAlert.ts "$job" "$code" "$log" >> "$log" 2>&1 || true
}

finish_job() {
  local job="$1" started="$2" code="$3" log="$4"
  npx tsx scripts/recordJobRun.ts "$job" "$started" "$code" >> "$log" 2>&1 || true
  notify_failure "$job" "$code" "$log"
}
