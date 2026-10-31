#!/bin/bash
# Monthly commercial Renewal Premium Summary batch generation.
# Invoked by cron on the 1st of each month at 8:30am America/Chicago (30 min after the AMS360 sync
# should have finished; Andrew, 2026-10-01) via the same UTC-pair +
# runtime-TZ-check pattern used by dailyMorningDownload.sh (this box's cron doesn't support
# CRON_TZ). Kept as a script rather than a cron one-liner so logging doesn't have to live in a
# fragile cron string.
set -uo pipefail
cd /home/andrew/apps/boxwood-mcp-ts
source scripts/cronJob.sh

LOG_ROOT="${LOG_ROOT:-/var/log/boxwood-mcp}"
mkdir -p "$LOG_ROOT/renewal-premium-summaries" "$LOG_ROOT/risk-profiles"

STARTED_AT=$(date -Iseconds)
{
  echo "===== $(date -Iseconds) ====="
  npx tsx scripts/monthlyRenewalPremiumSummaries.ts
} >> "$LOG_ROOT/renewal-premium-summaries/monthly.log" 2>&1
CODE=$?
finish_job monthly-renewal-premium-summaries "$STARTED_AT" "$CODE" "$LOG_ROOT/renewal-premium-summaries/monthly.log"

# Companion job, same schedule (Patrick, 2026-09-15): the CL Pre-Renewal Review (risk_profile) for
# the same target month. Runs from this script rather than its own cron line so the two can never
# drift apart; its own log keeps the two runs readable.
STARTED_AT=$(date -Iseconds)
{
  echo "===== $(date -Iseconds) ====="
  npx tsx scripts/monthlyRiskProfiles.ts
} >> "$LOG_ROOT/risk-profiles/monthly-risk-profiles.log" 2>&1
RISK_CODE=$?
finish_job monthly-risk-profiles "$STARTED_AT" "$RISK_CODE" "$LOG_ROOT/risk-profiles/monthly-risk-profiles.log"
[ "$CODE" -ne 0 ] && exit "$CODE"
exit "$RISK_CODE"
