#!/bin/sh
# Starts multiple proxy instances in a single container.
# Each instance gets its own PORT and PROXY_CONFIG.
#
# Environment:
#   PROXY_INSTANCES — comma-separated list of port:config pairs
#     e.g. "3010:proxy.linear.json,3011:proxy.posthog.json,3012:proxy.slack.json"
#
# All other environment variables (API keys, etc.) are inherited by each instance.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_ENTRY="/app/packages/proxy/dist/index.js"

if [ -z "$PROXY_INSTANCES" ]; then
  echo "ERROR: PROXY_INSTANCES is not set" >&2
  exit 1
fi

PIDS=""

# Forward signals to all child processes
cleanup() {
  for pid in $PIDS; do
    kill "$pid" 2>/dev/null || true
  done
  wait
  exit 0
}
trap cleanup SIGTERM SIGINT

# Start one node process per instance
IFS=','
for instance in $PROXY_INSTANCES; do
  port="${instance%%:*}"
  config="${instance#*:}"

  echo "Starting proxy on port $port with config $config"
  PORT="$port" PROXY_CONFIG="/app/packages/proxy/$config" node "$NODE_ENTRY" &
  PIDS="$PIDS $!"
done

# Wait for any child to exit — if one crashes, bring them all down
wait -n 2>/dev/null || wait
cleanup
