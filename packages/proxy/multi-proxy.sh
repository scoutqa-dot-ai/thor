#!/bin/bash
# Starts multiple proxy instances in a single container.
# Each instance gets its own PORT and PROXY_CONFIG.
#
# Environment:
#   PROXY_INSTANCES — comma-separated list of port:config pairs
#     e.g. "3010:proxy.linear.json,3011:proxy.posthog.json,3012:proxy.slack.json"
#
# All other environment variables (API keys, etc.) are inherited by each instance.

set -e

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
}
trap cleanup TERM INT

# Start one node process per instance
IFS=','
for instance in $PROXY_INSTANCES; do
  port="${instance%%:*}"
  config="${instance#*:}"

  echo "Starting proxy on port $port with config $config"
  PORT="$port" PROXY_CONFIG="/app/packages/proxy/$config" node "$NODE_ENTRY" &
  PIDS="$PIDS $!"
done

# Wait for any child to exit — if one crashes, bring down the whole container
# so Docker restart policy can recover all instances together.
wait -n
EXIT_CODE=$?
echo "A proxy process exited with code $EXIT_CODE — shutting down all instances"
cleanup
exit "$EXIT_CODE"
