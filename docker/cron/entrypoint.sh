#!/bin/sh
set -e


CRONTAB="/workspace/cron/crontab"

if [ ! -f "$CRONTAB" ]; then
  echo "Warning: no crontab file at ${CRONTAB}, waiting for it to appear..."
  elapsed=0
  while [ ! -f "$CRONTAB" ]; do
    sleep 5
    elapsed=$((elapsed + 5))
    if [ $((elapsed % 30)) -eq 0 ]; then
      echo "Still waiting for ${CRONTAB}... (${elapsed}s elapsed)"
    fi
  done
  echo "Crontab file appeared: ${CRONTAB}"
fi

exec supercronic -inotify "$CRONTAB"
