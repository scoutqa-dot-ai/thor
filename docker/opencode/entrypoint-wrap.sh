#!/bin/sh
# Entrypoint wrapper for the opencode container.
# Validates the mitmproxy CA is present, builds a combined CA bundle for
# curl/Python/git (system CAs + mitmproxy CA), then execs the main process.
set -e

CA="/etc/thor/ca/cert.pem"

if [ ! -f "$CA" ] || [ ! -s "$CA" ]; then
  echo "FATAL: mitmproxy CA not found or empty at $CA" >&2
  echo "Remediation: run ./scripts/mitmproxy-ca-init.sh on the host, then restart." >&2
  exit 1
fi

# Build a combined CA bundle: system roots + mitmproxy CA.
# Written to /tmp (world-writable) since the container runs as a non-root user.
# NODE_EXTRA_CA_CERTS is set via compose env and handles Node.js separately.
COMBINED="/tmp/thor-ca-bundle.crt"
if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
  cat /etc/ssl/certs/ca-certificates.crt "$CA" > "$COMBINED"
else
  cp "$CA" "$COMBINED"
fi

export CURL_CA_BUNDLE="$COMBINED"
export SSL_CERT_FILE="$COMBINED"
# Override compose-level values so Python requests and git also trust system CAs
# (passthrough HTTPS hosts use CONNECT tunneling and need real server certs verified)
export REQUESTS_CA_BUNDLE="$COMBINED"
export GIT_SSL_CAINFO="$COMBINED"

exec "$@"
