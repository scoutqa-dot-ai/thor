#!/usr/bin/env sh

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

CONF_DIR="$(mktemp -d)"
MITMPROXY_PID=""

cleanup() {
  if [ -n "$MITMPROXY_PID" ]; then
    kill "$MITMPROXY_PID" 2>/dev/null || true
    wait "$MITMPROXY_PID" 2>/dev/null || true
  fi
  rm -rf "$CONF_DIR"
}

handle_signal() {
  cleanup
  exit 0
}

trap cleanup EXIT
trap handle_signal INT TERM

CA_KEY="/etc/thor/mitmproxy/mitmproxy-ca-key.pem"
CA_CERT="/etc/thor/mitmproxy/mitmproxy-ca-cert.pem"

if [ ! -f "$CA_KEY" ] || [ ! -f "$CA_CERT" ]; then
  echo "FATAL: missing mitmproxy CA files in /etc/thor/mitmproxy" >&2
  echo "Remediation: run ./scripts/mitmproxy-ca-init.sh on the host, then restart the container." >&2
  exit 1
fi

cat "$CA_KEY" "$CA_CERT" > "$CONF_DIR/mitmproxy-ca.pem"
chmod 0600 "$CONF_DIR/mitmproxy-ca.pem"

mitmdump \
  --mode regular@8080 \
  --set block_global=false \
  --set connection_strategy=lazy \
  --set confdir="$CONF_DIR" \
  -s "$SCRIPT_DIR/addon.py" &
MITMPROXY_PID="$!"

python <<'PY'
import sys
import time
import urllib.request

opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": "http://127.0.0.1:8080"})
)
deadline = time.time() + 10
last_error = "unknown error"

while time.time() < deadline:
    try:
        response = opener.open("http://__health.thor/", timeout=2)
        status = getattr(response, "status", None)
        if status == 200:
            sys.exit(0)
        last_error = f"unexpected status: {status}"
    except Exception as exc:
        last_error = str(exc)
    time.sleep(0.5)

raise SystemExit(f"mitmproxy addon smoke test failed: {last_error}")
PY

wait "$MITMPROXY_PID"
