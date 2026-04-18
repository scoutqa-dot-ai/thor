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
# Restrict file creation to owner-only so the CA private key is never
# world-readable between `openssl` creating it and the later `chmod 600`.
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CA_DIR="${SCRIPT_DIR}/../docker-volumes/mitmproxy-ca"
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ -f "$CA_DIR/key.pem" ] && [ "$FORCE" = "false" ]; then
  echo "CA already exists at $CA_DIR."
  # Apply correct permissions idempotently (safe upgrade path from older script versions).
  chmod 600 "$CA_DIR/key.pem" 2>/dev/null || true
  chmod 644 "$CA_DIR/cert.pem" 2>/dev/null || true
  [ -f "$CA_DIR/public/cert.pem" ] && chmod 644 "$CA_DIR/public/cert.pem" 2>/dev/null || true
  echo "Run with --force to overwrite (rotation). Existing containers must be restarted after rotation."
  exit 0
fi

mkdir -p "$CA_DIR"

echo "Generating mitmproxy CA …"

# 3650 days = 10 years; rotate with: ./scripts/mitmproxy-ca-init.sh --force
openssl req -x509 \
  -newkey rsa:4096 \
  -days 3650 \
  -nodes \
  -keyout "$CA_DIR/key.pem" \
  -out    "$CA_DIR/cert.pem" \
  -subj   "/CN=Thor mitmproxy CA/O=Thor/C=US"

# public/ contains only the cert — this is the only subdirectory mounted into
# opencode. key.pem never leaves the parent directory.
mkdir -p "$CA_DIR/public"
cp "$CA_DIR/cert.pem" "$CA_DIR/public/cert.pem"

chmod 600 "$CA_DIR/key.pem"
chmod 644 "$CA_DIR/cert.pem" "$CA_DIR/public/cert.pem"

echo ""
echo "CA written to $CA_DIR:"
echo "  cert.pem         — public cert  (also at public/cert.pem)"
echo "  key.pem          — private key  (chmod 600; only the mitmproxy container reads it)"
echo "  public/cert.pem  — public cert  (mounted read-only into opencode)"
echo ""
echo "Next steps:"
echo "  docker compose up -d mitmproxy"
