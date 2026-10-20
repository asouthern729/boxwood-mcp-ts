# Sourced by the cron wrappers (scripts/*.sh). After a job's run:
#   notify_failure <job> <exit code> <log file>
# emails the failure (scripts/sendAlert.ts) when the exit code isn't 0. The alert's own outcome is
# appended to the same log, and a failed alert never changes the job's exit code.
notify_failure() {
  local job="$1" code="$2" log="$3"
  [ "$code" -eq 0 ] && return 0
  npx tsx scripts/sendAlert.ts "$job" "$code" "$log" >> "$log" 2>&1 || true
}
