#!/usr/bin/env bash

set -euo pipefail

OUT_DIR="${1:-docker-volumes/mitmproxy}"

mkdir -p "$OUT_DIR"

CA_KEY="$OUT_DIR/mitmproxy-ca-key.pem"
CA_CERT="$OUT_DIR/mitmproxy-ca-cert.pem"
CA_BUNDLE="$OUT_DIR/mitmproxy-ca.pem"

if [[ -f "$CA_BUNDLE" && -f "$CA_CERT" && -f "$CA_KEY" ]]; then
  echo "mitmproxy CA already exists in $OUT_DIR"
  exit 0
fi

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -sha256 \
  -days 3650 \
  -nodes \
  -subj "/CN=thor-mitmproxy-ca" \
  -keyout "$CA_KEY" \
  -out "$CA_CERT"

cp "$CA_CERT" "$CA_BUNDLE"

chmod 0600 "$CA_KEY"
chmod 0644 "$CA_CERT" "$CA_BUNDLE"

echo "Generated mitmproxy CA files in $OUT_DIR"
