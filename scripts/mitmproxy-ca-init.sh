#!/usr/bin/env bash
# Generate the mitmproxy CA certificate and key into ./docker-volumes/mitmproxy-ca/.
#
# Run once before the first `docker compose up`. Idempotent — refuses to
# overwrite existing files unless --force is passed.
#
# Usage:
#   ./scripts/mitmproxy-ca-init.sh           # first-time setup
#   ./scripts/mitmproxy-ca-init.sh --force   # rotation: overwrite existing CA
#
# After rotation, restart mitmproxy and opencode:
#   docker compose up -d --force-recreate mitmproxy opencode

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CA_DIR="${SCRIPT_DIR}/../docker-volumes/mitmproxy-ca"
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ -f "$CA_DIR/mitmproxy-ca.pem" ] && [ "$FORCE" = "false" ]; then
  echo "CA already exists at $CA_DIR."
  echo "Run with --force to overwrite (rotation). Existing containers must be restarted after rotation."
  exit 0
fi

mkdir -p "$CA_DIR"

echo "Generating mitmproxy CA …"

openssl req -x509 \
  -newkey rsa:4096 \
  -days 3650 \
  -nodes \
  -keyout "$CA_DIR/key.pem" \
  -out    "$CA_DIR/cert.pem" \
  -subj   "/CN=Thor mitmproxy CA/O=Thor/C=US"

# mitmproxy expects cert+key concatenated in its confdir as mitmproxy-ca.pem
cat "$CA_DIR/cert.pem" "$CA_DIR/key.pem" > "$CA_DIR/mitmproxy-ca.pem"

chmod 600 "$CA_DIR/key.pem" "$CA_DIR/mitmproxy-ca.pem"
chmod 644 "$CA_DIR/cert.pem"

echo ""
echo "CA written to $CA_DIR:"
echo "  cert.pem         — public cert  (mounted into opencode for OS trust)"
echo "  key.pem          — private key  (mounted into mitmproxy for signing)"
echo "  mitmproxy-ca.pem — cert + key   (mitmproxy confdir format)"
echo ""
echo "Next steps:"
echo "  docker compose up -d mitmproxy"
