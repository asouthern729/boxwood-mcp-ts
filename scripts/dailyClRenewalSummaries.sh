#!/bin/bash
# Weekday CL Renewal Summary build for commercial terms entering the rolling 30-day window (each term
# built once, nothing emailed — see scripts/dailyClRenewalSummaries.ts). Invoked by cron at 9:00am
# America/Chicago, after the 8:30 monthly CL jobs and an hour after the 7:30 AMS360 sync (Andrew,
# 2026-10-01), via the same UTC-pair + runtime-TZ-check pattern as dailyMorningDownload.sh (this
# box's cron doesn't support CRON_TZ).
set -uo pipefail
cd /home/andrew/apps/boxwood-mcp-ts

mkdir -p scripts/logs

{
  echo "===== $(date -Iseconds) ====="
  npx tsx scripts/dailyClRenewalSummaries.ts
} >> scripts/logs/daily-cl-renewal-summaries.log 2>&1
