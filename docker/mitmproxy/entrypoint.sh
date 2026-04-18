#!/bin/sh
set -e

CA_FILE="/etc/thor/mitmproxy/mitmproxy-ca.pem"

if [ ! -f "$CA_FILE" ] || [ ! -s "$CA_FILE" ]; then
  echo "FATAL: mitmproxy CA not found or empty at $CA_FILE" >&2
  echo "Remediation: run ./scripts/mitmproxy-ca-init.sh on the host, then restart the container." >&2
  exit 1
fi

exec mitmdump \
  -s /etc/mitmproxy/addon.py \
  --mode regular@8080 \
  --set confdir=/etc/thor/mitmproxy \
  --set termlog_verbosity=info \
  "$@"
