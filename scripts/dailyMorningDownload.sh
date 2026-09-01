#!/bin/bash
# Daily Boxwood morning-download report generation + email delivery.
# Invoked by cron; see crontab -l (fires at 8am America/Chicago via the same UTC-pair +
# runtime-TZ-check pattern used by ~/scripts/ams360-etl/run_daily_sync.sh, since this box's cron
# doesn't support CRON_TZ). Kept as a script rather than a cron one-liner so logging doesn't have
# to live in a fragile cron string.
set -uo pipefail
cd /home/andrew/apps/boxwood-mcp-ts

mkdir -p scripts/logs

{
  echo "===== $(date -Iseconds) ====="
  npx tsx scripts/morningDownload.ts && npx tsx scripts/sendReportEmail.ts andrew@tyneside.io
} >> scripts/logs/morning-download.log 2>&1
