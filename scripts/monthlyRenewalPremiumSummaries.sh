#!/bin/bash
# Monthly commercial Renewal Premium Summary batch generation.
# Invoked by cron on the 1st of each month at 8am America/Chicago via the same UTC-pair +
# runtime-TZ-check pattern used by dailyMorningDownload.sh (this box's cron doesn't support
# CRON_TZ). Kept as a script rather than a cron one-liner so logging doesn't have to live in a
# fragile cron string.
set -uo pipefail
cd /home/andrew/apps/boxwood-mcp-ts

mkdir -p scripts/logs

{
  echo "===== $(date -Iseconds) ====="
  npx tsx scripts/monthlyRenewalPremiumSummaries.ts
} >> scripts/logs/monthly-renewal-premium-summaries.log 2>&1
