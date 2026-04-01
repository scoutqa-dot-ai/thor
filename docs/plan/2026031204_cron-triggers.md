# Cron / Scheduled Triggers — 2026-03-12-04

> Add a `POST /cron` endpoint to the gateway so that external schedulers (OS crontab, Railway cron, k8s CronJob) can trigger scheduled agent runs via HTTP.

## Context

Thor is event-driven: Slack mentions and GitHub webhooks enter via the gateway, get enqueued in the EventQueue with a correlation key and batch delay, and are dispatched to the runner. The mvp.md spec defines cron as a third trigger source with:

- Correlation key format: `cron:{md5(prompt)}:{epoch}` — each invocation gets a unique session
- **Immediate** debounce (no batching — each tick is a standalone event)
- Use cases: PostHog error spike detection (every 6h), daily codebase health digest

This plan adds a `POST /cron` HTTP endpoint to the gateway. Scheduling runs in a lightweight Alpine cron container. The crontab lives on a shared volume that OpenCode can edit at runtime — ~~BusyBox crond re-reads the crontab on every wake cycle, so changes take effect within one minute~~ supercronic watches via inotify for instant reload (D11). No in-process scheduler, no new Node dependencies.

## Decision Log

| #   | Decision                                                     | Rationale                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **External cron + HTTP request to gateway**                  | No in-process scheduler needed. Works with any platform's cron (crontab, Railway, k8s CronJob, systemd timer). Zero new dependencies. Gateway stays a pure event ingress.                                                                            |
| D2  | **`POST /cron` endpoint on gateway, not directly to runner** | Keeps gateway as the single entry point. Gets EventQueue's per-key serialization for free — overlapping cron ticks for the same job won't race.                                                                                                      |
| D3  | **Caller provides `prompt` directly in the request body**    | No job registry, no prompt files. The crontab is the single source of truth for what runs and when.                                                                                                                                                  |
| D4  | **Cron events use `source: "cron"` in EventQueue**           | Follows the existing pattern (slack, github). The queue handler dispatches based on source type.                                                                                                                                                     |
| D5  | **Immediate dispatch (delayMs: 0)**                          | Per mvp.md spec. Cron events don't batch — each tick fires independently.                                                                                                                                                                            |
| D6  | **Correlation key: `cron:{md5(prompt)}:{epoch}`**            | md5 of the prompt groups related runs; epoch ensures each invocation gets its own session. Always auto-derived — no override needed.                                                                                                                 |
| D7  | **No `--slack` flag — prompt instructs the agent**           | The prompt itself tells the agent where to post results (Slack, Jira, etc.) via MCP tools. No special gateway plumbing for output routing.                                                                                                           |
| D8  | **`CRON_SECRET` required — fail fast if unset**              | `POST /cron` always requires `Authorization: Bearer <CRON_SECRET>`. If the env var is not configured, the endpoint returns 401 immediately. No permissive mode.                                                                                      |
| D9  | **Crontab on shared volume, not baked into image**           | `docker-volumes/workspace/cron/` is mounted **rw in OpenCode** and **ro in the cron container**. OpenCode can add/edit/remove jobs at runtime. ~~BusyBox crond re-reads the crontab every wake cycle — no reload signal needed.~~ Superseded by D11. |
| D10 | **`hey-thor` CLI baked into image, not on volume**           | The CLI is stable infrastructure; the crontab is the dynamic part. CLI in image, config on volume.                                                                                                                                                   |
| D11 | **Switch from BusyBox crond to supercronic**                 | [supercronic](https://github.com/aptible/supercronic) is designed for containers: no spool directory, no root required, watches crontab via inotify for instant reload. Replaces `crond -f` and the poll-based entrypoint.                           |
| D12 | **Run as non-root (`USER thor`)**                            | supercronic doesn't need root. Dockerfile creates `thor` (UID 1001) and switches to it before entrypoint. Reduces container attack surface.                                                                                                          |

## Phases

### Phase 1 — `POST /cron` endpoint + cron event type

**Goal**: Add a `POST /cron` endpoint to the gateway that validates the request, derives a correlation key, and enqueues a cron event into the EventQueue.

Steps:

1. Create `packages/gateway/src/cron.ts`:
   - Zod schema for the request body:
     ```ts
     {
       prompt: string; // the agent prompt for this run
     }
     ```
   - `deriveCronCorrelationKey(prompt: string): string` — returns `cron:{md5(prompt)}:{epoch}`
   - `CronPayload` type for the queued event payload: `{ prompt }`
2. Add `POST /cron` route in `app.ts`:
   - Require `Authorization: Bearer <CRON_SECRET>` — return 401 if `CRON_SECRET` is not configured or token is wrong
   - Parse and validate request body
   - Derive correlation key from prompt
   - Enqueue with `source: "cron"`, `delayMs: 0`, `readyAt: Date.now()`
   - Return `200 { ok: true, correlationKey }` or `400`/`401` on error
3. Add `cronSecret` to `GatewayAppConfig`
4. Unit tests:
   - Valid request → enqueues event with correct correlation key, source, and payload
   - Missing `prompt` → 400
   - `CRON_SECRET` not configured → 401
   - Wrong/missing auth → 401

**Exit criteria**:

- `POST /cron` accepts requests, validates, enqueues
- Correlation key format is `cron:{md5}:{epoch}`
- Auth required — fails fast when `CRON_SECRET` is unset
- All unit tests pass

---

### Phase 2 — Queue handler dispatch + `triggerRunnerCron()`

**Goal**: Wire cron events through the queue handler to the runner.

Steps:

1. Add `CronQueuedEvent` type and `isCronEvent()` guard in `app.ts` (following slack/github pattern)
2. Add `triggerRunnerCron()` in `service.ts`:
   - Builds runner request from the cron payload: `{ prompt, correlationKey }`
   - POSTs to runner `/trigger`
   - Consumes response stream silently (the prompt itself instructs the agent where to post results)
3. Update queue handler in `createGatewayApp()`:
   - Add `const cronEvents = events.filter(isCronEvent)` block
   - Dispatch to `triggerRunnerCron()` with logging (same pattern as slack/github)
4. Integration test: POST to `/cron` → flush queue → verify runner receives trigger with correct prompt and correlation key

**Exit criteria**:

- Cron events flow: `POST /cron` → EventQueue → handler → runner `/trigger`
- Response stream consumed silently, no errors
- `triggerRunnerCron()` unit test verifies correct runner call
- Integration test passes

---

### Phase 3 — `hey-thor` CLI + cron container

**Goal**: Create a `hey-thor` bash CLI that wraps the `POST /cron` call, so the crontab reads like config. Set up a lightweight cron container with volume-mounted config that OpenCode can edit at runtime.

#### Volume layout

```
docker-volumes/workspace/cron/     ← shared volume
└── crontab                        ← schedule definitions with inline prompts
```

Mount permissions:

- **OpenCode**: `/workspace/cron` → **rw** (can add/edit/remove jobs)
- **Cron container**: `/workspace/cron` → **ro** (only reads crontab)

~~BusyBox crond re-reads the crontab on every wake cycle — no reload needed. OpenCode edits the file, next minute tick picks it up.~~ Superseded by D11 — supercronic watches via inotify.

#### `hey-thor` CLI

A shell script baked into the cron image at `/usr/local/bin/hey-thor`:

```
hey-thor "<prompt>"
```

Behavior:

- Takes the prompt as a direct argument (no prompt files)
- Builds JSON payload with jq, POSTs to `$GATEWAY_URL/cron` with `Authorization: Bearer $CRON_SECRET`
- Exits 0 on success, non-zero on failure

#### Crontab

`docker-volumes/workspace/cron/crontab` — clean, readable:

```crontab
0 */6 * * *  hey-thor "Check PostHog for error rate spikes in the last 6 hours. ... Post findings to #acme-general on Slack."
0 9 * * 1-5  hey-thor "Generate a daily codebase health digest: ... Post a concise summary to #acme-general on Slack."
```

#### Container

`docker/cron/Dockerfile` — ~~alpine + curl + jq + crond~~ alpine + curl + jq + supercronic (D11):

- Copies `hey-thor` to `/usr/local/bin/` (baked into image)
- ~~Entrypoint: installs `/workspace/cron/crontab` into crond, then runs `crond -f` (foreground)~~ Entrypoint: `exec supercronic -inotify /workspace/cron/crontab` (D11)
- ~~Crontab is re-read from the volume on each wake — no image rebuild to change schedule~~ Crontab changes detected instantly via inotify (D11), runs as non-root `thor` user (D12)

Steps:

1. Create `docker/cron/hey-thor` shell script
2. ~~Create `docker/cron/entrypoint.sh` — installs crontab from volume, starts crond~~ Create `docker/cron/entrypoint.sh` — runs supercronic (D11)
3. Create `docker/cron/Dockerfile`
4. Seed initial crontab in `docker-volumes/workspace/cron/crontab`
5. Update `packages/gateway/src/index.ts`:
   - Read `CRON_SECRET` from env, pass to `GatewayAppConfig`
6. Update `docker-compose.yml`:
   ```yaml
   cron:
     build:
       context: ./docker/cron
     restart: unless-stopped
     environment:
       - GATEWAY_URL=http://gateway:3002
       - CRON_SECRET=${CRON_SECRET}
     volumes:
       - ./docker-volumes/workspace/cron:/workspace/cron:ro
     depends_on:
       gateway:
         condition: service_healthy
   ```
7. Add OpenCode cron volume mount (rw):
   ```yaml
   # in opencode service volumes:
   - ./docker-volumes/workspace/cron:/workspace/cron
   ```

**Exit criteria**:

- `hey-thor "Check for errors and post to #acme-general on Slack"` triggers a full cron run end-to-end
- Cron container starts and runs jobs on schedule
- OpenCode can edit `/workspace/cron/crontab` and changes take effect within 1 minute
- Adding a new job = one crontab line (no rebuild, no extra files)

---

## Example Schedules

The crontab at `docker-volumes/workspace/cron/crontab` is the single source of truth. Each line is a standard cron expression followed by a `hey-thor` invocation. Available upstream MCP servers via proxy: **GitHub** (port 3013), **Atlassian** (port 3010), **PostHog** (port 3011), **Slack** (port 3012), **Git** (port 3014).

```crontab
# ── Daily Brief (weekdays 9:15 AM VN time / 2:15 UTC) ──────────────────────
15 2 * * 1-5  hey-thor "Generate a Daily Brief for the Acme team. Include: (1) What shipped — list PRs merged in acme/acme-project in the last 24h with PR number, title, and author. (2) Heads up — find Jira issues in the Acme project that are urgent or due within 3 days but still in Backlog/Todo; flag open PRs older than 2 days with no review. (3) Action items — based on overdue issues and stale PRs, tag the assignee with specific asks. (4) Product pulse — query PostHog for yesterday's visitor count, signup count, execution count, and agent completion rate; compare to the day before and show trend arrows. (5) Quick wins — small PRs (<100 lines) ready for review. Format with Slack mrkdwn, use emoji section headers. Keep it to one concise message. Post to #acme-general on Slack."

# ── Error Spike Monitor (every 6 hours) ─────────────────────────────────────
0 */6 * * *  hey-thor "Check PostHog for error rate spikes in the last 6 hours. If any endpoint shows >20% increase in error rate, investigate recent GitHub merges in acme/acme-project for likely causes. Post findings with links to the relevant PRs and PostHog error details to #acme-general on Slack."

# ── Stale PR Reminder (weekdays 4 PM VN time / 9:00 UTC) ────────────────────
0 9 * * 1-5  hey-thor "Find all open PRs in acme/acme-project that have had no review activity in the last 48 hours. For each, mention the PR author and requested reviewers. Sort by age, oldest first. Post to #acme-general on Slack."

# ── Weekly Initiative Health (Monday 9:30 AM VN / 2:30 UTC) ─────────────────
30 2 * * 1  hey-thor "Generate a weekly initiative health report. For each active Jira initiative in the Acme project: show % complete, issues closed vs remaining this week, and any blockers. Cross-reference with GitHub — flag initiatives where no PRs were merged in the past 7 days. Post to #acme-general on Slack."
```

### Prompt Design Guidelines

- **Include output destination in the prompt** — "Post to #acme-general on Slack" or "Create a Jira issue in the Acme project". The agent uses MCP tools to deliver results — no special gateway plumbing needed.
- **Be specific about data sources** — name the GitHub repo, Jira project, Slack channel, or PostHog event explicitly so the agent doesn't guess.
- **Define the output format** — "Slack mrkdwn", "one message", "bullet points" prevents the agent from dumping raw data.
- **Include thresholds** — ">20% increase", "older than 2 days", "<100 lines" give the agent clear decision criteria.
- **Time-window the query** — "last 24h", "last 6 hours", "past 7 days" prevents unbounded data fetches.

---

## Out of Scope

- **In-process scheduler** — scheduling is the platform's job, not ours
- **Job registry or CRUD API** — jobs are defined in the crontab
- **Prompt files** — prompts are inline in the crontab via `hey-thor`
- **Distributed scheduling / leader election** — single cron container assumed
- **Job history / run tracking UI** — worklog notes are sufficient for now
- **Retry on failure** — if the gateway is down, the cron tick is lost (acceptable for MVP; platform-level retry can be added later)
- **Approval workflow for cron results** — cron runs use the same proxy policies as any agent run

## Dependencies

| Dependency         | Version | Purpose                   | Status   |
| ------------------ | ------- | ------------------------- | -------- |
| `@thor/common`     | —       | Logging, progress events  | Existing |
| EventQueue         | —       | Event ingestion (gateway) | Existing |
| Runner /trigger    | —       | Agent execution endpoint  | Existing |
| alpine + curl + jq | —       | Cron container base       | System   |
| supercronic        | v0.2.44 | Container-friendly cron   | System   |
