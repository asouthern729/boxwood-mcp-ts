#!/bin/bash
# Weekday commercial Renewal Premium Summary refresh (fills newly-known Renewal / changed Current
# values into already-archived workbooks, only where something actually changed).
# Invoked by cron M–F at 9:00am America/Chicago, alongside dailyClRenewalSummaries.sh and 90 min after
# the 7:30am AMS360 ETL sync (Andrew, 2026-10-08; was Sundays 2am), via the same UTC-pair +
# runtime-TZ-check pattern used by dailyMorningDownload.sh (this box's cron doesn't support CRON_TZ).
# Kept as a script rather than a cron one-liner so logging doesn't have to live in a fragile cron string.
set -uo pipefail
cd /home/andrew/apps/boxwood-mcp-ts

mkdir -p scripts/logs

{
  echo "===== $(date -Iseconds) ====="
  npx tsx scripts/dailyRenewalPremiumSummaryRefresh.ts
} >> scripts/logs/daily-renewal-premium-summary-refresh.log 2>&1
