# Thor

An event-driven AI team member that watches Slack and scheduled jobs, resumes OpenCode sessions through the runner, and reaches external systems through `remote-cli`.

## Architecture

```text
ingress -> gateway -> runner -> opencode -> codex-lb -> ChatGPT
                           \
                            -> remote-cli -> MCP upstreams / CLI integrations
```

- `gateway` accepts Slack, GitHub webhook, and cron events, batches them, and forwards them to the runner.
- `runner` manages OpenCode session continuity and Slack progress updates.
- `remote-cli` exposes `POST /exec/*` endpoints for git, gh, sandbox, scoutqa, langfuse, metabase, MCP tool calls, direct Slack approval-card posting, and approval status/resolution.
- `codex-lb` is an OpenAI-compatible proxy that fronts ChatGPT for opencode, pooling one or more ChatGPT account credentials so no paid OpenAI API key is needed. Its account/quota dashboard sits behind the same SSO + admin-email gate as `/admin/`.

## Services

| Service       | Port | Package            | Role                                        |
| ------------- | ---- | ------------------ | ------------------------------------------- |
| `codex-lb`    | 2455 | Docker image       | ChatGPT-backed OpenAI-compatible proxy      |
| `cron`        | -    | `docker/cron`      | Scheduled prompts                           |
| `mitmproxy`   | 3080 | `docker/mitmproxy` | Explicit outbound HTTP(S) proxy             |
| `gateway`     | 3002 | `@thor/gateway`    | Slack/GitHub webhook ingestion and batching |
| `remote-cli`  | 3004 | `@thor/remote-cli` | CLI + MCP policy gateway                    |
| `admin`       | 3005 | `@thor/admin`      | Admin dashboard and workspace configuration |
| `grafana-mcp` | 8000 | Docker image       | Grafana MCP server                          |
| `ingress`     | 8080 | `docker/ingress`   | Reverse proxy + Vouch integration           |
| `opencode`    | 4096 | Docker image       | Headless agent runtime                      |
| `runner`      | 3000 | `@thor/runner`     | Session lifecycle + Slack progress updates  |
| `vouch`       | 9090 | Docker image       | OAuth/SSO proxy                             |

## Quick Start

1. Copy `.env.example` to `.env` and fill in the required secrets. Per-integration env vars are documented in each integration's doc (see [Integrations](#integrations) below).
2. Initialize the mitmproxy CA on the host:

```bash
./scripts/mitmproxy-ca-init.sh
```

All outbound HTTP(S) from OpenCode is routed through mitmproxy; see [`docs/feat/security-model.md`](docs/feat/security-model.md) Layer 1a for the routing path, built-in defaults, and custom rule format.

3. Create `/workspace/config/thor.json` (on the host: `docker-volumes/workspace/config/thor.json`) from [`docs/examples/thor.json`](docs/examples/thor.json). It carries GitHub App installation IDs, user attribution, Slack routing profiles, and any mitmproxy rules. MCP upstream access is enabled when matching global or profile-scoped env vars are present.

4. Clone repos into the shared workspace:

```bash
docker compose run --rm remote-cli \
  git clone https://github.com/your-org/your-repo.git
```

If the stack is already running, use `docker compose exec remote-cli ...` instead.

5. Start the stack:

```bash
mkdir -p docker-volumes/codex-lb && chmod 777 docker-volumes/codex-lb
docker compose up --build -d
curl http://localhost:8080/global/health
```

`codex-lb` runs as a non-root user and writes a SQLite store to `/var/lib/codex-lb`; pre-creating the host directory world-writable avoids a root-owned auto-mount.

6. Link a ChatGPT account so opencode has an upstream model:

   Visit `http://localhost:8080/dashboard` (admin-gated by Vouch + `THOR_ADMIN_EMAILS`), sign in with Google, and add a ChatGPT account from the codex-lb dashboard. Once linked, opencode picks the model from its UI (the provider whitelist surfaces `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`).

## Integrations

Thor is an internal AI teammate for engineering and product work; it is not meant to mirror production infrastructure exactly. Each integration owns its own env vars, app/manifest setup, required permissions, and troubleshooting reasons.

- **Slack** — [`docs/slack.md`](docs/slack.md). Events API intake, signing-secret verification, routing profiles for gated channels, per-channel repo override, app manifest.
- **GitHub App** — [`docs/github.md`](docs/github.md). Webhook intake, App permissions and event subscriptions, installation IDs, bot commit identity, CI wake gate.
- **Daytona sandboxes** — [`docs/daytona.md`](docs/daytona.md). On-demand cloud sandboxes for project builds/tests/lints. Custom snapshot publishing.
- **Outbound HTTP(S) (mitmproxy)** — [`docs/feat/security-model.md`](docs/feat/security-model.md) Layer 1a. Routing path, built-in defaults (Atlassian/Slack/OpenAI), custom credential rules.

Runtime integration paths:

| Integration      | Path                                               | Auth                    | Notes                                                   |
| ---------------- | -------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| Git / GitHub CLI | `remote-cli /exec/git`, `/exec/gh`                 | GitHub App token        | Repo-scoped worktree edits                              |
| Atlassian MCP    | `remote-cli /exec/mcp`                             | `ATLASSIAN_AUTH` header | Read + approved writes                                  |
| PostHog MCP      | `remote-cli /exec/mcp`                             | API key                 | Read + approved writes                                  |
| Grafana MCP      | `remote-cli /exec/mcp`                             | Service account token   | Logs and observability                                  |
| Slack Web API    | `gateway` + `remote-cli` + OpenCode over mitmproxy | Bot token               | Mentions, progress, approval cards, thread reads/writes |
| Langfuse         | `remote-cli /exec/langfuse`                        | API key pair            | Read-only trace queries                                 |
| LaunchDarkly     | `remote-cli /exec/ldcli`                           | Access token            | Read-only feature flag inspection                       |
| Metabase         | `remote-cli /exec/metabase`                        | API key                 | Read-only warehouse access                              |

Common usage patterns:

- **PR merged, errors spike** — a scheduled prompt checks telemetry, inspects recent merges through GitHub tools, prepares a fix in a worktree, and requests approval for the final write action.
- **Jira issue triage** — a webhook or Slack prompt asks Thor to investigate an issue; Thor reads Jira, checks recent commits, and reports likely owners and suspects.
- **Daily delivery digest** — a cron job asks Thor to summarize stale PRs, blocked issues, or failing tests and post the result to Slack.

## Deployment Configuration

Integration-specific env vars live in each integration's doc. Cross-cutting vars:

| Variable                        | Required | Service                     | Purpose                                                                                              |
| ------------------------------- | -------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CRON_SECRET`                   | Yes      | `gateway`, `cron`           | Shared secret for cron endpoint auth                                                                 |
| `THOR_ADMIN_EMAILS`             | Yes      | `ingress`                   | Comma-separated authenticated Google emails allowed for OpenCode-backed and `/admin/` ingress routes |
| `THOR_INTERNAL_SECRET`          | Yes      | `remote-cli`, `gateway`     | Secret-gates gateway↔remote-cli internal APIs                                                        |
| `THOR_E2E_TEST_HELPERS`         | No       | `runner`                    | Enables secret-gated deterministic runner e2e helpers                                                |
| `RUNNER_BASE_URL`               | Yes      | `remote-cli`                | Public base URL for Thor trigger viewer links in PR/Jira content                                     |
| `INGRESS_PORT`                  | No       | `ingress`                   | Host port for the reverse proxy                                                                      |
| `ATLASSIAN_AUTH`                | No       | `remote-cli`, `mitmproxy`   | Atlassian MCP auth header and mitmproxy default injection                                            |
| `POSTHOG_API_KEY`               | No       | `remote-cli`                | Global PostHog MCP auth; profile variants use `_<NORMALIZED_PROFILE_NAME>` suffixes                  |
| `GRAFANA_URL`                   | No       | `grafana-mcp`, `remote-cli` | Global Grafana instance URL; profile variants use `_<NORMALIZED_PROFILE_NAME>` suffixes              |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | No       | `grafana-mcp`, `remote-cli` | Global Grafana service account token; profile variants use `_<NORMALIZED_PROFILE_NAME>` suffixes     |
| `GRAFANA_ORG_ID`                | No       | `grafana-mcp`, `remote-cli` | Grafana org ID (defaults to `1`); profile variants use `_<NORMALIZED_PROFILE_NAME>` suffixes         |
| `LANGFUSE_HOST`                 | No       | `remote-cli`                | Langfuse host URL                                                                                    |
| `LANGFUSE_PUBLIC_KEY`           | No       | `remote-cli`                | Langfuse public key                                                                                  |
| `LANGFUSE_SECRET_KEY`           | No       | `remote-cli`                | Langfuse secret key                                                                                  |
| `METABASE_URL`                  | No       | `remote-cli`                | Metabase instance URL                                                                                |
| `METABASE_API_KEY`              | No       | `remote-cli`                | Metabase API key                                                                                     |
| `METABASE_DATABASE_ID`          | No       | `remote-cli`                | Metabase database ID                                                                                 |
| `METABASE_ALLOWED_SCHEMAS`      | No       | `remote-cli`                | Comma-separated schema allowlist                                                                     |
| `VOUCH_GOOGLE_CLIENT_ID`        | Yes      | `vouch`                     | Google OAuth client ID                                                                               |
| `VOUCH_GOOGLE_CLIENT_SECRET`    | Yes      | `vouch`                     | Google OAuth client secret                                                                           |
| `VOUCH_JWT_SECRET`              | Yes      | `vouch`                     | Session JWT signing secret                                                                           |
| `VOUCH_ALLOWED_EMAIL_DOMAINS`   | No       | `compose -> vouch`          | Rendered into Vouch's `VOUCH_DOMAINS`; comma-separated email domains, default `scoutqa.cc`           |
| `VOUCH_CALLBACK_URL`            | No       | `vouch`                     | OAuth callback URL                                                                                   |
| `VOUCH_COOKIE_DOMAIN`           | No       | `vouch`                     | Cookie domain                                                                                        |

### Workspace config (`thor.json`)

Lives at `/workspace/config/thor.json` inside containers, `docker-volumes/workspace/config/thor.json` on the host. Hot-reloaded — no restart needed after edits. Use [`docs/examples/thor.json`](docs/examples/thor.json) as a starting point and [`packages/common/src/proxies.ts`](packages/common/src/proxies.ts) as the reference for the built-in upstream catalog.

The file carries four operator-maintained registries:

- `owners.<owner>.github_app_installation_id` — GitHub App installation IDs. See [`docs/github.md`](docs/github.md) §2.
- `profiles.<name>.channels[]` — Slack conversation ids assigned to a routing profile. Private channels, DMs, group DMs, and Slack Connect surfaces must appear in a profile to be admitted. See [`docs/slack.md`](docs/slack.md) §5.
- `mitmproxy[]` / `mitmproxy_passthrough[]` — outbound credential rules and passthrough hosts. See [`docs/feat/security-model.md`](docs/feat/security-model.md) Layer 1a.
- `users[]` — human attribution (see below).

Profile names map to env suffixes by uppercasing and replacing non-alphanumerics with `_`: profile `qa-labs` checks `POSTHOG_API_KEY_QA_LABS` before `POSTHOG_API_KEY`, and the Grafana bundle `GRAFANA_URL_QA_LABS` + `GRAFANA_SERVICE_ACCOUNT_TOKEN_QA_LABS` before the unsuffixed bundle. Profile-only Grafana bundles are valid; the unsuffixed Grafana vars are optional. Non-Slack triggers use unsuffixed globals only.

### Human attribution (`users[]`)

`email` must be the Jira account email; Thor may write the name/email into `Co-authored-by:` commit trailers and use the email to resolve Jira assignees.

```json
{
  "users": [
    { "email": "alice@example.com", "name": "Alice", "slack": "UABCDEF1", "github": "alice" },
    { "email": "bob@example.com", "name": "Bob" }
  ]
}
```

To verify your entry, trigger Thor from Slack and look for `attribution_applied` with `outcome: "applied"` and your Slack id; `skipped_no_user_record` means the configured Slack id did not match the trigger.

The registry is maintained by operators from team Slack and GitHub membership records, with Jira account emails verified manually when needed. Keep source exports out of git if they contain personal data — commit only sanitized reconciliation decisions.

## Operations Notes

- Tell Thor about your team, repos, and reusable operating context in the OpenCode UI after the stack is up. That context is stored in persistent memory.
- Clone source repos from the `remote-cli` container so git credentials and filesystem ownership stay consistent.
- Repos under `/workspace/repos` are mounted read-only into OpenCode. Thor creates edits in `/workspace/worktrees`.
- OpenCode and remote-cli share the same `/tmp` volume so temporary artifacts referenced by absolute path, such as `slack-post-message --blocks-file /tmp/...`, are readable by the posting service.
- Scheduled prompts live in `docker-volumes/workspace/cron/crontab`.

## Security Model

Thor contains untrusted input — agent, OpenCode wrappers, external webhooks — through layered controls. In short:

- Vouch SSO + mitmproxy bound the network; remote-cli binds to `127.0.0.1` only.
- Inbound webhooks are HMAC-verified (Slack signing secret, GitHub `X-Hub-Signature-256`); internal gateway↔remote-cli routes are gated with `x-thor-internal-secret`.
- Channel/mention/self-loop gates filter authenticated traffic before it wakes the agent.
- `remote-cli` is the only place tool policy is enforced: MCP allow/approve/hidden tiers, command allowlists, GitHub App installation tokens. OpenCode never holds direct upstream credentials.
- Repos mount read-only into OpenCode; edits happen in `/workspace/worktrees`. Tool calls are audit-logged under `/workspace/worklog`.

See [`docs/feat/security-model.md`](docs/feat/security-model.md) for the full layered breakdown.

## Testing

```bash
pnpm test
REMOTE_CLI_GIT_REPO_URL=https://github.com/owner/repo \
REMOTE_CLI_GITHUB_REPO=owner/repo \
  pnpm test:e2e
pnpm test:create-jira-approval-e2e # live Slack/OpenCode approval-card e2e for Atlassian approval-required tools
pnpm test:opencode-e2e # separate explicit OpenCode/LLM smoke path
pnpm typecheck
```
