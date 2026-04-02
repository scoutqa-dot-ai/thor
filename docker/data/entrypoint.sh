#!/bin/sh
# Generate nginx config from DATA_ROUTES env vars, then start nginx.
#
# Format:
#   DATA_ROUTES=billing,analytics      (comma-separated route names)
#   DATA_ROUTE_billing_UPSTREAM=https://billing.example.com/
#   DATA_ROUTE_billing_KEY=sk-xxx
#   DATA_ROUTE_billing_HEADER=X-Custom-Auth   (optional, defaults to X-API-Key)
#   DATA_ROUTE_billing_READONLY=true          (optional, reject non-GET/HEAD)
#
# Each route creates:  /<name>/ → proxy_pass <upstream>
#                      with header <HEADER>: <KEY>
#
# If DATA_ROUTES is empty, falls back to proxying / → httpbin.org

set -e

CONF="/etc/nginx/conf.d/default.conf"

# --- Health endpoint (always present) ---
cat > "$CONF" <<'HEALTH'
map $uri $loggable {
    default 1;
    /health 0;
}

server {
    listen 80;
    access_log /var/log/nginx/access.log combined if=$loggable;

    location /health {
        return 200 '{"status":"ok"}';
        add_header Content-Type application/json;
    }
HEALTH

if [ -z "$DATA_ROUTES" ]; then
  # --- Fallback: proxy everything to httpbin ---
  cat >> "$CONF" <<'FALLBACK'

    # No DATA_ROUTES configured — fallback to httpbin for testing
    location / {
        proxy_pass https://httpbin.org/;
        proxy_http_version 1.1;
        proxy_set_header Host httpbin.org;
        proxy_set_header Connection "";
        proxy_ssl_server_name on;
    }
}
FALLBACK
  echo "data-proxy: no DATA_ROUTES set, falling back to httpbin.org"
else
  # --- Generate a location block per route ---
  IFS=','
  for route in $DATA_ROUTES; do
    # Normalize: trim whitespace
    route=$(echo "$route" | tr -d ' ')
    [ -z "$route" ] && continue

    # Read route-specific env vars
    upstream_var="DATA_ROUTE_${route}_UPSTREAM"
    key_var="DATA_ROUTE_${route}_KEY"
    header_var="DATA_ROUTE_${route}_HEADER"
    readonly_var="DATA_ROUTE_${route}_READONLY"

    upstream=$(printenv "$upstream_var" 2>/dev/null || true)
    key=$(printenv "$key_var" 2>/dev/null || true)
    header=$(printenv "$header_var" 2>/dev/null || true)
    readonly_flag=$(printenv "$readonly_var" 2>/dev/null || true)
    : "${header:=X-API-Key}"

    if [ -z "$upstream" ]; then
      echo "data-proxy: WARNING — $upstream_var not set, skipping route /$route/"
      continue
    fi

    # Extract host from upstream URL for Host header
    host=$(echo "$upstream" | sed -E 's|https?://([^/:]+).*|\1|')

    cat >> "$CONF" <<ROUTE

    location /${route}/ {
        proxy_pass ${upstream};
        proxy_http_version 1.1;
        proxy_set_header Host ${host};
        proxy_set_header Connection "";
        proxy_ssl_server_name on;
ROUTE

    # Restrict to GET/HEAD if readonly flag is set
    if [ "$readonly_flag" = "true" ]; then
      cat >> "$CONF" <<'READONLY'
        limit_except GET HEAD {
            deny all;
        }
READONLY
    fi

    # Only add auth header if a key is provided
    if [ -n "$key" ]; then
      cat >> "$CONF" <<AUTH
        proxy_set_header ${header} "${key}";
AUTH
    fi

    echo "    }" >> "$CONF"
    echo "data-proxy: /${route}/ → ${upstream}"
  done
  unset IFS

  echo "}" >> "$CONF"
fi

echo "data-proxy: config written to $CONF"
exec nginx -g 'daemon off;'
