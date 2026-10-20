#!/bin/bash
# Weekday CL Renewal Summary build for commercial terms entering the rolling 30-day window (each term
# built once, nothing emailed — see scripts/dailyClRenewalSummaries.ts). Invoked by cron at 9:00am
# America/Chicago, after the 8:30 monthly CL jobs and an hour after the 7:30 AMS360 sync (Andrew,
# 2026-10-01), via the same UTC-pair + runtime-TZ-check pattern as dailyMorningDownload.sh (this
# box's cron doesn't support CRON_TZ).
set -uo pipefail
cd /home/andrew/apps/boxwood-mcp-ts
source scripts/notifyFailure.sh

LOG_DIR="${LOG_ROOT:-/var/log/boxwood-mcp}/cl-renewal-summaries"
mkdir -p "$LOG_DIR"

{
  echo "===== $(date -Iseconds) ====="
  npx tsx scripts/dailyClRenewalSummaries.ts
} >> "$LOG_DIR/cl-renewal-summaries.log" 2>&1
CODE=$?
notify_failure cl-renewal-summaries "$CODE" "$LOG_DIR/cl-renewal-summaries.log"
exit "$CODE"
