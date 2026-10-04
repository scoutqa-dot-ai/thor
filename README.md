# Neo

Neo is the product name. Existing `THOR_*` variables, `@thor/*` packages,
`thor.json`, container paths, crypto namespaces and deployment project/volume
names remain legacy compatibility identifiers. Keep your current Ubuntu checkout,
`.env`, Compose project and data; a branding update must not create another stack
or disconnect stored accounts. Historical plans and third-party attributions keep
their original names. Update the existing Slack/Google app display names to Neo
without replacing their IDs, credentials or callback URLs.

An event-driven AI team member that watches Slack and scheduled jobs, resumes OpenCode sessions through the runner, and reaches external systems through `remote-cli`.

An opt-in [Pi Durable mode](docs/pi-runtime.md) embeds the harness in runner and executes tools in an isolated container. Try it without credentials or deployment data using `./scripts/test-pi-e2e.sh`; the default stack remains OpenCode.

## Architecture

```text
ingress -> gateway -> runner -> opencode -> codex-lb -> ChatGPT/Codex subscriptions
                           \
                            -> remote-cli -> MCP upstreams / CLI integrations
```

- `gateway` accepts Slack, GitHub webhook, and cron events, batches them, and forwards them to the runner.
- `runner` manages OpenCode session continuity and Slack progress updates.
- `remote-cli` exposes `POST /exec/*` endpoints for git, gh, sandbox, scoutqa, langfuse, metabase, MCP tool calls, direct Slack approval-card posting, and approval status/resolution.
- `codex-lb` is an OpenAI-compatible proxy that fronts ChatGPT for opencode, pooling one or more ChatGPT account credentials so no paid OpenAI API key is needed. Its account/quota dashboard sits behind the same SSO + admin-email gate as `/admin/`.

## Services

| Service       | Port      | Package            | Role                                              |
| ------------- | --------- | ------------------ | ------------------------------------------------- |
| `cron`        | -         | `docker/cron`      | Scheduled prompts                                 |
| `codex-lb`    | 2455/1455 | Docker image       | Multi-subscription model routing + OAuth callback |
| `mitmproxy`   | 3080      | `docker/mitmproxy` | Explicit outbound HTTP(S) proxy                   |
| `gateway`     | 3002      | `@thor/gateway`    | Slack/GitHub webhook ingestion and batching       |
| `remote-cli`  | 3004      | `@thor/remote-cli` | CLI + MCP policy gateway                          |
| `admin`       | 3005      | `@thor/admin`      | Admin dashboard and workspace configuration       |
| `grafana-mcp` | 8000      | Docker image       | Grafana MCP server                                |
| `falcon-mcp`  | 8000      | Docker image       | CrowdStrike Falcon MCP server                     |
| `ingress`     | 8080      | `docker/ingress`   | Reverse proxy + Vouch integration                 |
| `opencode`    | 4096      | Docker image       | Headless agent runtime                            |
| `runner`      | 3000      | `@thor/runner`     | Session lifecycle + Slack progress updates        |
| `vouch`       | 9090      | Docker image       | OAuth/SSO proxy                                   |

## Quick Start

1. Copy `.env.example` to `.env` and fill in the required secrets. Per-integration env vars are documented in each integration's doc (see [Integrations](#integrations) below).
2. Initialize the mitmproxy CA on the host:

```bash
./scripts/mitmproxy-ca-init.sh
```

All outbound HTTP(S) from OpenCode is routed through mitmproxy; see [`docs/feat/security-model.md`](docs/feat/security-model.md) Layer 1a for the routing path, built-in defaults, and custom rule format.

3. Create `/workspace/config/thor.json` (on the host: `docker-volumes/workspace/config/thor.json`) from [`docs/examples/thor.json`](docs/examples/thor.json). It carries GitHub App installation IDs, user attribution, the Slack allowlist, and any mitmproxy rules. MCP upstream access is enabled for every repo automatically.

4. Clone repos into the shared workspace:

```bash
docker compose run --rm remote-cli \
  git clone https://github.com/your-org/your-repo.git
```

If the stack is already running, use `docker compose exec remote-cli ...` instead.

5. Start the stack:

```bash
docker compose up --build -d
curl http://localhost:8080/health
```

Open `http://localhost:8080/dashboard` (or the office-reachable ingress URL),
sign in through Vouch with an address in `THOR_ADMIN_EMAILS`, and add each
ChatGPT subscription. For a browser away from the Docker host, use codex-lb's
manual OAuth callback flow; its fixed callback listener remains on host
loopback port `1455`. codex-lb persists its private state in the `codex-lb-data` named volume.

## Integrations

Neo is an internal AI teammate for engineering and product work; it is not meant to mirror production infrastructure exactly. Each integration owns its own env vars, app/manifest setup, required permissions, and troubleshooting reasons.

- **Slack** — [`docs/slack.md`](docs/slack.md). Events API intake, signing-secret verification, private-channel allowlist, per-channel repo override, app manifest.
- **GitHub App** — [`docs/github.md`](docs/github.md). Webhook intake, App permissions and event subscriptions, installation IDs, bot commit identity, CI wake gate.
- **Daytona sandboxes** — [`docs/daytona.md`](docs/daytona.md). On-demand cloud sandboxes for project builds/tests/lints. Custom snapshot publishing.
- **Google Workspace** — [`docs/google-workspace.md`](docs/google-workspace.md). Per-Slack-user OAuth, automatic auth continuation and short-lived token injection.
- **Outbound HTTP(S) (mitmproxy)** — [`docs/feat/security-model.md`](docs/feat/security-model.md) Layer 1a. Routing path, built-in defaults (Atlassian/Slack/OpenAI), custom credential rules.
- **1Password browser login** — [`docs/onepassword-browser.md`](docs/onepassword-browser.md). Approval-gated credential injection into an ephemeral local Chromium session.
- **Codex subscription pool** — [`docs/codex-lb.md`](docs/codex-lb.md). Multiple ChatGPT subscriptions behind the Vouch-protected dashboard at `/dashboard`.

Runtime integration paths:

| Integration      | Path                                               | Auth                     | Notes                                                         |
| ---------------- | -------------------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| Model inference  | `opencode -> codex-lb`                             | Private Docker network   | Routes fresh work across eligible ChatGPT subscriptions       |
| Git / GitHub CLI | `remote-cli /exec/git`, `/exec/gh`                 | GitHub App token         | Repo-scoped worktree edits                                    |
| Atlassian MCP    | `remote-cli /exec/mcp`                             | `ATLASSIAN_AUTH` header  | Read + approved writes                                        |
| PostHog MCP      | `remote-cli /exec/mcp`                             | API key                  | Read + approved writes                                        |
| Grafana MCP      | `remote-cli /exec/mcp`                             | Service account token    | Logs and observability                                        |
| Kali MCP/API     | `remote-cli /exec/mcp`                             | Network-restricted EC2   | Authorized Kali security testing tools                        |
| Slack Web API    | `gateway` + `remote-cli` + OpenCode over mitmproxy | Bot token                | Mentions, progress, approval cards, thread reads/writes       |
| Langfuse         | `remote-cli /exec/langfuse`                        | API key pair             | Read-only trace queries                                       |
| LaunchDarkly     | `remote-cli /exec/ldcli`                           | Access token             | Read-only feature flag inspection                             |
| Metabase         | `remote-cli /exec/metabase`                        | API key                  | Read-only warehouse access                                    |
| Drata            | `remote-cli /exec/drata`                           | OAuth client credentials | API reads/writes; permissions managed by Drata                |
| Google Workspace | `remote-cli /exec/gws`                             | Per-Slack-user OAuth     | Direct execution; encrypted grants; no global fallback        |
| 1Password        | `remote-cli /exec/mcp`                             | Service-account token    | Approved one-item, one-origin browser login and optional TOTP |

Common usage patterns:

- **PR merged, errors spike** — a scheduled prompt checks telemetry, inspects recent merges through GitHub tools, prepares a fix in a worktree, and requests approval for the final write action.
- **Jira issue triage** — a webhook or Slack prompt asks Neo to investigate an issue; Neo reads Jira, checks recent commits, and reports likely owners and suspects.
- **Daily delivery digest** — a cron job asks Neo to summarize stale PRs, blocked issues, or failing tests and post the result to Slack.

## Deployment Configuration

Integration-specific env vars live in each integration's doc. Cross-cutting vars:

| Variable                        | Required | Service                                         | Purpose                                                                                              |
| ------------------------------- | -------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CRON_SECRET`                   | Yes      | `gateway`, `cron`                               | Shared secret for cron endpoint auth                                                                 |
| `THOR_ADMIN_EMAILS`             | Yes      | `ingress`                                       | Comma-separated authenticated Google emails allowed for OpenCode-backed and `/admin/` ingress routes |
| `THOR_INTERNAL_SECRET`          | Yes      | `remote-cli`, `gateway`, `ingress`, Pi `runner` | Secret-gates internal APIs, OAuth ingress and Pi trigger admission                                   |
| `THOR_E2E_TEST_HELPERS`         | No       | `runner`                                        | Enables secret-gated deterministic runner e2e helpers                                                |
| `RUNNER_BASE_URL`               | Yes      | `remote-cli`, `runner`                          | Public base URL for Neo trigger viewer links and Slack activity artwork                              |
| `INGRESS_PORT`                  | No       | `ingress`                                       | Host port for the reverse proxy                                                                      |
| `ATLASSIAN_AUTH`                | Yes      | `remote-cli`, `mitmproxy`                       | Atlassian MCP auth header and mitmproxy default injection                                            |
| `POSTHOG_API_KEY`               | Yes      | `remote-cli`                                    | PostHog MCP auth                                                                                     |
| `GRAFANA_URL`                   | Yes      | `grafana-mcp`                                   | Grafana instance URL                                                                                 |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | Yes      | `grafana-mcp`                                   | Grafana service account token                                                                        |
| `GRAFANA_ORG_ID`                | No       | `grafana-mcp`                                   | Grafana org ID (defaults to `1`)                                                                     |
| `LANGFUSE_HOST`                 | No       | `remote-cli`                                    | Langfuse host URL                                                                                    |
| `LANGFUSE_PUBLIC_KEY`           | No       | `remote-cli`                                    | Langfuse public key                                                                                  |
| `LANGFUSE_SECRET_KEY`           | No       | `remote-cli`                                    | Langfuse secret key                                                                                  |
| `METABASE_URL`                  | No       | `remote-cli`                                    | Metabase instance URL                                                                                |
| `METABASE_API_KEY`              | No       | `remote-cli`                                    | Metabase API key                                                                                     |
| `METABASE_DATABASE_ID`          | No       | `remote-cli`                                    | Metabase database ID                                                                                 |
| `METABASE_ALLOWED_SCHEMAS`      | No       | `remote-cli`                                    | Comma-separated schema allowlist                                                                     |
| `DRATA_OAUTH_TOKEN_URL`         | No       | `remote-cli`                                    | Drata OAuth token endpoint                                                                           |
| `DRATA_CLIENT_ID`               | No       | `remote-cli`                                    | Drata OAuth application client ID                                                                    |
| `DRATA_CLIENT_SECRET`           | No       | `remote-cli`                                    | Drata OAuth application client secret                                                                |
| `DRATA_AUDIENCE`                | No       | `remote-cli`                                    | Drata API audience value from the OAuth app token request details                                    |
| `DRATA_SCOPES`                  | No       | `remote-cli`                                    | Space-separated Drata OAuth scopes for the intended read/write permissions                           |
| `DRATA_API_BASE_URL`            | No       | `remote-cli`                                    | Drata API base URL                                                                                   |
| `KALI_API_BASE_URL`             | No       | `remote-cli`                                    | EC2-hosted Kali API server URL for the `mcp kali` tools                                              |
| `OP_SERVICE_ACCOUNT_TOKEN`      | No       | `remote-cli`                                    | Read-only token for the browser broker; service-scoped injection only                                |
| `ONEPASSWORD_BROWSER_VAULT_ID`  | No       | `remote-cli`                                    | Dedicated Login vault ID; required with `OP_SERVICE_ACCOUNT_TOKEN`                                   |
| `VOUCH_GOOGLE_CLIENT_ID`        | Yes      | `vouch`                                         | Google OAuth client ID                                                                               |
| `VOUCH_GOOGLE_CLIENT_SECRET`    | Yes      | `vouch`                                         | Google OAuth client secret                                                                           |
| `VOUCH_JWT_SECRET`              | Yes      | `vouch`                                         | Session JWT signing secret                                                                           |
| `VOUCH_ALLOWED_EMAIL_DOMAINS`   | No       | `compose -> vouch`                              | Rendered into Vouch's `VOUCH_DOMAINS`; comma-separated email domains, default `scoutqa.cc`           |
| `VOUCH_CALLBACK_URL`            | No       | `vouch`                                         | OAuth callback URL                                                                                   |
| `VOUCH_COOKIE_DOMAIN`           | No       | `vouch`                                         | Cookie domain                                                                                        |

Runner uses `RUNNER_BASE_URL` with fixed root paths `/neo-thinking-v1.gif`,
`/neo-working-v1.gif` and `/neo-ai-still-v1.png`. Set the existing public ingress
HTTP(S) base without credentials, query or fragment; blank/invalid bases retain
text-only progress. Slack must be able to retrieve these images without login.

Opt-in Pi publishes ordinary final answers only for new gateway-admitted Slack
requests with configured `SLACK_TEAM_ID` equality and frozen privacy/repository
permission. Old/pending work and default OpenCode retain explicit tool replies;
Google resumes inherit the original destination/policy. Publication uncertainty
is recorded on the request and never automatically reposted. Native sessions
loading uses existing `chat:write`; unsupported features fall back to the quiet
AI footer. No manifest/scope activation or runtime-default change is automatic.
See [Pi answer/presentation safety](docs/pi-runtime.md#host-owned-slack-answers).

Rebuild/redeploy ingress, gateway and runner together; no new env var, Slack
scope, app or credential is needed. Slack controls GIF playback and reduced
motion; adjacent labels remain readable when images/animation are disabled.

Drata uses `drata api METHOD /path [--json JSON]`, without a method or API-version
allowlist. Configure its OAuth app/scopes for intended operations. Paths stay on
`DRATA_API_BASE_URL`; redirects are returned rather than followed. Writes do not
require Neo approval. OAuth secrets remain in remote-cli, and token failures do
not expose the OAuth response body.

Google Workspace configuration (per-Slack-user OAuth):

First use sends the trusted requesting Slack user a private OAuth DM. No Google mapping or Slack email-read permission is required. Enable the Slack app's Messages Tab and set `SLACK_TEAM_ID`. The user confirms the Google account/Slack recipient in their browser; Google and browser SSO must verify the same email. The encrypted grant is then used only for that Slack user. See [Google Workspace](docs/google-workspace.md).

| Variable                                 | Required | Service                 | Purpose                                                                       |
| ---------------------------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------- |
| `GOOGLE_WORKSPACE_OAUTH_CLIENT_ID`       | For GWS  | `remote-cli` only       | Google Web OAuth client ID                                                    |
| `GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET`   | For GWS  | `remote-cli` only       | Google Web OAuth client secret                                                |
| `GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL` | For GWS  | `remote-cli`, `ingress` | Exact external HTTPS origin; callback is `/google-workspace/oauth/callback`   |
| `GOOGLE_WORKSPACE_OAUTH_SCOPES`          | For GWS  | `remote-cli` only       | Comma-separated Drive, Docs, and Sheets allowlisted scopes                    |
| `GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY`  | For GWS  | `remote-cli` only       | Dedicated 32-byte base64 key for encrypted server-side grants                 |
| `GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR`     | No       | `remote-cli` only       | Encrypted state directory; Compose fixes it to a private named volume         |
| `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`        | No       | `remote-cli` only       | Parent for fresh private per-execution cwd; never shared with OpenCode        |
| `GOOGLE_WORKSPACE_PROJECT_ID`            | No       | `remote-cli` only       | Optional upstream GCP quota/billing project override                          |
| workspace user `google_workspace_email`  | Optional | workspace config        | Restrict Google account choice; otherwise learn identity during private OAuth |

Every GWS call requires the latest active Slack actor and that user's connected
Google identity. Connected commands execute directly without a command approval.
Missing or definitively revoked credentials pause the task through a confirmed
private OAuth DM and encrypted continuation. It blocks `gws auth` and local-file
command surfaces, has no global credential fallback, and injects
only a refreshed `GOOGLE_WORKSPACE_CLI_TOKEN` into a fresh isolated child cwd.
See [Google Workspace OAuth](docs/google-workspace.md).

### Runtime upgrades

Current pins: OpenCode CLI/SDK **1.18.29**, codex-lb **1.24.0**, Falcon MCP
**0.19.0**, Grafana MCP **1.3.0**, Aikido MCP **1.0.22**. Keep the OpenCode
SDK and server versions aligned when upgrading. codex-lb is pinned by tag and
OCI digest; update both after reviewing its release notes.

Before deploying an OpenCode or codex-lb upgrade, pause incoming triggers, let
active tasks finish, and stop `runner` and `opencode`. Back up
`docker-volumes/opencode`; for codex-lb upgrades, also stop codex-lb and back up
its `codex-lb-data` volume. Keep both backups private. The codex-lb volume holds
subscription OAuth tokens and its encryption key. Do not run an older service
against migrated state without restoring a matching backup.

After syncing the updated source and taking the backup:

```bash
docker compose pull codex-lb grafana-mcp falcon-mcp
docker compose up -d --build codex-lb grafana-mcp falcon-mcp remote-cli opencode runner
docker compose exec opencode opencode --version
```

Grafana's Host allowlist includes the internal Docker service name; keep it
aligned with its upstream URL if renaming the service. Grafana 1.3.0 logs an
unauthenticated-listener security warning with the existing internal-only setup;
neither Grafana nor Falcon publishes a host port. Do not expose those listeners
without caller authentication. Aikido uses the existing `AIKIDO_API_KEY` for
headless auth; its image now includes the native keytar runtime library.

See [`docs/codex-lb.md`](docs/codex-lb.md) for subscription onboarding,
ingress routing, direct OpenCode-credential removal, backup/restore, and
rollback.

### Optional Pi Durable runtime

Use `docker compose -f docker-compose.yml -f docker-compose.pi.yml up --build -d --remove-orphans` after configuring the stack. See [Pi testing, persistence and rollback](docs/pi-runtime.md); do not run two stacks on the same ports/webhook stream. The override selects Pi and routes the authenticated home page to the Neo sessions dashboard, not an interactive OpenCode UI.

Pi startup loads its native runtime and a read-only historical OpenCode viewer,
not the live OpenCode execution client/event bus. Existing `/runner/v/` links
remain available behind the same ingress SSO boundary. Default/explicit OpenCode
startup retains the legacy execution path for rollback.

| Variable                   | Default                     | Service             | Purpose                                                     |
| -------------------------- | --------------------------- | ------------------- | ----------------------------------------------------------- |
| `THOR_RUNTIME`             | `opencode`                  | `runner`, `ingress` | Override selects `pi`; default deployment stays OpenCode    |
| `PI_EXECUTOR_URL`          | `http://pi-executor:3002`   | `runner`            | Private remote file/process execution origin                |
| `PI_STORAGE_PATH`          | `/var/lib/runner/pi.sqlite` | `runner`            | Runner-only durable state, never mounted in executor        |
| `PI_MODEL_BASE_URL`        | `http://codex-lb:2455/v1`   | `runner`            | Standard Responses provider endpoint                        |
| `PI_MODEL_ID`              | `gpt-5.4`                   | `runner`            | Provider model ID                                           |
| `PI_MODEL_API_KEY`         | `codex-lb-local`            | `runner`            | Model auth; never forwarded to tools                        |
| `PI_MODEL_CONTEXT_WINDOW`  | `272000`                    | `runner`            | Context limit for compaction and progress                   |
| `PI_MODEL_SUPPORTS_IMAGES` | `true`                      | `runner`            | Inline image input; set false for text-only custom backends |
| `PI_SKILLS_DIR`            | `/etc/thor/skills`          | `runner`            | Remote skill catalog path inside executor                   |
| `PI_MEMORY_DIR`            | `/workspace/memory`         | `runner`            | Shared root/repo memory location                            |

### Workspace config (`thor.json`)

Lives at `/workspace/config/thor.json` inside containers, `docker-volumes/workspace/config/thor.json` on the host. Most fields are hot-reloaded; **Pi model routing is read once at runner startup and requires a runner restart**. Use [`docs/examples/thor.json`](docs/examples/thor.json) as a starting point and [`packages/common/src/proxies.ts`](packages/common/src/proxies.ts) as the reference for the built-in upstream catalog.

The file carries four operator-maintained registries:

- `owners.<owner>.github_app_installation_id` — GitHub App installation IDs. See [`docs/github.md`](docs/github.md) §2.
- `slack.private_channel_allowlist` — conversation ids Neo may act in for private channels, DMs, group DMs, and Slack Connect. See [`docs/slack.md`](docs/slack.md) §5.
- `mitmproxy[]` / `mitmproxy_passthrough[]` — outbound credential rules and passthrough hosts. See [`docs/feat/security-model.md`](docs/feat/security-model.md) Layer 1a.
- `users[]` — human attribution (see below).
- Optional `pi.modelRouting` — per-task Pi model/thinking profiles. Absent routing uses `PI_MODEL_ID` for all profiles with low/medium/high thinking. Distinct models require operator-configured, actually served IDs; no model catalog is probed. All profiles share the existing provider, credentials, context and image declarations. See [Pi routing and overrides](docs/pi-runtime.md#task-model-routing).

Single-model-compatible workspace example (replace the sample ID with your served model, or omit `modelId` to inherit `PI_MODEL_ID`):

```json
{
  "pi": {
    "modelRouting": {
      "profiles": {
        "fast": { "modelId": "gpt-5.4", "thinkingLevel": "low" },
        "balanced": { "modelId": "gpt-5.4", "thinkingLevel": "medium" },
        "strong": { "modelId": "gpt-5.4", "thinkingLevel": "high" }
      },
      "autoSelect": true,
      "defaultProfile": "balanced",
      "allowEscalation": true
    }
  }
}
```

Fresh Slack requests may start with `[profile:strong thinking:high]`, `[model:configured-id thinking:low]` or `[thinking:high]` after the bot mention. HTTP uses `modelProfile` or `modelId`, plus optional `thinkingLevel` and current-task `routingTask`. Explicit overrides lock escalation. Invalid declared config fails startup safely; unavailable frozen task choices fail closed instead of guessing another model. Existing task retries and Google OAuth continuations retain their original final selection, even after escalation.

### Human attribution (`users[]`)

`email` must be the Jira account email; Neo may write the name/email into `Co-authored-by:` commit trailers and use the email to resolve Jira assignees.

```json
{
  "users": [
    { "email": "alice@example.com", "name": "Alice", "slack": "UABCDEF1", "github": "alice" },
    { "email": "bob@example.com", "name": "Bob" }
  ]
}
```

To verify your entry, trigger Neo from Slack and look for `attribution_applied` with `outcome: "applied"` and your Slack id; `skipped_no_user_record` means the configured Slack id did not match the trigger.

The registry is maintained by operators from team Slack and GitHub membership records, with Jira account emails verified manually when needed. Keep source exports out of git if they contain personal data — commit only sanitized reconciliation decisions.

## Operations Notes

- Tell Neo about your team, repos, and reusable operating context in the OpenCode UI after the stack is up. That context is stored in persistent memory.
- Clone source repos from the `remote-cli` container so git credentials and filesystem ownership stay consistent.
- Repos under `/workspace/repos` are mounted read-only into OpenCode. Neo creates edits in `/workspace/worktrees`.
- OpenCode and remote-cli share the same `/tmp` volume so temporary artifacts referenced by absolute path, such as `slack-post-message --blocks-file /tmp/...`, are readable by the posting service.
- Scheduled prompts live in `docker-volumes/workspace/cron/crontab`.

## Security Model

Neo contains untrusted input — agent, OpenCode wrappers, external webhooks — through layered controls. In short:

- Vouch SSO + mitmproxy bound the network; remote-cli binds to `127.0.0.1` only.
- codex-lb holds pooled ChatGPT OAuth credentials. Its direct host ports bind to loopback, while `/dashboard` is exposed through the ingress Vouch/admin-email gate.
- Inbound webhooks are HMAC-verified (Slack signing secret, GitHub `X-Hub-Signature-256`); internal gateway↔remote-cli routes are gated with `x-thor-internal-secret`.
- Channel/mention/self-loop gates filter authenticated traffic before it wakes the agent.
- `remote-cli` owns tool policy and upstream credentials. GWS uses per-Slack-user encrypted OAuth grants and direct requester-owned execution; Pi resumes missing-credential waits automatically after private OAuth. Drata delegates operation authorization to its OAuth app/API. Neither runtime receives either integration's long-lived credential.
- Repos mount read-only into OpenCode; edits happen in `/workspace/worktrees`. Tool calls are audit-logged under `/workspace/worklog`.

See [`docs/feat/security-model.md`](docs/feat/security-model.md) for the full layered breakdown.

## Testing

```bash
pnpm test
pnpm test:mcp
REMOTE_CLI_GIT_REPO_URL=https://github.com/owner/repo \
REMOTE_CLI_GITHUB_REPO=owner/repo \
  pnpm test:e2e
pnpm test:create-jira-approval-e2e # live Slack/OpenCode approval-card e2e for Atlassian approval-required tools
pnpm test:opencode-e2e # separate explicit OpenCode/LLM smoke path
pnpm typecheck
```
