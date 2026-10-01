#!/bin/bash
# Weekday PL builds for renewals on the carrier download (scripts/dailyPlRenewalPremiumChange.ts):
#   dailyPlRenewalJob.sh premium-change   — 8:30am America/Chicago
#   dailyPlRenewalJob.sh renewal-summary  — 9:00am America/Chicago
# Times per Andrew (2026-10-01): after the 7:30 AMS360 sync has had time to finish. Each job keeps its
# own cursor and log. Fired by cron via the same UTC-pair + runtime-TZ-check pattern as
# dailyMorningDownload.sh (this box's cron doesn't support CRON_TZ).
set -uo pipefail
cd /home/andrew/apps/boxwood-mcp-ts

JOB="${1:?usage: dailyPlRenewalJob.sh premium-change|renewal-summary}"
mkdir -p scripts/logs

{
  echo "===== $(date -Iseconds) ====="
  npx tsx scripts/dailyPlRenewalPremiumChange.ts --job="$JOB"
} >> "scripts/logs/pl-${JOB}.log" 2>&1
