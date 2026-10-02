# codex-lb multi-subscription routing

Thor follows the `katalon-internal/thor` codex-lb topology:

```text
browser -> ingress :8080 -> Vouch/admin-email gate -> codex-lb :2455
opencode -------------------------------> codex-lb :2455 -> mitmproxy -> ChatGPT
```

codex-lb owns the ChatGPT OAuth credentials, account pool, quota state, and routing decisions. OpenCode uses its built-in `openai` Responses provider and never stores the subscription OAuth tokens.

## Network exposure

- The office-facing dashboard is `http://<thor-host>:8080/dashboard` (or the deployment's HTTPS ingress URL).
- Ingress protects codex-lb dashboard routes with Vouch and `THOR_ADMIN_EMAILS`.
- Direct host ports remain loopback-only:
  - `127.0.0.1:2455` — dashboard and proxy API;
  - `127.0.0.1:1455` — OAuth callback listener.
- OpenCode reaches `http://codex-lb:2455/v1` over the private Compose network.

Port 8080 is Thor ingress, not a direct `2455:2455` publication. This preserves the existing SSO gate while making the dashboard reachable from the office. Restrict the ingress host with the deployment firewall/VPN as appropriate.

For an office hostname, set `VOUCH_CALLBACK_URL` and `VOUCH_COOKIE_DOMAIN` to
that deployment and use HTTPS at the outer ingress/load balancer. The Compose
nginx listener itself is plain HTTP. Keep `THOR_ADMIN_EMAILS` restricted to the
operators allowed to manage subscription credentials.

The OAuth provider normally redirects the browser to `localhost:1455`. For a browser running away from the Docker host, `localhost` means the office workstation, not Thor. Use codex-lb's manual callback flow, or deliberately tunnel local port 1455 to the Docker host.

## Runtime configuration

The checked-in Compose configuration:

- pins codex-lb v1.24.0 by tag and OCI digest;
- persists `/var/lib/codex-lb` in the `codex-lb-data` volume;
- sends codex-lb HTTP/WebSocket egress through Thor's mitmproxy and mounts its public CA;
- disables codex-lb's own dashboard login because Vouch owns browser authentication at ingress;
- permits unauthenticated proxy calls from private Docker CIDRs, using the non-secret `codex-lb-local` OpenCode placeholder key;
- disables the HTTP Responses session bridge to avoid cross-call stream mixing;
- refreshes model capabilities from the onboarded accounts so newly introduced
  ChatGPT plan identifiers are routed using their actual upstream catalog.
- restricts OpenCode's picker to Luna, Sol, and Terra, with Luna pinned for title generation so OpenCode does not auto-select an unsupported small model.

`CODEX_LB_DASHBOARD_AUTH_MODE=disabled` means the direct dashboard API has no application login. Only the ingress route provides browser authentication. Do not publish port 2455 on `0.0.0.0`, and do not treat Docker-network membership as an authorization boundary.

## First-time setup

Start the stack:

```bash
./scripts/mitmproxy-ca-init.sh
docker compose up --build -d
curl --fail http://localhost:8080/health
```

Open:

```text
http://<thor-host>:8080/dashboard
```

Authenticate with Google. The email must appear in `THOR_ADMIN_EMAILS`. Add each ChatGPT subscription from the codex-lb Accounts page, using a separate browser profile when account cookies would otherwise select the same identity.

A Codex CLI `~/.codex/auth.json` can also be imported from the dashboard. OpenCode's `.openai`-shaped `auth.json` is not an accepted codex-lb v1.24.0 import format. Never commit an exported auth file.

No `CODEX_LB_API_KEY` or `CODEX_LB_BASE_URL` deployment variable is required in this topology. Compose supplies the fixed private-network values to OpenCode.

## Remove direct OpenCode credentials

After codex-lb has at least one working account, stop OpenCode and back up its state:

```bash
docker compose stop runner opencode
cp -a docker-volumes/opencode \
  "docker-volumes/opencode.backup.$(date +%Y%m%d%H%M%S)"
```

If `docker-volumes/opencode/auth.json` exists, remove only the direct OpenAI entry:

```bash
jq 'del(.openai)' docker-volumes/opencode/auth.json \
  > docker-volumes/opencode/auth.json.tmp
mv docker-volumes/opencode/auth.json.tmp docker-volumes/opencode/auth.json
chmod 600 docker-volumes/opencode/auth.json

docker compose up -d opencode runner
```

Start fresh Thor conversations after switching. Existing sessions can contain account-bound continuation state.

## Routing behavior

Configure routing strategy, account pauses, quotas, and eligibility in the dashboard. Fresh conversations can select another healthy subscription. Continuations involving `previous_response_id`, encrypted reasoning, files, or other upstream state can have hard account affinity and may fail closed when the owning subscription is unavailable.

For a deterministic pool check, temporarily select round-robin routing, create several fresh Thor sessions, and confirm in codex-lb request logs that multiple accounts are selected:

```bash
docker compose logs -f codex-lb
```

## Verification

Confirm direct service readiness and ingress authentication:

```bash
curl --fail http://localhost:2455/health/ready
curl -I http://localhost:8080/dashboard
```

An unauthenticated ingress request should redirect to Vouch. After signing in as an admin, `/dashboard`, `/accounts`, `/settings`, and codex-lb's selected `/api/*` namespaces should load. OpenCode API paths such as `/api/session` must continue routing to OpenCode.

Run the model-backed smoke only after accounts are available:

```bash
pnpm test:opencode-e2e
```

Core E2E has no codex-lb account pool. Its workflow removes the provider override and uses the existing non-production OpenCode auth fixture for the optional LLM smoke; deterministic ingress checks still exercise the codex-lb route configuration.

## OAuth troubleshooting

If the dashboard reports only **Authorization failed — An internal error
occurred**, inspect the codex-lb log for the exception type without sharing the
pasted callback URL or OAuth code:

```bash
docker logs --since 10m \
  "$(docker ps --filter label=com.docker.compose.service=codex-lb --format '{{.ID}}' | head -n1)" \
  2>&1 | grep -E 'manual OAuth callback failed|OAuth token request failed|certificate|SSL'
```

`ClientConnectorCertificateError`, `SSLCertVerificationError`, or another CA
verification error usually means the existing mitmproxy CA predates codex-lb's
strict Python/OpenSSL requirements. Regenerate it with the updated script:

```bash
docker compose stop runner opencode codex-lb mitmproxy
rm -f \
  docker-volumes/mitmproxy/mitmproxy-ca-key.pem \
  docker-volumes/mitmproxy/mitmproxy-ca-cert.pem \
  docker-volumes/mitmproxy/public/mitmproxy-ca.pem
./scripts/mitmproxy-ca-init.sh
docker compose up -d mitmproxy codex-lb opencode runner
```

Regenerating the CA invalidates any host trust store that imported the old
certificate. Re-import the new public CA where applicable. Start a new Add
Account flow after restart; do not reuse a callback URL or authorization code
from a failed flow.

## Backup and upgrades

The `codex-lb-data` volume contains the SQLite database, encryption key, account identities, OAuth tokens, API configuration, and request metadata. A complete volume copy can decrypt the stored credentials because the default encryption key is colocated with the database. Treat backups as secrets.

```bash
docker compose stop runner opencode codex-lb
VOLUME_NAME="$(docker volume ls \
  --filter label=com.docker.compose.volume=codex-lb-data \
  --format '{{.Name}}' | head -n1)"
test -n "$VOLUME_NAME"
docker run --rm \
  -v "$VOLUME_NAME":/source:ro \
  -v "$PWD/backups":/backup \
  alpine sh -c 'cd /source && tar czf /backup/codex-lb-data.tgz .'
docker compose up -d codex-lb opencode runner
```

Before upgrading, drain Thor triggers, stop consumers, back up the volume, review codex-lb release notes, and update both the image tag and digest. Database migrations run at startup. Do not run an older image against migrated state; restore the matching pre-upgrade backup first.
