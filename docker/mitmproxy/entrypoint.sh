#!/bin/sh
# Runs as root. Three jobs, in order:
#   1. Validate CA material and assemble it into a tmpfs confdir (chmod 600).
#   2. Install iptables REDIRECT rules so outbound TCP :80/:443 in the shared
#      netns gets sent to mitmproxy's transparent listener on :8080. opencode
#      joins this netns via network_mode: "service:mitmproxy" in compose, so
#      there is no env-var escape hatch — the kernel redirects all TCP.
#   3. Drop to mitmproxy-svc (uid 1002) via gosu and exec mitmdump. mitmdump's
#      own upstream connections are excluded from REDIRECT by uid-owner match.
set -e
umask 077

CERT="/etc/thor/mitmproxy-ca/cert.pem"
KEY="/etc/thor/mitmproxy-ca/key.pem"
CONFDIR="/run/mitmproxy"
MITM_UID=1002
MITM_PORT=8080

# ── 1. CA material ───────────────────────────────────────────────────────────
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

# ── 2. iptables REDIRECT ─────────────────────────────────────────────────────
# CIDRs come from docker-compose.yml via YAML anchors (x-inside-cidr /
# x-outside-cidr) so the RETURN rules below match Docker's IPAM allocation
# exactly. Fail loud if unset — a default here would silently hide drift.
: "${THOR_INSIDE_CIDR:?must be set by docker-compose.yml (x-inside-cidr anchor)}"
: "${THOR_OUTSIDE_CIDR:?must be set by docker-compose.yml (x-outside-cidr anchor)}"
INSIDE_CIDR="$THOR_INSIDE_CIDR"
OUTSIDE_CIDR="$THOR_OUTSIDE_CIDR"

# Build a fresh THOR_OUT chain atomically so a partial run can't leave us with
# half the rules installed (which would leak in-cluster traffic to mitmproxy).
iptables -t nat -N THOR_OUT 2>/dev/null || iptables -t nat -F THOR_OUT

# mitmdump's own upstream connections MUST bypass REDIRECT or they loop back
# into the proxy and deadlock.
iptables -t nat -A THOR_OUT -m owner --uid-owner "$MITM_UID" -j RETURN
iptables -t nat -A THOR_OUT -d 127.0.0.0/8 -j RETURN
iptables -t nat -A THOR_OUT -d "$INSIDE_CIDR"  -j RETURN
iptables -t nat -A THOR_OUT -d "$OUTSIDE_CIDR" -j RETURN

# Redirect everything else. REDIRECT keeps conntrack in this netns so mitmproxy
# can read SO_ORIGINAL_DST to recover the pre-NAT destination (hostname comes
# from SNI for HTTPS, Host header for HTTP).
iptables -t nat -A THOR_OUT -p tcp --dport 80  -j REDIRECT --to-ports "$MITM_PORT"
iptables -t nat -A THOR_OUT -p tcp --dport 443 -j REDIRECT --to-ports "$MITM_PORT"

# Install the chain once, idempotently.
iptables -t nat -C OUTPUT -j THOR_OUT 2>/dev/null \
  || iptables -t nat -A OUTPUT -j THOR_OUT

# ── 3. mitmdump ──────────────────────────────────────────────────────────────
exec gosu mitmproxy-svc mitmdump \
  -s /etc/mitmproxy/addon.py \
  --mode "transparent@${MITM_PORT}" \
  --set confdir="$CONFDIR" \
  --set termlog_verbosity=info \
  "$@"
