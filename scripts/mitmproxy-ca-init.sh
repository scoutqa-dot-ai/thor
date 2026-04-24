#!/usr/bin/env bash

set -euo pipefail

OUT_DIR="${1:-docker-volumes/mitmproxy}"
PUBLIC_DIR="$OUT_DIR/public"

mkdir -p "$OUT_DIR"
mkdir -p "$PUBLIC_DIR"

CA_KEY="$OUT_DIR/mitmproxy-ca-key.pem"
CA_CERT="$OUT_DIR/mitmproxy-ca-cert.pem"
CA_BUNDLE="$PUBLIC_DIR/mitmproxy-ca.pem"

for path in "$CA_KEY" "$CA_CERT" "$CA_BUNDLE"; do
  if [[ -d "$path" ]]; then
    echo "Refusing to write CA file at $path because a directory already exists there." >&2
    echo "Remove the directory and rerun ./scripts/mitmproxy-ca-init.sh." >&2
    exit 1
  fi
done

if [[ -f "$CA_KEY" || -f "$CA_CERT" || -f "$CA_BUNDLE" ]]; then
  if [[ ! -f "$CA_KEY" || ! -f "$CA_CERT" ]]; then
    echo "mitmproxy CA is in a partial state under $OUT_DIR." >&2
    echo "Expected both $CA_KEY and $CA_CERT to exist together." >&2
    exit 1
  fi

  cp "$CA_CERT" "$CA_BUNDLE"
  chmod 0600 "$CA_KEY"
  chmod 0644 "$CA_CERT" "$CA_BUNDLE"
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
