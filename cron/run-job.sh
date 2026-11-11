#!/bin/bash
# Runs one scheduled job inside the `jobs` container; supercronic calls it from cron/crontab. Logs go
# to /var/log/boxwood-mcp/<job>/ (a host mount, rotated by /etc/logrotate.d/boxwood-mcp). Every run is
# recorded for its tool page (recordJobRun.ts) and a non-zero exit emails the log tail (sendAlert.ts).
#
#   run-job.sh morning-download | premium-change | renewal-summary | cl-renewal-summaries |
#              renewal-premium-summary-refresh | monthly
set -uo pipefail
cd /app

LOG_ROOT="${LOG_ROOT:-/var/log/boxwood-mcp}"

tsx() {
  node --import tsx "$@"
}

# run <job> <log path under LOG_ROOT> <command...>
run() {
  local job="$1" log="$LOG_ROOT/$2"
  shift 2
  mkdir -p "$(dirname "$log")"
  local started
  started=$(date -Iseconds)
  { echo "===== $started ====="; "$@"; } >> "$log" 2>&1
  local code=$?
  tsx scripts/recordJobRun.ts "$job" "$started" "$code" >> "$log" 2>&1 || true
  if [ "$code" -ne 0 ]; then
    tsx scripts/sendAlert.ts "$job" "$code" "$log" >> "$log" 2>&1 || true
  fi
  return "$code"
}

morning_download() {
  tsx scripts/morningDownload.ts && tsx scripts/sendReportEmail.ts
}

case "${1:-}" in
  morning-download)
    run morning-download morning-download/morning-download.log morning_download ;;
  premium-change|renewal-summary)
    run "pl-$1" "pl-$1/pl-$1.log" tsx scripts/dailyPlRenewalPremiumChange.ts --job="$1" ;;
  cl-renewal-summaries)
    run cl-renewal-summaries cl-renewal-summaries/cl-renewal-summaries.log tsx scripts/dailyClRenewalSummaries.ts ;;
  renewal-premium-summary-refresh)
    run renewal-premium-summary-refresh renewal-premium-summaries/daily-refresh.log tsx scripts/dailyRenewalPremiumSummaryRefresh.ts ;;
  monthly)
    run monthly-renewal-premium-summaries renewal-premium-summaries/monthly.log tsx scripts/monthlyRenewalPremiumSummaries.ts
    code=$?
    run monthly-risk-profiles risk-profiles/monthly-risk-profiles.log tsx scripts/monthlyRiskProfiles.ts
    risk_code=$?
    [ "$code" -ne 0 ] && exit "$code"
    exit "$risk_code" ;;
  *)
    echo "usage: $0 morning-download|premium-change|renewal-summary|cl-renewal-summaries|renewal-premium-summary-refresh|monthly" >&2
    exit 2 ;;
esac
