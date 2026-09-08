#!/usr/bin/env bash
# Credential-free container contract test. Optional args reuse already-built
# remote-cli and opencode images, in that order. No production stack is touched.
set -euo pipefail
cd "$(dirname "$0")/.."

remote_image="${1:-thor-gws-remote-cli:e2e}"
opencode_image="${2:-thor-gws-opencode:e2e}"
if [[ $# -eq 0 ]]; then
  docker build --target remote-cli -t "$remote_image" .
  docker build --target opencode -t "$opencode_image" .
elif [[ $# -ne 2 ]]; then
  echo "Usage: $0 [remote-cli-image opencode-image]" >&2
  exit 2
fi

suffix="$$-$RANDOM"
network="thor-gws-test-$suffix"
remote="thor-gws-remote-$suffix"
client="thor-gws-client-$suffix"
cleanup() {
  status=$?
  if [[ $status -ne 0 ]]; then docker logs "$remote" >&2 || true; fi
  docker rm -f "$client" "$remote" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
# No external network: a fixture/cache mistake must fail, not reach Google.
docker network create --internal "$network" >/dev/null
docker run -d --name "$remote" --network "$network" --network-alias remote-cli \
  -v "$PWD/scripts/fixtures/gws-server.mjs:/opt/gws-server.mjs:ro" \
  --entrypoint node "$remote_image" /opt/gws-server.mjs >/dev/null
ready=false
for _ in {1..30}; do
  if docker exec "$remote" node -e 'fetch("http://127.0.0.1:3004/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo "gws fixture did not become ready" >&2; exit 1; }
docker run --rm --name "$client" --network "$network" \
  -e THOR_REMOTE_CLI_URL=http://remote-cli:3004 \
  -v "$PWD/scripts/fixtures/gws-client.mjs:/opt/gws-client.mjs:ro" \
  --workdir /workspace --entrypoint node "$opencode_image" /opt/gws-client.mjs
