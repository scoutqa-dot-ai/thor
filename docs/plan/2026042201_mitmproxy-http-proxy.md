# mitmproxy HTTP Proxy — 2026-04-22-01

**Goal**: implement outbound credential injection from scratch as a conventional
explicit HTTP proxy:

```
opencode (curl / node)
  -> HTTP(S)_PROXY
  -> mitmproxy
  -> real upstream URL
```

Primary targets:

- Atlassian works out of the box
- Slack works out of the box
- OpenAI and ChatGPT domains pass through by default
- custom host rules come from `/workspace/config.json`
- supported clients inside opencode are `curl` and built-in Node `fetch`
- the legacy `data` container is removed completely

## Workflow

Implementation follows `AGENTS.md`:

1. implement one phase only
2. self-test against that phase's exit criteria
3. stop for human review
4. after approval, create one focused commit for that phase
5. continue to the next phase

## Motivation

Thor needs a predictable outbound proxy that lets the agent use real upstream
URLs and still receive the right auth headers by destination host.

The design should optimize for:

- simple operator workflow
- clear request path
- compatibility with the actual tools in opencode
- small blast radius when debugging or changing rules

This is an HTTP-layer policy component, not a full network sandbox.

## Scope

**In scope:**

- `mitmdump --mode regular@8080` as an explicit forward proxy
- proxy env vars in `opencode` for `curl` and built-in Node `fetch`
- Node 22 native proxy support so built-in `fetch` honors proxy env vars
  reliably
- per-host or host+path credential injection from `/workspace/config.json#mitmproxy[]`
- optional passthrough host list from `/workspace/config.json#mitmproxy_passthrough[]`
- baked-in Atlassian + Slack default rules
- baked-in OpenAI + ChatGPT passthrough defaults
- deny-by-default behavior for unknown hosts
- CA generation plus explicit CA env wiring for `curl` and Node
- installing `curl` in the `opencode` image
- mounting `/workspace/config.json` read-only into `opencode`
- deleting the existing `data` reverse-proxy container and its config surface
- unit tests for rules, addon behavior, and workspace config schema
- documentation for operator setup and custom rules

**Out of scope:**

- transparent proxying
- shared network namespace
- iptables redirect or firewalling
- claiming mitmproxy is the only possible egress path
- non-HTTP protocols
- per-repo outbound credential scoping
- request or response body logging

## Target shape

### Request flow

1. A tool inside `opencode` calls the real upstream URL.
2. The client reads proxy env vars and connects to `http://mitmproxy:8080`.
3. mitmproxy classifies the destination host and path:
   - inject headers
   - passthrough
   - deny
4. mitmproxy forwards the request to the real upstream.

No fake `http://data/...` URLs. No transparent interception.

### Client support

`opencode` exports both lowercase and uppercase proxy env vars:

- `http_proxy`
- `https_proxy`
- `no_proxy`
- `HTTP_PROXY`
- `HTTPS_PROXY`
- `NO_PROXY`

This is required because different tools honor different spellings.

Covered clients for this plan:

- `curl`
- built-in Node `fetch()`

Not covered by this plan:

### Node support

Use Node 22's native proxy support in the existing `node:22-slim` base image.

Set:

```yaml
NODE_OPTIONS: --use-env-proxy --disable-warning=UNDICI-EHPA
NODE_EXTRA_CA_CERTS: /etc/thor/mitmproxy-public/mitmproxy-ca.pem
```

This keeps built-in Node `fetch()` on real upstream URLs while routing through
the proxy, without printing the experimental `UNDICI-EHPA` warning on every
Node-based proxy call.

### Built-in defaults

The proxy image ships with these default injection rules:

- `api.atlassian.com` -> `Authorization: ${ATLASSIAN_AUTH}` (`readonly: true`)
- `.atlassian.net` -> `Authorization: ${ATLASSIAN_AUTH}` (`readonly: true`)
- `slack.com/api/chat.postMessage` -> `Authorization: Bearer ${SLACK_BOT_TOKEN}`
- `slack.com/api/reactions.add` -> `Authorization: Bearer ${SLACK_BOT_TOKEN}`
- `slack.com/api/conversations.replies` -> `Authorization: Bearer ${SLACK_BOT_TOKEN}`
- `slack.com/api/conversations.history` -> `Authorization: Bearer ${SLACK_BOT_TOKEN}`
- `slack.com/api/files.info` -> `Authorization: Bearer ${SLACK_BOT_TOKEN}`
- `slack.com/api/files.getUploadURLExternal` -> `Authorization: Bearer ${SLACK_BOT_TOKEN}`
- `slack.com/api/files.completeUploadExternal` -> `Authorization: Bearer ${SLACK_BOT_TOKEN}`
- `files.slack.com/upload/v1/...` -> `Authorization: Bearer ${SLACK_BOT_TOKEN}`
- `files.slack.com/files-pri/...` -> `Authorization: Bearer ${SLACK_BOT_TOKEN}` (`readonly: true`)

The proxy image also ships with these default passthrough hosts:

- `api.media.atlassian.com`
- `openai.com`
- `.openai.com`
- `chatgpt.com`
- `.chatgpt.com`

User rules from `config.json#mitmproxy[]` are evaluated first and override
defaults on first match. User passthrough entries are also evaluated before the
built-in passthrough list.

### `config.json`

```json
{
  "repos": {},
  "mitmproxy": [
    {
      "host": "api.example.com",
      "path_prefix": "/v1/",
      "headers": { "Authorization": "${EXAMPLE_API_KEY}" }
    },
    {
      "host_suffix": ".internal.example",
      "headers": { "X-API-Key": "${INTERNAL_API_KEY}" },
      "readonly": true
    }
  ],
  "mitmproxy_passthrough": ["api.openai.com", ".anthropic.com"]
}
```

Rule semantics:

- exactly one of `host` or `host_suffix`
- optional `path_prefix` narrows a rule to one URL prefix on the matched host
- first match wins
- `readonly: true` allows `GET`, `HEAD`, `OPTIONS`
- `${ENV}` interpolation happens at request time
- missing env var returns `502`

Passthrough semantics:

- each entry is either an exact host (`api.openai.com`) or a suffix starting
  with `.` (`.openai.com`)
- user passthrough entries are evaluated before built-in passthrough defaults

### Host policy model

Every outbound request belongs to one of three buckets:

1. `inject` — matching rule found, headers added
2. `passthrough` — allowed host, no credential injection
3. `deny` — everything else returns `403`

## Blast radius

Likely files to create or change:

- `Dockerfile`
- `docker-compose.yml`
- `docker/mitmproxy/addon.py`
- `docker/mitmproxy/rules.py`
- `docker/mitmproxy/entrypoint.sh`
- `docker/mitmproxy/test_rules.py`
- `docker/mitmproxy/test_addon.py`
- `docker/opencode/config/agents/build.md`
- `docker/opencode/bin/slack-upload`
- `docker/data/Dockerfile` (delete)
- `docker/data/entrypoint.sh` (delete)
- `packages/common/src/workspace-config.ts`
- `packages/common/src/workspace-config.test.ts`
- `docs/examples/workspace-config.example.json`
- `README.md`
- `.env.example`
- `scripts/mitmproxy-ca-init.sh`

## Phases

### Phase 1 — Proxy core + `data` removal

**Tasks:**

- Add a `mitmproxy` image target to the root `Dockerfile`.
- Create `docker/mitmproxy/` with:
  - `rules.py`
  - `addon.py`
  - `entrypoint.sh`
- Add `mitmproxy[]` and `mitmproxy_passthrough[]` to the workspace config
  schema in `packages/common/src/workspace-config.ts`.
- Support optional `path_prefix` matching on inject rules.
- Delete the `data` service from `docker-compose.yml`.
- Delete `docker/data/`.
- Rebind host port `3080` to `mitmproxy:8080`.
- Make `opencode` depend on `mitmproxy` instead of `data`.
- Add unit tests for:
  - host matching
  - suffix matching
  - path-prefix matching
  - `${ENV}` interpolation
  - readonly behavior
  - deny-by-default behavior
- Add CA generation script for local operator setup.
- Add a `mitmproxy` service to `docker-compose.yml` running on `:8080`.

**Exit criteria:**

- `./scripts/mitmproxy-ca-init.sh && docker compose up -d mitmproxy` starts
  cleanly on host port `3080`.
- `docker compose config` contains no `data` service and no `DATA_ROUTE*`
  environment wiring.
- `curl -x http://localhost:3080 http://__health.thor/` returns the synthetic
  health response.
- `curl -x http://localhost:3080 https://example.com` is denied with `403`.
- editing `/workspace/config.json` changes rule behavior without restarting
  mitmproxy
- missing referenced env vars fail closed with `502`

### Phase 2 — opencode wiring + built-in defaults

**Tasks:**

- Install `curl` in the `opencode` image.
- Install `jq` in the `opencode` image.
- Install `ripgrep` in the `opencode` image.
- Add lowercase and uppercase proxy env vars to the `opencode` service.
- Add a concrete `NO_PROXY` list for in-cluster services.
- Set `NODE_OPTIONS=--use-env-proxy`.
- Add `--disable-warning=UNDICI-EHPA` to `NODE_OPTIONS`.
- Mount the generated CA PEM into `opencode` and wire:
  - `NODE_EXTRA_CA_CERTS`
  - `CURL_CA_BUNDLE`
  - `SSL_CERT_FILE`
- Mount `/workspace/config.json` into `opencode` as read-only.
- Add a `slack-upload` helper in the `opencode` image for one-command Slack
  file uploads.
- Add baked-in default rules for:
  - `api.atlassian.com`
  - `.atlassian.net`
  - the supported Slack Web API paths on `slack.com`
  - `files.slack.com/upload/v1/...`
  - `files.slack.com/files-pri/...`
- Add baked-in default passthrough for:
  - `api.media.atlassian.com`
  - `openai.com`
  - `.openai.com`
  - `chatgpt.com`
  - `.chatgpt.com`
- Ensure user rules and user passthrough entries override built-ins by ordering.
- Add tests for:
  - defaults applied when `mitmproxy[]` is empty
  - user override wins
  - `slack-files.com` is not covered
  - path-scoped rules match by host + path prefix
  - OpenAI / ChatGPT domains passthrough by default

**Exit criteria:**

- inside `opencode`, `curl https://api.atlassian.com/oauth/me` works with no
  explicit `-x`
- inside `opencode`, `node -e 'fetch(...)'` succeeds through mitmproxy using
  Node's built-in env-proxy support
- inside `opencode`, `curl -I https://api.openai.com` reaches upstream through
  passthrough and is not denied by host policy
- `curl http://remote-cli:3004/health` bypasses the proxy via `NO_PROXY`
- inside `opencode`, `/workspace/config.json` is readable and mounted read-only
- inside `opencode`, `jq --version` works
- inside `opencode`, `rg --version` works
- inside `opencode`, `slack-upload --help` is available

### Phase 3 — Docs and operator workflow

**Tasks:**

- Document the exact request path in `README.md`.
- Update `.env.example` with proxy setup notes and custom rule instructions.
- Update `docs/examples/workspace-config.example.json`.
- Update opencode agent docs to say:
  - use real upstream URLs
  - proxying is explicit via env vars
  - available custom credential rules live in `/workspace/config.json`
  - include one simple Slack `chat.postMessage` example and defer deeper Slack
    workflow details to the Slack skill
- Rewrite the Slack skill to use real Slack Web API URLs over `mitmproxy`
  instead of `mcp slack` tool calls.
- Teach the Slack skill to use `slack-upload` for file uploads.
- Remove all operator docs and examples for `http://data/...`.
- Remove `DATA_ROUTES` / `DATA_ROUTE_*` documentation from `.env.example`.

**Exit criteria:**

- README clearly explains `opencode -> mitmproxy -> upstream`
- docs mention `curl` and built-in Node `fetch()` support explicitly
- docs make clear that Node support means built-in `fetch()`
- the Slack skill uses real `slack.com` / `files.slack.com` URLs and contains
  no `mcp slack` examples, with URL-encoded `curl` examples for simple writes
  and `slack-upload` for file uploads
- `build.md` contains one simple Slack post example and points to the Slack
  skill for the rest
- docs do not describe transparent routing or firewall-style enforcement
- no current docs tell operators to use `http://data/...`
- `.env.example` contains no `DATA_ROUTES` examples

## Testing

### Automated

- Python unit tests for `docker/mitmproxy/rules.py`
- Python unit tests for `docker/mitmproxy/addon.py`
- TypeScript tests for `packages/common/src/workspace-config.ts`

### Manual smoke tests

From inside `opencode`:

```bash
curl https://api.atlassian.com/oauth/me
node -e 'fetch("https://slack.com/api/conversations.history?channel=C123&limit=1").then(async r => console.log(r.status, await r.text()))'
curl -I https://api.openai.com
curl http://remote-cli:3004/health
```

Expected:

- Atlassian request is proxied and non-403
- Slack request is proxied and authenticated
- Node built-in `fetch()` request works through Node's built-in env-proxy
  support
- OpenAI request is passed through and not denied
- `remote-cli` request bypasses the proxy

## Decision log

| #   | Decision                                                                               | Rationale                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Use `mitmproxy` over Squid or a custom proxy                                           | mitmproxy already gives TLS interception plus a small Python addon surface for header mutation.                                                                 |
| D2  | Use `mitmdump`, not the interactive UI                                                 | Headless container runtime is the target.                                                                                                                       |
| D3  | Keep config in `/workspace/config.json`, secrets in env, interpolate at request time   | Matches existing Thor config patterns and keeps secrets out of the workspace file.                                                                              |
| D4  | Hot reload via file `mtime`, not process restart                                       | Rule edits should apply on the next request without bouncing the container.                                                                                     |
| D5  | Match hosts by `host` or `host_suffix`, not regex                                      | Exact and suffix matching cover the expected cases without making rule syntax hard to reason about.                                                             |
| D6  | Fail closed on missing env vars                                                        | Silent unauthenticated fallback is the wrong failure mode.                                                                                                      |
| D7  | Keep deny-by-default host policy                                                       | Unknown hosts should be rejected unless explicitly injected or passed through.                                                                                  |
| D8  | Use both lowercase and uppercase proxy env vars                                        | Different HTTP clients do not all consult the same proxy env var spellings.                                                                                     |
| D9  | Use Node 22 native env-proxy support                                                   | The current `node:22-slim` image already supports built-in `fetch()` proxying via `--use-env-proxy`, which removes an unnecessary dependency and preload file.  |
| D10 | Bake in Atlassian and Slack defaults                                                   | Those integrations are core Thor dependencies and should work without per-install copy-paste.                                                                   |
| D11 | User rules come before defaults                                                        | Operators need an escape hatch for host-specific overrides.                                                                                                     |
| D12 | Keep general communication policy in `build.md`; keep channel skills transport-focused | Future channels such as Telegram should reuse one policy surface while each skill only documents channel-specific APIs and mechanics.                           |
| D13 | Generate the CA on the host and mount it into containers                               | Keeps the private key out of image layers and keeps rotation simple.                                                                                            |
| D14 | Do not log request or response bodies                                                  | Bodies may contain credentials, prompts, PII, or large payloads.                                                                                                |
| D15 | Limit env vars exposed to mitmproxy                                                    | The proxy should only receive the secrets it actually needs for interpolation.                                                                                  |
| D16 | Pass through OpenAI and ChatGPT domains by default                                     | The OpenCode runtime itself depends on those hosts, so proxy enablement in `opencode` must not break model traffic.                                             |
| D17 | Remove the legacy `data` container instead of running both systems in parallel         | Sharing host port `3080` and teaching two URL shapes would create avoidable operator confusion and migration bugs.                                              |
| D18 | Install `curl` in `opencode`                                                           | The target operator workflow and smoke tests depend on a simple shell HTTP client being present in the container.                                               |
| D19 | Mount `/workspace/config.json` read-only into `opencode`                               | The agent should be able to inspect custom proxy rules without being able to edit deployment config in-place.                                                   |
| D20 | Explicitly scope Node support to built-in `fetch()` only                               |                                                                                                                                                                 |
| D21 | Interpolate `${ENV}` in mitmproxy from the proxy container env only                    | Keeps Phase 1 simple: use compose `env_file: .env` + explicit proxy envs, without introducing a second config/secret distribution system.                       |
| D22 | Split CA mounts into a private mitmproxy dir and a public-only opencode dir            | Fixes Docker's missing-file bind-mount footgun while keeping the CA private key unreadable from `opencode`.                                                     |
| D23 | Exit mitmproxy if the host-generated CA is missing                                     | Prevents the proxy from booting with a container-local CA that `opencode` does not trust, which would make HTTPS behavior depend on startup order.              |
| D24 | Add a `slack-upload` helper instead of teaching the raw Slack upload sequence inline   | Slack file uploads are a three-step flow that an LLM can easily mangle; a helper keeps the agent-facing workflow to one command.                                |
| D25 | Install `ripgrep` in `opencode` explicitly                                             | The agent guidance already prefers `rg` for code search, so the container should provide it directly instead of relying on upstream runtime behavior.           |
| D26 | Suppress only `UNDICI-EHPA` instead of all Node warnings                               | `--use-env-proxy` emits an experimental warning on every Node proxy call; `--disable-warning=UNDICI-EHPA` removes the noise without hiding unrelated warnings.  |
| D27 | Allow `api.media.atlassian.com` as built-in passthrough                                | Jira attachment-content requests can redirect there; the media URL should be reachable without widening Atlassian host access beyond the exact redirect target. |
| D28 | Make the built-in Atlassian proxy rules readonly                                       | The baked-in Atlassian path is intended for read access from `opencode`; write operations should continue to go through explicit MCP or user-configured rules.  |
| D29 | Install `jq` in `opencode` explicitly                                                  | Agent-side JSON inspection is a common shell workflow, and shipping `jq` avoids ad hoc parsing or runtime download attempts.                                    |
| D30 | Add optional `path_prefix` to mitmproxy inject rules                                   | Some deployments need different injected credentials on the same host; a prefix is enough without introducing regex or a larger rule language.                  |
| D31 | Narrow built-in Slack proxy rules to the opencode Slack workflow surface               | Allow only the Slack API methods needed over the mitmproxy path; update, delete, and reaction actions stay on the gateway/`slack-mcp` path instead.             |
| D32 | Use `mktemp`/`mktemp -d` under `/tmp` for temporary Slack artifacts                    | It is more reliable than fixed temp paths, avoids collisions when multiple agents run in parallel, and still preserves meaningful filenames when needed.        |

## Open questions

- whether any opencode-invoked built-in `fetch()` path bypasses the
  `NODE_OPTIONS` env-proxy wiring and needs a second wiring point

## Not in scope for this plan

- hard egress enforcement
- sandbox escape prevention
- per-client or per-repo policy identity
- GitHub credential injection through mitmproxy
