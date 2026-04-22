#!/bin/sh
# Runs as root. Assembles the CA file in a tmpfs confdir, then drops to
# mitmproxy-svc (uid 1002) via gosu so the private key never touches disk
# as a world-readable file.
set -e
umask 077

CERT="/etc/thor/mitmproxy-ca/cert.pem"
KEY="/etc/thor/mitmproxy-ca/key.pem"
CONFDIR="/run/mitmproxy"

for f in "$CERT" "$KEY"; do
  if [ ! -f "$f" ] || [ ! -s "$f" ]; then
    echo "FATAL: $f not found or empty" >&2
    echo "Remediation: run ./scripts/mitmproxy-ca-init.sh on the host, then restart the container." >&2
    exit 1
  fi
done

mkdir -p "$CONFDIR"
chown mitmproxy-svc:mitmproxy-svc "$CONFDIR"
chmod 700 "$CONFDIR"
cat "$CERT" "$KEY" > "$CONFDIR/mitmproxy-ca.pem"
chown mitmproxy-svc:mitmproxy-svc "$CONFDIR/mitmproxy-ca.pem"
chmod 600 "$CONFDIR/mitmproxy-ca.pem"

exec gosu mitmproxy-svc mitmdump \
  -s /etc/mitmproxy/addon.py \
  --mode regular@8080 \
  --set confdir="$CONFDIR" \
  --set termlog_verbosity=info \
  "$@"
