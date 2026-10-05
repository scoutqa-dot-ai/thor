# Testing Neo on Pi Durable

Pi mode embeds `@earendil-works/pi-durable` in runner. File/process tools run only in `pi-executor`; integration credentials and approvals remain in remote-cli. OpenCode is still the default deployment and is retained for rollback.

## First: isolated test, no credentials

From this worktree:

```bash
./scripts/test-pi-e2e.sh
```

Requires Docker with Compose 2.24.4+ and internet access to build images. It creates a uniquely named temporary project and named volumes, runs deterministic model/Slack/SSO/policy-wrapper fixtures, and removes its containers/volumes afterward. It does not read `.env`, reuse mounted deployment data, expose host ports, or call real accounts.

The test verifies signed Slack HTTP intake through the real gateway/disk queue into Pi, invalid-signature denial, duplicate suppression across privacy reroutes, actor attribution, in-thread replies and non-mention continuation. It also checks model/tool rounds, remote file/shell execution, wrapper session/call attribution, read-only repo mounts, runner-secret isolation, forged-trigger denial, correctly addressed Slack progress, authenticated ingress/admin/viewers, OAuth header/SSO routing and SQLite recovery after SIGKILL.

Native MCP checks now use the real broker and installed SDK HTTP server, not the
legacy wrapper replacement fixture. For offline validation, first compile current
artifacts with `pnpm build`, then set `PI_TEST_USE_CACHED_IMAGES=1`,
`MCP_TEST_BROKER_IMAGE` and `PI_TEST_{RUNNER,EXECUTOR,GATEWAY,ADMIN,INGRESS}_IMAGE`
to already prepared images. That path uses `--no-build --pull never` and current
artifacts; it neither installs dependencies nor reuses deployment data.

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
6. Mention the bot: `@Neo Read README and summarize this repository in three bullets. Reply here; do not modify files or call external write tools.` Expect a substantive in-thread reply and a ✅ reaction on that request message. Fast runs can finish before the footer appears; no footer is not itself a failure.
7. Reply in that same thread without mentioning the bot: `What setup step should I try first?` Check that the conversation resumes. In `/admin/sessions`, its current runtime ID should start with `pi-`; the trigger viewer should show Pi model/tool history.
8. Test human ownership with a low-risk GWS command after configuring Google OAuth, `SLACK_TEAM_ID` and the Slack app's Messages Tab. The trusted requester receives a private OAuth DM without a profile-email lookup or Google mapping. Confirm the Google account/Slack recipient and connect. Pi automatically continues the original task without command approval or a manual retry. An optional `google_workspace_email` restricts account choice. A newer human request or interrupt supersedes waiting work; another requester must not inherit it. Sign-in does not prove the Google operation succeeded. See [Google Workspace](google-workspace.md).

Watch deployment logs with `docker compose -f docker-compose.yml -f docker-compose.pi.yml logs -f gateway runner remote-cli pi-executor` (append the platform override if selected). Signature errors, missing repo mapping/private allowlist, invalid Falcon credentials, unloaded AppArmor policy, unconnected model accounts, and missing Google identity are configuration failures, not reasons to bypass authorization. The deterministic tests use dummy Slack/Google/model fixtures; they do not send real Slack messages or validate real accounts.

## Host-owned Slack answers

New signed Slack work with configured `SLACK_TEAM_ID` equality and successful
gateway privacy/repository admission freezes a permitted channel/thread in the
request binding. Pi publishes only nonempty text from that input's successful
native answer entry. Private destinations remain private; there is no public/root
fallback. Existing admissions, old queued/frozen requests and OpenCode keep
tool-owned replies. GitHub/cron sharing an anchor do not gain automatic posting.
Google continuations inherit the original policy/target and publish only the
resumed answer after authoritative no-wait evidence, never the paused step.

Ordinary final text is visible to the admitted audience. Explicit outbound/rich
Block Kit, canvases and requested uploads still use tools; the final answer is
a concise summary, not retransmission of an artifact. The text sink converts
common headings/bold/links to Slack mrkdwn, preserves code, chunks within Block
Kit limits and puts Model / Thinking metadata on the final chunk. Unsupported
unbreakable/over-budget output (more than 64 chunks) is rejected rather than clipped.

The existing binding stores pending, confirmed (Slack timestamp), uncertain or
rejected publication keyed by the exact answer/destination, with bounded chunk
receipts. Send intent commits before I/O. Lost receipts, process loss and partial
delivery are not automatic-repost permission; pending recovery becomes uncertain.
The authenticated trigger viewer shows this disposition separately from model
completion. Reconcile uncertain effects against the actual Slack thread/native
answer privately; there is no automated repost endpoint, delivery queue or model/
tool replay. An empty answer creates no delivery receipt. ✅ still denotes normal
turn completion, not proof of publication or Google/resource success.

## Slack activity footer

Long requests show a compact footer after a 1.5s grace, or three completed tool
calls. Its official AI mark animates beside **Neo thinking** during model work
and **Neo working** during tool execution. Visible output switches it to a still
**Neo responding** mark; Google sign-in waits stay static and do not get a check.
Completed turns react ✅ to the current request message, including thread
follow-ups and short/zero-tool turns. Normal completion also removes Neo's own 👀
acknowledgement on that exact message; other users' reactions remain. Errors,
interruption, superseded turns and Google sign-in waits do not get a completion
check. A check marks normal turn completion; read the reply for the actual
Google/provider operation outcome.

The activity footer includes the saved task's **Model** and **Thinking** values,
updated when escalation changes them, rather than a global startup-model label.
Model IDs render as plain text; provider settings and reasoning content are not
included. Historical Pi tasks use their captured native model configuration.

One request-owned presentation serializes native `agents.sessions.setStatus`
and the footer. Actual active work uses `processing`, confirmed user-action holds
use `suspended`, and settlement/stop explicitly leave processing with `active`.
Nonterminal footer changes coalesce with a readability window; output immediately
uses a still mark and terminal cleanup never waits for pacing. Restart repairs
saved footer/native state from validated facts without repeating answers/checks.
Feature/method/permission denial degrades to the existing footer/text. No blind
legacy fallback: only explicitly verified embedded transport configuration may
select the legacy method, with generic loading and a 30-second keepalive while
active. The default deployment uses the sessions method and needs no new scope,
custom identity, native stop-button subscription or automatic manifest migration.
Live workspace support/GIF playback/accessibility remain separate acceptance.

When deployment is separately authorized, rebuild `ingress`, `gateway` and `runner`, then use
the existing `docker compose up -d`. Keep `RUNNER_BASE_URL` pointed at the public
ingress HTTP(S) origin without credentials, query or fragment. Slack's image
fetcher must retrieve `/neo-thinking-v1.gif`, `/neo-working-v1.gif` and
`/neo-ai-still-v1.png` without login. Blank/invalid bases produce text-only
footers. Slack controls GIF playback/reduced motion; labels remain readable.
Artwork provenance and rights checks are in
[the design review](design-review/neo-slack-progress-assets.md).

Trusted trigger callers may supply optional `messageTs` (a Slack timestamp),
separate from the thread's `correlationKey`; the gateway supplies and freezes
the latest current-requester timestamp. Historical requests without it fall back
to the thread root. OAuth resumes retain the original human source. Pi NDJSON
frames now carry `requestId` and `sessionId`, with an additional `activity` frame
whose value is `thinking`, `working` or `responding`; it contains no reasoning
content. Request-scoped `model` observations supply `modelId` and `thinkingLevel`
from saved task state. Tool start/end frames share `toolCallId` and represent one call.

Native attach/reconnect snapshots rebuild tool accounting through a
`tools_snapshot` frame; they are not new tool-completion events. Completion
duration is fixed at settlement observation, not recomputed when history or a
duplicate is read.

Slack-request completion requires an authenticated broker answer about matching
Google waits. Confirmed waits return `status: "error", authWait: "google"` in
NDJSON (a finished model turn, not a successful task). Unavailable/non-OK,
malformed or timed-out broker responses, and receipts without a frozen
`SLACK_TEAM_ID`, return `authWait: "unconfirmed"` and a static degraded footer,
keeping eyes without a check. A previously confirmed hold cannot become success
merely because its wait disappears. Rechecking observation does not replay tools
or Slack completion effects; a newer admitted human request supersedes the hold.

## Native MCP tools

Pi installs `mcp_search` and `mcp_call` before restoring/scheduling work on the
unchanged Durable 1.0.0 runtime. Search returns live permitted tools, complete
selected schemas and revision-bound refs/cursors. Empty search gives server
summaries; use an advertised server or exact lookup to discover beyond one page.
Calls pass business arguments as JSON objects directly to the broker. Legacy MCP
wrappers and special Jira attachment/browser/Kali/Slack artifact workflows remain.
See [catalog configuration and safety](mcp-catalog.md).

Pending approval is a hold, not completed execution. Authenticated broker
observation uses a static waiting footer, suspended native status, retained eyes
and no check (`authWait: "approval"`); unavailable observation stays degraded and
non-successful. The existing signed gateway continuation carries only the authorized
minimal result disposition. Runner rereads it, checks original requester/repo/source,
and inherits the original final model and host/tool ownership. Host-owned resumes
retain the exact original private DM destination and human source, not the review
card's thread. If that frozen host destination is public or is not the confirmed
requester DM, the broker rejects generic review with actionable `review_not_supported`
**before approval intent, card or mutation**. Missing frozen ownership evidence also
requires a fresh admitted private-DM request. No target/ownership change or public
private-result publication is inferred. Tool-owned private resumes retain their
original history/thread/human source and explicit reply ownership; other tool-owned
results remain scoped to the private review conversation. Caller-selected public
destinations cannot receive the projection.
No polling tool, native waiter, provider retry or mutation re-call is introduced.

Repeated valid approval clicks reuse the same action-bound continuation admission,
including busy delivery and restart, rather than starting another model turn or
publishing another answer. Changed payload/source/requester and newer human work
deny. Legacy receipts without routing metadata retain the original native model,
thinking and full cwd; an unavailable original choice cannot be replaced by a new
pool selection.

Only one generic review operation is admitted per original request, not merely one
outstanding card. Same task/call redelivery retains the pending action; distinct calls
deny without additional intent/cards/effects even if the first already resolved before
continuation. Request additional operations in a fresh request or an authorized
continuation, never by automatically repeating a dispatched mutation. Continuation
remains conditional on the original authorization; genuine human supersession still
revokes it.

`mcp_search` may replay observational work after recovery. Every `mcp_call` remains
unsafe, regardless of MCP annotations; a remote dispatch without a committed
native result is potentially partial work, never automatic redispatch permission.
Reconcile effects with the provider before issuing distinct new work.

## Configuration

The runner's Pi settings are also listed in README Deployment Configuration and `.env.example`. The override fixes `THOR_RUNTIME=pi`; ordinary Compose defaults to OpenCode.

| Variable                   | Default                     | Purpose                                                              |
| -------------------------- | --------------------------- | -------------------------------------------------------------------- |
| `THOR_RUNTIME`             | `opencode`                  | Runner/ingress mode; override selects `pi`                           |
| `PI_EXECUTOR_URL`          | `http://pi-executor:3002`   | Credential-free private executor origin                              |
| `PI_STORAGE_PATH`          | `/var/lib/runner/pi.sqlite` | Runner-only SQLite file; use local filesystem storage                |
| `PI_MODEL_BASE_URL`        | `http://codex-lb:2455/v1`   | Standard OpenAI Responses endpoint                                   |
| `PI_MODEL_ID`              | `gpt-5.4`                   | Exact model ID served by the provider                                |
| `PI_MODEL_API_KEY`         | `codex-lb-local`            | Runner-only model auth; never sent to executor                       |
| `PI_MODEL_CONTEXT_WINDOW`  | `272000`                    | Model context limit for compaction/progress                          |
| `PI_MODEL_SUPPORTS_IMAGES` | `true`                      | Inline image input; false disables inspection for text-only backends |
| `PI_SKILLS_DIR`            | `/etc/thor/skills`          | Skill catalog inside executor; image carries existing Neo skills     |
| `PI_MEMORY_DIR`            | `/workspace/memory`         | Shared root/repo memory path                                         |

Use the **standard Responses API**, not the ChatGPT-specific Codex transport. The default GPT model supports text, tools and inline images. Custom models must support text and tools; validate reasoning compatibility and set `PI_MODEL_SUPPORTS_IMAGES=false` for text-only backends (image inspection then fails explicitly). Cost rates are not configured in this initial mode; consult codex-lb for spend rather than treating zero rate metadata as free usage.

### Task model routing

Optional `pi.modelRouting` in `/workspace/config/thor.json` defines the only allowed profile pool. A missing file or routing section falls back to `PI_MODEL_ID` for every profile, with fast/low, balanced/medium and strong/high thinking. Invalid declared configuration (including misspelled fields, invalid reasoning and invalid JSON) fails startup with a safe error; file access failures are not treated as absence. No new environment variables, provider credentials, routing LLM or live catalog probing are involved.

For distinct models, replace these **sample IDs** with exact IDs your provider actually serves:

```json
{
  "pi": {
    "modelRouting": {
      "profiles": {
        "fast": { "modelId": "example-fast-model", "thinkingLevel": "low" },
        "balanced": { "modelId": "example-balanced-model", "thinkingLevel": "medium" },
        "strong": { "modelId": "example-strong-model", "thinkingLevel": "high" }
      },
      "autoSelect": true,
      "defaultProfile": "balanced",
      "allowEscalation": true
    }
  }
}
```

Omitted profile IDs inherit `PI_MODEL_ID`; omitted effort inherits the profile default. `autoSelect=false` uses `defaultProfile` (balanced by default) for fresh tasks, with no automatic escalation. `allowEscalation=false` locks promotion. **Restart runner after pool edits.** Every registered model, including the legacy `PI_MODEL_ID`, inherits the same existing provider/transport, context window, reasoning and image contract. Select only models that satisfy it: a text-only fast model cannot share an image-capable declaration with other profiles. The runner does not independently verify live model availability.

Automatic routing is a deterministic English cue heuristic, not a semantic classifier. Investigation/security/architecture cues take precedence, coding cues select balanced, and routine lookup/summarization/Google Docs/link/file operations select fast. Unknown tasks select balanced. Ambiguous text, negated cues, other languages and historical prompt context can misclassify; the gateway supplies only the latest trusted request as routing evidence, and overrides are available for important work.

Fresh Slack request prefixes after the bot mention:

- `[profile:strong thinking:high] Investigate this incident`
- `[model:configured-id thinking:low] Create a Google document`
- `[thinking:high] Read this document`

Profiles and model IDs are mutually exclusive; effort is `minimal`, `low`, `medium` or `high`. An explicit model must belong to the configured pool. Any explicit selector or effort locks later escalation. Unknown/conflicting prefixes are rejected, not executed. Old thread directives and bystanders do not choose a new task's model.

Trusted `POST /trigger` callers use the equivalent `modelProfile` or `modelId`, optional `thinkingLevel`, and optional `routingTask` containing only the fresh task text (otherwise `prompt` is used). Frozen selection, pool, source and history are runner-owned and cannot be injected by callers. All routing fields participate in duplicate request identity; a reused ID cannot change them. A new human request gets a new selection even in the same conversation.

The native sequential `escalate_model({profile, reason})` tool is available only for automatic task promotion: fast → balanced → strong, one adjacent step per call, at most two promotions per task. It denies skips, self-loops, downgrades and explicit locks. Model/thinking and durable task history commit atomically; a crashed tool replay reuses committed evidence instead of promoting twice. The new choice applies to the next prepared response, never changes a prepared request or parallel tool execution, and cannot change cwd, tools, permissions or credentials. The prompt reports current profile/effort and the next allowed promotion.

Retries, restart recovery and Google OAuth copy the saved final selection and frozen pool; generic continuation text is never classified. Unsupported frozen resources/capabilities cannot execute a pending task: restore its supported pool or supersede an auth wait with a fresh request. Invalid evidence is preserved rather than overwritten. Completed history and duplicate results remain readable after retired models are removed; a later human task selects the new pool. Legacy receipts retain their native persisted model/thinking instead of reclassifying old prompts. Viewers show the actual task selection/source/lock/promotion history, legacy native identity and each response's native model; usage remains conversation-wide.

### Image inspection contract

`read_image(path)` reads only executor filesystem files, including Slack attachments downloaded through the existing credential-injecting workflow. It does not fetch URLs or carry Slack credentials. The separate Durable `read` remains a text-only tool.

The image-specific product safety limits are **10 MiB of encoded file bytes** and **16 million decoded pixels**. Bounded executor reads use a single opened regular file and allocate/read at most the byte limit plus one, even if the file grows; they never allocate based on a separate pathname stat. Contents must identify as PNG, JPEG, WebP or static GIF and pass full raster decoding. SVG, HTML, malformed/truncated images, animation with multiple pages and files over either limit fail visibly. Native decoding completes within its pixel bound if a turn is cancelled; cancelled results never publish image content. Viewer transcripts show an escaped image marker, not a raw image/data URL. Inline image blocks remain private conversation/model data, so protect the SQLite volume as usual.

Runner's trusted Slack SDK bypasses the agent-tool proxy policy for `slack.com`. A custom `SLACK_API_BASE_URL` may need an explicit runner-only NO_PROXY adjustment. Executor HTTP(S) uses mitmproxy; its internal network cannot directly reach public internet or codex-lb's account dashboard. Do not add executor to the default network or give it runner credentials/storage.

## Persistence and safety

- One runner owns SQLite, enforced by a Linux kernel lock (`flock`). Keep the complete SQLite/WAL files on persistent storage. Never delete `.owner` while a runner is live.
- Neo metadata now uses version 3 of `thor.pi.conversation`. Durable 1.0.0 migration preserves version-1/2 identity, model policy and authorization, explicitly freezing old replies as tool-owned. Native submissions decide execution status. Prompt copies retire only after native admission. Invalid/hybrid authority fails startup intact. Back up before upgrading; do not point an older Pi runner at migrated SQLite or assume a database downgrade is supported. The OpenCode rollback below does not read this database.
- Graceful stop leaves unfinished work pending. Reopening can retry an interrupted model request; this may incur another provider charge.
- Google auth continuation polling uses the existing internal broker URL/secret and `SLACK_TEAM_ID`. Only broker readiness matching the persisted original session/anchor/trigger/requester/workspace may resume; receipts predating workspace binding fail closed. Busy original turns defer admission. A deterministic runner-owned receipt is persisted before binding/acknowledging the broker and submitting normal Pi input. Redelivery and restart reuse that receipt; this is at-most-once admission, not exactly-once Google effects. The resumed model gets original history and the exact blocked Google argv, never a shell replay or a new broad human task.
- Auth-wait progress distinguishes a finished model turn from a completed Google operation using authenticated broker wait evidence. Missing/legacy/unavailable brokers do not authorize work; pending admissions recover when the broker returns. Polling stops and is awaited on shutdown.
- Unsafe coding tools are not replay-safe. An interrupted shell/write may already have affected external state; the agent must reconcile that uncertainty rather than assume failure. Existing consumed approvals cannot authorize automatic write replay.
- SQLite WAL/NORMAL is tested for process crashes, **not** lossless survival of newest commits after power/host failure. For consistent backup, stop runner before snapshotting its private volume; transcripts may contain private user/tool data.
- Gateway persists uncertain batch membership and HTTP payloads until acceptance. Its `.runner-requests` manifests contain prompt/actor data; protect the queue directory like other conversation data. Retention/cleanup is not automated in this test delivery.
- Slack presentation is best-effort; an activity post lost before its local timestamp can require manual cleanup. Native loading and known footer receipts are repaired on restart. Ordinary answer uncertainty never triggers automatic repost. Viewer usage is conversation-wide, not a per-trigger cost ledger.
- Pi has read/write/edit/bash, remote `read_image`, explicit skills, bounded `escalate_model` and native MCP discovery/calls. Background subagents, lossless legacy transcript import and full browser chat parity are not implemented.

## Rollback

Stop Pi without removing volumes, then start the default configuration:

```bash
docker compose -f docker-compose.yml -f docker-compose.pi.yml stop runner pi-executor ingress
# Ensure THOR_RUNTIME is unset or opencode in the deployment environment.
docker compose -f docker-compose.yml up --build -d --remove-orphans
```

Keep `pi-state` for later reopen. OpenCode does not import Pi tasks/transcripts. Before resuming operational work, reconcile unfinished runs and uncertain external writes manually; rollback must not repeat them automatically.
