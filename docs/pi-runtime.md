# Testing Thor on Pi Durable

Pi mode embeds `@earendil-works/pi-durable` in runner. File/process tools run only in `pi-executor`; integration credentials and approvals remain in remote-cli. OpenCode is still the default deployment and is retained for rollback.

## First: isolated test, no credentials

From this worktree:

```bash
./scripts/test-pi-e2e.sh
```

Requires Docker with Compose 2.24.4+ and internet access to build images. It creates a uniquely named temporary project and named volumes, runs deterministic model/Slack/SSO/policy-wrapper fixtures, and removes its containers/volumes afterward. It does not read `.env`, reuse mounted deployment data, expose host ports, or call real accounts.

The test verifies signed Slack HTTP intake through the real gateway/disk queue into Pi, invalid-signature denial, duplicate suppression across privacy reroutes, actor attribution, in-thread replies and non-mention continuation. It also checks model/tool rounds, remote file/shell execution, wrapper session/call attribution, read-only repo mounts, runner-secret isolation, forged-trigger denial, correctly addressed Slack progress, authenticated ingress/admin/viewers, OAuth header/SSO routing and SQLite recovery after SIGKILL.

For local source verification:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

## Try the configured stack

This mode includes the complete local-test snapshot `f15cacc`: per-user Google OAuth, Drata changes, updated MCP/runtime pins, codex-lb 1.24.0 and the intentional agent deletions. Application code is merged; private mounted deployment data and account/grant volumes are not copied by Git.

1. Configure this checkout using the main README Quick Start: `.env`, workspace config, repo checkouts and the mitmproxy public CA. Ensure codex-lb has a linked account and serves the selected model.
2. Back up deployment data and stop any old stack occupying the same host ports. Do not run two stacks consuming the same Slack/webhook stream. Do not point two runners at one Pi database. These commands affect only the Compose project selected from this checkout; they do not stop another worktree's project.
3. Check host policy before starting: `docker info --format '{{json .SecurityOptions}}'`. The base stack selects the externally provisioned `thor-remote-cli` AppArmor profile; on AppArmor-enabled hosts it must already be loaded. On hosts without AppArmor support, explicitly append `-f docker-compose.no-apparmor.yml` to the commands below; that platform override retains the custom bubblewrap seccomp policy. Never use the test-only `docker-compose.ci.yml` for a deployment.

4. Start with the opt-in override:

```bash
docker compose -f docker-compose.yml -f docker-compose.pi.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.pi.yml up --build -d --remove-orphans
curl --fail http://127.0.0.1:3000/health
```

Expected health: `{"status":"ok","runtime":"pi"}`. The override disables the OpenCode service, selects Pi in runner/ingress, and creates runner-only `pi-state` storage. It does not migrate old OpenCode transcripts or change OAuth accounts.

5. Send a read-only prompt through a test Slack channel. Progress and approval behavior should remain familiar. The authenticated root page now leads to `/admin/sessions`; select a trigger to view its Pi transcript. This is not an OpenCode-style interactive browser chat UI.
6. For a direct loopback smoke test, export the configured `THOR_INTERNAL_SECRET` in your shell first (do not paste its literal value into prompts or checked-in commands):

```bash
curl --fail-with-body --no-buffer http://127.0.0.1:3000/trigger \
  -H 'Content-Type: application/json' \
  -H "x-thor-internal-secret: $THOR_INTERNAL_SECRET" \
  -d '{"directory":"/workspace/repos/YOUR_REPO","prompt":"Read README and summarize setup. Do not modify files or call external write tools.","correlationKey":"cron:pi-smoke","requestId":"pi-smoke-1","stream":true}'
```

Replace `YOUR_REPO`. Reusing the same request ID and payload finds the same run; use a new ID for a new operation. Changed-payload reuse returns 409. Missing/incorrect gateway credentials return 401. Direct calls cannot resume a legacy OpenCode session ID.

For non-streamed acceptance, omit `stream`; the response includes `anchorId` and `triggerId` for `/runner/v/<anchorId>/<triggerId>`. Existing OpenCode history remains readable through the same viewer routes.

## Slack deployment and acceptance checklist

1. Use a dedicated test Slack app/channel, or pause the old deployment before changing the existing app's URLs. Invite the bot to the test channel. Only one deployment may consume that app's events.
2. Configure `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_USER_ID`, `SLACK_DEFAULT_REPO` and `SLACK_TEAM_ID`. The repo must exist under the mounted `/workspace/repos`. Set `RUNNER_BASE_URL` to the external HTTPS origin so viewer links work. Configure Vouch's callback/cookie/domain and allowed admin emails for the same public origin.
3. Expose ingress port 8080 through your HTTPS reverse proxy or a development tunnel. In the Slack app set Event Subscriptions to `https://HOST/slack/events` and Interactivity to `https://HOST/slack/interactivity`. Slack's URL verification should succeed. This is HTTP Events API, not Socket Mode.
4. Install the [Slack manifest](examples/slack.json) scopes/events and reinstall the app if scopes changed. Include `app_mention` and `message.*` subscriptions for non-mention thread follow-ups. Private/DM/shared test channels need their ID in `slack.private_channel_allowlist` in `thor.json`.
5. Open `/dashboard`, connect your codex-lb subscription(s), and select an available model using `PI_MODEL_ID`; this setting is independent of legacy OpenCode's model config. Pi defaults to `gpt-5.4`; use `gpt-5.6-sol` only if your pool advertises it. Do not assume the named `codex-lb-data` volume contains accounts from the previous bind mount or another Compose project—migrate/restore privately or reconnect them.
6. Mention the bot: `@Thor Read README and summarize this repository in three bullets. Reply here; do not modify files or call external write tools.` Expect a substantive in-thread reply, not merely a viewer entry. Fast runs can finish before the progress-card threshold; no progress card is not itself a failure.
7. Reply in that same thread without mentioning the bot: `What setup step should I try first?` Check that the conversation resumes. In `/admin/sessions`, its current runtime ID should start with `pi-`; the trigger viewer should show Pi model/tool history.
8. Test human ownership with a low-risk GWS command after configuring Google OAuth, `SLACK_TEAM_ID` and the Slack app's Messages Tab. The trusted requester receives a private OAuth DM without a profile-email lookup or Google mapping. Confirm the Google account/Slack recipient, connect, retry and approve as that same user. An optional `google_workspace_email` restricts account choice. Another user must not reuse that grant/result; reusing an approval must not execute again. See [Google Workspace](google-workspace.md). Read-only GWS commands still require approval.

Watch deployment logs with `docker compose -f docker-compose.yml -f docker-compose.pi.yml logs -f gateway runner remote-cli pi-executor` (append the platform override if selected). Signature errors, missing repo mapping/private allowlist, invalid Falcon credentials, unloaded AppArmor policy, unconnected model accounts, and missing Google identity are configuration failures, not reasons to bypass authorization. The deterministic tests use dummy Slack/Google/model fixtures; they do not send real Slack messages or validate real accounts.

## Configuration

The runner's Pi settings are also listed in README Deployment Configuration and `.env.example`. The override fixes `THOR_RUNTIME=pi`; ordinary Compose defaults to OpenCode.

| Variable                  | Default                     | Purpose                                                           |
| ------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `THOR_RUNTIME`            | `opencode`                  | Runner/ingress mode; override selects `pi`                        |
| `PI_EXECUTOR_URL`         | `http://pi-executor:3002`   | Credential-free private executor origin                           |
| `PI_STORAGE_PATH`         | `/var/lib/runner/pi.sqlite` | Runner-only SQLite file; use local filesystem storage             |
| `PI_MODEL_BASE_URL`       | `http://codex-lb:2455/v1`   | Standard OpenAI Responses endpoint                                |
| `PI_MODEL_ID`             | `gpt-5.4`                   | Exact model ID served by the provider                             |
| `PI_MODEL_API_KEY`        | `codex-lb-local`            | Runner-only model auth; never sent to executor                    |
| `PI_MODEL_CONTEXT_WINDOW` | `272000`                    | Model context limit for compaction/progress                       |
| `PI_SKILLS_DIR`           | `/etc/thor/skills`          | Skill catalog inside executor; image carries existing Thor skills |
| `PI_MEMORY_DIR`           | `/workspace/memory`         | Shared root/repo memory path                                      |

Use the **standard Responses API**, not the ChatGPT-specific Codex transport. Custom models must support text and tools; validate reasoning compatibility. Cost rates are not configured in this initial mode; consult codex-lb for spend rather than treating zero rate metadata as free usage.

Runner's trusted Slack SDK bypasses the agent-tool proxy policy for `slack.com`. A custom `SLACK_API_BASE_URL` may need an explicit runner-only NO_PROXY adjustment. Executor HTTP(S) uses mitmproxy; its internal network cannot directly reach public internet or codex-lb's account dashboard. Do not add executor to the default network or give it runner credentials/storage.

## Persistence and safety

- One runner owns SQLite, enforced by a Linux kernel lock (`flock`). Keep the complete SQLite/WAL files on persistent storage. Never delete `.owner` while a runner is live.
- Graceful stop leaves unfinished work pending. Reopening can retry an interrupted model request; this may incur another provider charge.
- Unsafe coding tools are not replay-safe. An interrupted shell/write may already have affected external state; the agent must reconcile that uncertainty rather than assume failure. Existing consumed approvals cannot authorize automatic write replay.
- SQLite WAL/NORMAL is tested for process crashes, **not** lossless survival of newest commits after power/host failure. For consistent backup, stop runner before snapshotting its private volume; transcripts may contain private user/tool data.
- Gateway persists uncertain batch membership and HTTP payloads until acceptance. Its `.runner-requests` manifests contain prompt/actor data; protect the queue directory like other conversation data. Retention/cleanup is not automated in this test delivery.
- Slack progress is best-effort; recovery may duplicate a notification. Viewer usage is conversation-wide, not a per-trigger cost ledger.
- Initial mode has read/write/edit/bash and explicit skills. Image reads, background subagents, lossless legacy transcript import and full browser chat parity are not implemented.

## Rollback

Stop Pi without removing volumes, then start the default configuration:

```bash
docker compose -f docker-compose.yml -f docker-compose.pi.yml stop runner pi-executor ingress
# Ensure THOR_RUNTIME is unset or opencode in the deployment environment.
docker compose -f docker-compose.yml up --build -d --remove-orphans
```

Keep `pi-state` for later reopen. OpenCode does not import Pi tasks/transcripts. Before resuming operational work, reconcile unfinished runs and uncertain external writes manually; rollback must not repeat them automatically.
