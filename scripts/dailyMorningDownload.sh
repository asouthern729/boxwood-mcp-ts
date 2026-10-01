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
  npx tsx scripts/morningDownload.ts && npx tsx scripts/sendReportEmail.ts
  # PL Renewal Premium Change workbooks + PL Renewal Summaries for the renewals on today's download
  # (archived on the server for the dashboard's PL pages; nothing emailed). Independent of the report above.
  npx tsx scripts/dailyPlRenewalPremiumChange.ts
} >> scripts/logs/morning-download.log 2>&1

# CL Renewal Summaries for commercial terms entering the rolling 30-day window (weekdays, with the PL
# jobs above; each term built once, nothing emailed). Its own log — it has nothing to do with the
# download report.
{
  echo "===== $(date -Iseconds) ====="
  npx tsx scripts/dailyClRenewalSummaries.ts
} >> scripts/logs/daily-cl-renewal-summaries.log 2>&1
