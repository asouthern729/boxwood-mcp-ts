#!/bin/bash
# Weekly commercial Renewal Premium Summary refresh (fills newly-known Renewal / changed Current
# values into already-archived workbooks, only where something actually changed).
# Invoked by cron Sundays at 2:00am America/Chicago (picks up Saturday's 7:30am AMS360 ETL sync) via the same
# UTC-pair + runtime-TZ-check pattern used by dailyMorningDownload.sh (this box's cron doesn't
# support CRON_TZ). Kept as a script rather than a cron one-liner so logging doesn't have to live in
# a fragile cron string.
set -uo pipefail
cd /home/andrew/apps/boxwood-mcp-ts

mkdir -p scripts/logs

{
  echo "===== $(date -Iseconds) ====="
  npx tsx scripts/weeklyRenewalPremiumSummaryRefresh.ts
} >> scripts/logs/weekly-renewal-premium-summary-refresh.log 2>&1
