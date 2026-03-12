#!/bin/sh
set -e

CRONTAB_FILE="${CRONTAB_FILE:-/workspace/cron/crontab}"

if [ -f "$CRONTAB_FILE" ]; then
  crontab "$CRONTAB_FILE"
  echo "Installed crontab from ${CRONTAB_FILE}"
else
  echo "Warning: no crontab file at ${CRONTAB_FILE}, running with empty schedule"
fi

# Run crond in foreground — re-reads crontab on each wake cycle
exec crond -f -l 2
