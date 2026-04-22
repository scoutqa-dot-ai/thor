#!/usr/bin/env sh

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

CONF_DIR="$(mktemp -d)"
trap 'rm -rf "$CONF_DIR"' EXIT

CA_KEY="/etc/thor/mitmproxy/mitmproxy-ca-key.pem"
CA_CERT="/etc/thor/mitmproxy/mitmproxy-ca-cert.pem"

if [ ! -f "$CA_KEY" ] || [ ! -f "$CA_CERT" ]; then
  echo "FATAL: missing mitmproxy CA files in /etc/thor/mitmproxy" >&2
  echo "Remediation: run ./scripts/mitmproxy-ca-init.sh on the host, then restart the container." >&2
  exit 1
fi

cat "$CA_KEY" "$CA_CERT" > "$CONF_DIR/mitmproxy-ca.pem"
chmod 0600 "$CONF_DIR/mitmproxy-ca.pem"

exec mitmdump \
  --mode regular@8080 \
  --set block_global=false \
  --set connection_strategy=lazy \
  --set confdir="$CONF_DIR" \
  -s "$SCRIPT_DIR/addon.py"
