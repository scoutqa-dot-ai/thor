# Langfuse Operator Runbook

This runbook covers Langfuse **tracing** for OpenCode-driven LLM calls in Thor. Tracing is provided by [`opencode-plugin-langfuse`](https://www.npmjs.com/package/opencode-plugin-langfuse), which streams spans over OTLP/HTTP to a Langfuse project.

The plugin is loaded **only in CI** today. Production / local dev runs are untraced unless explicitly enabled (§5).

> **Not to be confused with the Langfuse MCP.** Thor also exposes Langfuse as a read-only MCP tool through `remote-cli /exec/mcp` so agents can query traces from inside a session. That integration runs in prod, lives in `packages/common/src/proxies.ts`, and is documented in `README.md` (`LANGFUSE_BASE_URL` row and the MCP table). It happens to share the `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` env vars with the plugin described here — both surfaces read from the same `.env` — but they are otherwise independent: this doc is the **write path** (opencode → Langfuse), the MCP is the **read path** (agent → Langfuse). Profile-suffixed variants (`LANGFUSE_*_<PROFILE>`) apply to the MCP only.

## 1) Environment variables

Set these in `.env` (or your deployment secret store). Compose forwards them onto the `opencode` service only.

| Variable               | Required | Used by              | What it is                                                                                | Where to find it in Langfuse UI                                                                                                                        |
| ---------------------- | -------- | -------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LANGFUSE_PUBLIC_KEY`  | Yes      | `opencode`           | Project public key (`pk-lf-...`)                                                          | Project → **Settings → API Keys**                                                                                                                      |
| `LANGFUSE_SECRET_KEY`  | Yes      | `opencode`           | Project secret key (`sk-lf-...`)                                                          | Project → **Settings → API Keys** (shown once at creation)                                                                                             |
| `LANGFUSE_BASE_URL`    | Yes      | `opencode` (compose) | Full Langfuse base URL with scheme, e.g. `https://us.cloud.langfuse.com`                  | Region-specific: `https://us.cloud.langfuse.com` (US), `https://cloud.langfuse.com` / `https://eu.cloud.langfuse.com` for EU, or your self-host origin |
| `LANGFUSE_HOST`        | Yes      | `mitmproxy`          | Bare host only (no scheme), e.g. `us.cloud.langfuse.com` — added to mitmproxy passthrough | Strip the scheme from `LANGFUSE_BASE_URL`                                                                                                              |
| `LANGFUSE_ENVIRONMENT` | No       | `opencode`           | Logical environment label on every trace; default `development`                           | User-supplied; matched by the UI's **Environment** filter                                                                                              |

> ⚠️ **Name asymmetry.** The plugin reads **`LANGFUSE_BASEURL`** (no underscore) inside the container. Compose maps `LANGFUSE_BASE_URL` → `LANGFUSE_BASEURL` on the `opencode` service (`docker-compose.yml`). Set the **underscored** form in `.env`.

## 2) Workspace config: mitmproxy passthrough

OpenCode routes all egress through `mitmproxy`, which **denies every host that is not in the passthrough allowlist** (built-ins cover OpenAI and Atlassian only — see `docker/mitmproxy/rules.py`). The OTLP exporter's POSTs to Langfuse will be silently 403'd unless you add the host:

```json
{
  "mitmproxy_passthrough": ["us.cloud.langfuse.com"]
}
```

in `/workspace/config/thor.json`. Use the suffix form `.langfuse.com` to allow all subdomains. Edits hot-reload — no service restart needed. CI generates this file from `LANGFUSE_HOST` at workflow runtime (see `.github/workflows/core-e2e.yml`).

## 3) OpenCode config

Two fields in `docker/opencode/config/opencode.json` must be set for the plugin to load:

```jsonc
{
  "plugin": ["./plugins/thor.js", "/usr/local/lib/node_modules/opencode-plugin-langfuse"],
  "experimental": { "openTelemetry": true },
}
```

The plugin is installed globally inside the `opencode` image (`Dockerfile` line ~85: `npm install -g opencode-plugin-langfuse@<pin>`). The absolute path bypasses OpenCode's runtime `npm install` resolution, which would otherwise hit `registry.npmjs.org` and be blocked by mitmproxy. Bare-name (`"opencode-plugin-langfuse"`) **does not work** inside the egress sandbox.

CI patches both `opencode.json` (jq) and `docker-compose.yml` (yq) at workflow runtime — see the "Bring up compose stack" step. Local dev keeps these files untouched.

## 4) Plugin version alignment

`opencode-plugin-langfuse` depends on a specific `@opencode-ai/plugin` major. When bumping either:

1. Bump `opencode-plugin-langfuse` in `Dockerfile` alongside `opencode-ai`.
2. Verify the plugin's `@opencode-ai/plugin` dep range covers the new opencode version (`cat /usr/local/lib/node_modules/opencode-plugin-langfuse/package.json` inside the image).
3. If the plugin lags opencode, either pin opencode back or wait for the plugin's `engines.opencode` range to widen.

## 5) Enabling outside CI

The canonical setup procedure — env vars, `opencode.json` patch, `docker-compose.yml` patch, and `thor.json` `mitmproxy_passthrough` entry — lives in [`.github/workflows/core-e2e.yml`](../.github/workflows/core-e2e.yml) under the "Bring up compose stack for e2e" step. Replicate those exact `jq` / `yq` / heredoc commands locally; do not transcribe them here, because this doc will drift.

Do not commit the patched `opencode.json` / `docker-compose.yml` — CI re-applies them on every run, and other operators may not want tracing.

## 6) Where to find traces in the UI

| What you want                 | Where                                                                   |
| ----------------------------- | ----------------------------------------------------------------------- |
| Traces from a session         | **Sessions** → search by `sessionId` (matches OpenCode's `ses_...` IDs) |
| All traces from a CI run      | **Traces** → filter by **Environment** = `development` (the CI default) |
| LLM call costs / token counts | Trace detail → individual generations                                   |
| All projects under the org    | API: `GET /api/public/projects` (Basic auth public:secret)              |

The **Environment** filter defaults to `default` / `production` in many UI views — switch to `All` or the relevant environment when traces "don't appear."

## 7) Secret rotation

1. In Langfuse, **Settings → API Keys → Create new key**.
2. Update `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` in your secret store (GitHub Actions secrets for CI, `.env` locally).
3. Revoke the previous key in the Langfuse UI **after** confirming new traces are arriving.

`LANGFUSE_BASE_URL` / `LANGFUSE_HOST` rarely change; if migrating regions or self-hosting, update both together and refresh `thor.json` `mitmproxy_passthrough`.

## 8) Troubleshooting

| Symptom                                                                                                     | Likely cause                                                                                                                                 | How to fix                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ERROR service=plugin ... 403 Forbidden - GET https://registry.npmjs.org/opencode-plugin-langfuse`          | `opencode.json` lists the plugin by bare name; OpenCode tries to npm-install it at startup, mitmproxy blocks the registry.                   | Use the absolute path `"/usr/local/lib/node_modules/opencode-plugin-langfuse"` in the `plugin` array (§3).                                                                                             |
| `ERROR service=plugin ... Could not parse user-provided export URL: '/api/public/otel/v1/traces'`           | `LANGFUSE_BASEURL` is empty in the container; the plugin concatenates `'' + '/api/public/otel/v1/traces'`.                                   | Set `LANGFUSE_BASE_URL` in `.env` (note the underscore — compose maps it to `LANGFUSE_BASEURL`). Verify with `docker exec opencode sh -c 'echo $LANGFUSE_BASEURL'`.                                    |
| Plugin logs `OTEL tracing initialized` and `Flushing OTEL spans before idle`, but the Langfuse UI is empty. | The OTLP POSTs are 403'd by mitmproxy (Langfuse host not in `mitmproxy_passthrough`), **or** UI environment filter mismatch.                 | Add the host to `thor.json` (§2). Then check the Langfuse UI **Environment** filter (default `development`). Verify with `docker logs mitmproxy \| grep langfuse` — POSTs should appear with no `403`. |
| `WARN service=config ... background dependency install failed ... @opencode-ai/plugin`                      | Cosmetic. OpenCode unconditionally tries to install `@opencode-ai/plugin` into `~/.config/opencode/` at boot; mitmproxy blocks npm registry. | Safe to ignore — detached fiber, logs only. Plugin loading is unaffected.                                                                                                                              |
| Traces arrive but `sessionId` / `userId` are `unknown`.                                                     | The OpenCode session correlation metadata is set by the plugin from event payloads; not all wake paths set it.                               | Expected for ad-hoc tooling sessions; investigate only if a wake path that should carry session id (Slack/GitHub trigger) is producing `unknown`.                                                      |
| Traces show but cost columns are blank.                                                                     | OpenAI usage metadata didn't make it into the span (provider response missing token counts, or upstream override).                           | Verify the `openai` provider response includes `usage`; check codex-lb / mitmproxy did not strip the body.                                                                                             |

### Quick verification commands

From inside the host:

```bash
# Are the env vars actually in the container?
docker exec $(docker ps -q -f name=opencode) sh -c \
  'echo "PUBLIC=$LANGFUSE_PUBLIC_KEY"; echo "BASEURL=$LANGFUSE_BASEURL"'

# Is mitmproxy passing langfuse traffic?
docker logs $(docker ps -q -f name=mitmproxy) 2>&1 | grep -i langfuse | tail

# Does the API see traces from this project?
curl -sS -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "$LANGFUSE_BASE_URL/api/public/traces?limit=5" | jq '.meta'
```

## 9) Data flow

```
opencode (NodeSDK + LangfuseSpanProcessor)
   │  OTLP/HTTP POST to ${LANGFUSE_BASEURL}/api/public/otel/v1/traces
   ▼
mitmproxy  ── allowlist check (mitmproxy_passthrough)
   │  passthrough → no MITM, native TLS
   ▼
us.cloud.langfuse.com  (or your region / self-host)
```

The OTel HTTP exporter (`@opentelemetry/exporter-trace-otlp-http`) uses Node's `http`/`https` modules. Those honor `HTTPS_PROXY` because the `opencode` service runs Node with `NODE_OPTIONS=--use-env-proxy`, which routes the global agent through the proxy env vars. If you swap the underlying exporter or remove `--use-env-proxy`, verify with `docker logs mitmproxy | grep langfuse` — no entries means the exporter bypassed the proxy entirely, in which case nothing reaches Langfuse and the UI stays empty without any visible error.
