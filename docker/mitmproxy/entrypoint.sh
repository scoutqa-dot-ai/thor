#!/usr/bin/env sh

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

CONF_DIR="$(mktemp -d)"
trap 'rm -rf "$CONF_DIR"' EXIT

EXTRA_ARGS=""
CA_KEY="/etc/thor/mitmproxy/ca-key.pem"
CA_CERT="/etc/thor/mitmproxy/ca-cert.pem"

if [ -f "$CA_KEY" ] && [ -f "$CA_CERT" ]; then
  cat "$CA_KEY" "$CA_CERT" > "$CONF_DIR/mitmproxy-ca.pem"
  chmod 0600 "$CONF_DIR/mitmproxy-ca.pem"
  EXTRA_ARGS="--set confdir=$CONF_DIR"
fi

exec mitmdump \
  --mode regular@8080 \
  --set block_global=false \
  --set connection_strategy=lazy \
  ${EXTRA_ARGS:+$EXTRA_ARGS} \
  -s "$SCRIPT_DIR/addon.py"
