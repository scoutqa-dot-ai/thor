# GitHub App Webhooks

**Date**: 2026-04-23
**Status**: Ready to implement

## Goal

Add GitHub App webhook intake to the gateway so Thor wakes up on PR code-flow activity, routes the event to the correct local repo, and continues the right session.

Supported events (MVP allowlist):

- `issue_comment.created` — **PR-scoped only** (filter on `issue.pull_request != null`)
- `pull_request_review_comment.created`
- `pull_request_review.submitted` — only when `review.body` is non-empty

Pure-issue `issue_comment` events (where `issue.pull_request == null`) are ignored with a structured log (`reason: "pure_issue_comment_unsupported"`) — not silently dropped. Issue triage is a separate plan.

## Current State

- `packages/gateway` handles Slack events, Slack interactivity, and cron. No GitHub route.
- `packages/runner` already supports `correlationKey`, `interrupt`, repo directory selection, and alias-based session continuity via `packages/common/src/notes.ts`.
- `packages/common/src/notes.ts` emits `computeGitAlias() → git:branch:{localRepo}:{branch}`. This is the canonical continuity key the plan reuses.
- GitHub App auth already exists in `remote-cli` for `git` / `gh` execution. Webhook intake reuses that auth via new `remote-cli` endpoints; no private-key duplication in the gateway.

## Architecture

### Runtime flow

```text
GitHub App webhook
  -> POST /github/webhook (gateway)
    -> verify X-Hub-Signature-256 on raw request bytes (timingSafeEqual)
    -> parse + normalize supported event
    -> ignore-early: unsupported event | unmapped repo | bot sender | fork PR | empty review body | pure-issue comment
    -> enqueue with correlationKey + interrupt flag (respond 200 within budget)
  -> queue handler
    -> if branch missing, resolve via remote-cli GET /github/pr-head (3s timeout + 1 retry, terminal drop on 401/403/404)
    -> triggerRunnerGitHub() -> POST /trigger { prompt, correlationKey, interrupt, directory }
      -> packages/runner
```

### Normalized event shape

```ts
interface NormalizedGitHubEvent {
  source: "github";
  deliveryId: string;        // X-GitHub-Delivery
  eventType: string;         // "issue_comment" | "pull_request_review_comment" | "pull_request_review"
  action: string;            // "created" | "submitted"
  installationId: number;
  repoFullName: string;      // e.g. "scoutqa-dot-ai/thor" (lowercased)
  localRepo: string;         // resolved local repo name
  senderLogin: string;       // lowercased
  htmlUrl: string;
  number: number;            // PR number
  body: string;              // non-empty by the time it's here
  branch: string | null;     // null means queue handler must resolve via remote-cli
  mention: boolean;          // body mentions any configured login
}
```

### Correlation model

Branch-based, single continuity key. Canonical: `git:branch:{localRepo}:{branch}`. This matches `computeGitAlias()` in `packages/common/src/notes.ts` — one format across Slack-triggered, cron-triggered, and GitHub-triggered sessions.

For PR-backed events that omit head ref in the payload (some `issue_comment` shapes), the queue handler asks remote-cli to resolve `head.ref` before dispatch. Never block the HTTP response on this lookup.

### Repo mapping (directory-name match)

No mapping config, no scan, no cache. Per webhook:

1. Parse `repository.full_name` (e.g. `scoutqa-dot-ai/thor`), take the basename (`thor`), lowercase.
2. Call existing `resolveRepoDirectory(name)` from `packages/common/src/workspace-config.ts` — already realpath-checks `/workspace/repos/<name>/`.
3. Exists → that's `localRepo`. Doesn't exist → drop with `reason: "repo_not_mapped"`.

Convention: the GitHub repo basename must match the local clone directory name. Operators who want to host `owner/foo` as `/workspace/repos/foo` get zero-config routing. If two GitHub orgs publish a repo with the same basename, the operator chooses which one lives at `/workspace/repos/<basename>/`; the other is not supported under this convention.

### GitHub App identity (single app)

One GitHub App across the whole deployment. App-level identity lives in env; per-org installation IDs live in `workspace-config.json`:

| Env var                       | Purpose                                                               | Example                                  |
| ----------------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| `GITHUB_APP_ID`               | Numeric App ID. Used as JWT `iss` claim.                              | `3387270`                                |
| `GITHUB_APP_SLUG`             | App slug. Used for mention detection + git author name.               | `thor`                                   |
| `GITHUB_APP_BOT_ID`           | Numeric bot user ID. Used for git author email.                       | `49699333`                               |
| `GITHUB_APP_PRIVATE_KEY_PATH` | PEM file path for JWT signing. Owned by remote-cli only.              | `/secrets/thor-app.pem`                  |
| `GITHUB_WEBHOOK_SECRET`       | HMAC secret for webhook verification. Owned by gateway only.          | (32+ random bytes)                       |

A new top-level `orgs` block in workspace-config holds per-org installation IDs:

```json
{
  "repos": { ... },
  "orgs": {
    "scoutqa-dot-ai": {
      "github_app_installation_id": 126669985
    }
  }
}
```

The old `github_app.installations: []` array is removed. Installation IDs are stable — they only change on uninstall/reinstall — so they sit naturally in config. When available in a webhook payload, `installation.id` is used directly without the config lookup.

### Mention detection

At gateway boot, derive the mention list once from env:

```
mentionLogins = [GITHUB_APP_SLUG, GITHUB_APP_SLUG + "[bot]"]
```

Both lowercased. Detect by word-boundary substring match on `@<login>` in the event body. No config file field. No override surface.

### Git commit identity (derived, not configured)

Bot commits must be attributed to the GitHub App so GitHub's UI shows the App avatar and the bot's activity graph:

```
git user.name  = "${GITHUB_APP_SLUG}[bot]"
git user.email = "${GITHUB_APP_BOT_ID}+${GITHUB_APP_SLUG}[bot]@users.noreply.github.com"
```

Example: `thor[bot] <49699333+thor[bot]@users.noreply.github.com>`.

Today, `packages/remote-cli/entrypoint.sh:29-30` sets identity from `GIT_USER_NAME` / `GIT_USER_EMAIL` env vars with weak defaults (`thor` / `thor@localhost`). That's the one site that needs to change:

```sh
git config --global user.name  "${GITHUB_APP_SLUG}[bot]"
git config --global user.email "${GITHUB_APP_BOT_ID}+${GITHUB_APP_SLUG}[bot]@users.noreply.github.com"
```

The `GIT_USER_NAME` and `GIT_USER_EMAIL` env vars are removed — no fallback path, no override surface. Entrypoint fails fast if `GITHUB_APP_SLUG` or `GITHUB_APP_BOT_ID` are unset.

Runtime overrides stay blocked by the existing policy layer: `validateGitArgs` in `packages/remote-cli/src/policy.ts` already rejects `git config user.name` (tested at `policy.test.ts:155`) and `git -c user.name=x` (tested at `test-e2e.sh:546`). No new enforcement needed — the identity set at entrypoint is the only identity agents can commit with.

### Filter order (gateway `/github/webhook`)

Events are rejected as early as possible with a structured log (`github_event_ignored` + `reason`) and HTTP 200 — except signature failures, which return HTTP 401:

| Order | Reason                            | Source                                                                 |
| ----- | --------------------------------- | ---------------------------------------------------------------------- |
| 1     | `signature_invalid`               | HMAC mismatch → HTTP 401                                               |
| 2     | `event_unsupported`               | Not in allowlist                                                       |
| 3     | `repo_not_mapped`                 | No local repo matches `repository.full_name`                           |
| 4     | `pure_issue_comment_unsupported`  | `issue_comment` with `issue.pull_request == null`                      |
| 5     | `fork_pr_unsupported`             | `head.repo.full_name !== base.repo.full_name`                          |
| 6     | `bot_sender`                      | `sender.type === "Bot"` or matches mention logins (self-loop guard)    |
| 7     | `empty_review_body`               | `pull_request_review.submitted` with blank body                        |

Only events that pass all 7 reach the queue.

### Interrupt rules

- Event with a bot mention in body: `interrupt: true`, `delayMs: 3000`.
- Event without a mention: `interrupt: false`, `delayMs: 60000`.

### Dedupe

`X-GitHub-Delivery` is the queue event ID. Queue overwrite coalesces in-flight retries from GitHub's 10s-timeout retry behavior. Processed deliveries are **not** remembered after ack.

**Contract**: agent actions must stay idempotent — re-processing the same event is wasted compute, not data corruption. This contract is load-bearing once any reply path is added to GitHub or Slack. Reassess dedupe then.

### Auth boundary

Gateway reads `GITHUB_WEBHOOK_SECRET` and `GITHUB_APP_SLUG`. Nothing else. The App private key stays in remote-cli (`GITHUB_APP_PRIVATE_KEY_PATH`). All installation-token minting and GitHub API calls happen in remote-cli.

One new internal remote-cli endpoint:

- `GET /github/pr-head?installation={id}&repo={full}&number={n}` — returns `{ ref, headRepoFullName }` or 404. Called by the queue handler for PR-backed events missing `head.ref`. Remote-cli mints the installation token internally using the JWT.

No private-key handling in the gateway process. No boot-time GitHub API calls.

### Installation ID lookup

Two paths:

**Webhook path.** Installation ID arrives in the payload as `installation.id`. It's part of `NormalizedGitHubEvent.installationId` and flows through the queue to remote-cli directly. Zero lookup.

**Agent-initiated path** (agent runs `gh pr create` / `git push` without a webhook context). Remote-cli:

1. Resolves `org` from the repo's origin — already done by `resolveOrgFromRemote()` at `packages/remote-cli/src/github-app-auth.ts:77`.
2. Reads `installation_id` from `config.orgs[org].github_app_installation_id` (via `loadWorkspaceConfig()`). Missing org entry → fail with a clear error naming the unconfigured org and the list of configured ones.
3. Checks the existing disk cache at `/var/lib/remote-cli/github-app/cache/<org>.json` for a fresh token (existing early-refresh logic, 5 min before `expires_at`).
4. On cache miss: mints a JWT from `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_PATH` (reuses `generateAppJWT()` at line 179), mints the installation token via `POST /app/installations/{id}/access_tokens` (reuses `mintInstallationToken()` at line 215), writes `{ token, expires_at }` to the cache file.
5. On 401/403 from token minting (installation uninstalled), unlink the cache file and re-raise with `reason: "installation_gone"`.
6. Returns the token to the git/gh wrapper via `git-askpass` / `GH_TOKEN`.

No discovery API call. Installation IDs are set once via env and don't change.

`./test.sh` verifies the JWT → mint-token → installation-scoped call chain end-to-end.

### Prompt shape for runner

Compact one-liner per event. The runner batches events sharing a correlation key; each is rendered as:

```
[{senderLogin}] {action} on {repoFullName}#{number} ({eventType}): {body}
{htmlUrl}
```

## Phases

### Phase 1 — GitHub webhook primitives

1. Add `packages/gateway/src/github.ts`:
   - `verifyGitHubSignature({ secret, rawBody: Buffer, header })` — HMAC-SHA256 over raw bytes, `crypto.timingSafeEqual` on decoded digests.
   - `GitHubWebhookEnvelopeSchema` zod schemas for the 3 allowlist events.
   - `normalizeGitHubEvent(raw, { localRepo, mentionLogins })` → `NormalizedGitHubEvent | { ignored: true, reason }`.
   - `detectMention(body, mentionLogins)` — word-boundary substring match, case-insensitive.
   - `buildCorrelationKey(localRepo, branch)` — returns `git:branch:{localRepo}:{branch}` (matches `computeGitAlias`).
2. Edit `packages/common/src/workspace-config.ts`:
   - Remove the `github_app.installations: []` array and its schema (`GitHubAppInstallationSchema`, `GitHubAppConfigSchema`).
   - Add a new top-level `orgs: z.record(z.string(), OrgConfigSchema).optional()` block. `OrgConfigSchema` holds `github_app_installation_id: z.number().int().positive()`.
   - Add `getInstallationIdForOrg(config, org): number | undefined` helper.
3. Update `packages/remote-cli/src/github-app-auth.ts`:
   - Delete `findInstallation(org)` (line 129) and `resolveInstallation()` (line 145) — both read the removed `github_app.installations` block.
   - Replace with a small helper that calls `getInstallationIdForOrg()` from the loaded workspace config. Unknown org → throw with the org name + the list of configured orgs.
   - On 401/403 from `mintInstallationToken()`, `unlinkSync(cachePath(org))` and surface as `installation_gone`.
   - `generateAppJWT()`, `mintInstallationToken()`, and the existing disk-cache logic are unchanged.
3. Remove every reference to the old `GIT_USER_NAME` / `GIT_USER_EMAIL` env vars. Derive identity from `GITHUB_APP_SLUG` + `GITHUB_APP_BOT_ID` at remote-cli boot. Concrete edits:
   - `packages/remote-cli/entrypoint.sh:29-30` — replace with derived values; fail fast if either `GITHUB_APP_SLUG` or `GITHUB_APP_BOT_ID` is unset.
   - `docker-compose.yml:37-38` — drop the `GIT_USER_EMAIL` / `GIT_USER_NAME` passthrough; add `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_BOT_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET`.
   - `.env.example:24-25` — drop the commented-out `GIT_USER_NAME` / `GIT_USER_EMAIL` entries; add the 5 new `GITHUB_APP_*` vars with placeholder values.
   - `README.md:79-80` — drop both env-var table rows; add rows for the 5 new vars plus a note about `orgs.<name>.github_app_installation_id` in workspace-config.
   - `docs/plan/2026032101_mention-interrupt.md:20,87` — historical plan references are superseded by this one. Leave as-is (historical record), but this plan's Decision Log supersedes.
   - No other code paths set git identity today. Runtime overrides stay blocked by existing policy (`validateGitArgs` at `packages/remote-cli/src/policy.ts`).

**Exit criteria:**

- [ ] HMAC verification rejects mutated-whitespace, mutated-unicode, wrong-secret, and missing-header cases.
- [ ] HMAC uses `crypto.timingSafeEqual` on Buffers of equal length.
- [ ] Allowlist zod schemas accept real payloads from GitHub fixture captures, reject off-allowlist.
- [ ] `normalizeGitHubEvent` returns `{ ignored: true, reason }` for each of: pure-issue comment, fork PR, bot sender, empty review body, unsupported action.
- [ ] Mention detection is case-insensitive and word-boundary-safe (`@thorbot` ≠ `@thor`).
- [ ] Correlation key format matches `computeGitAlias()` byte-for-byte.
- [ ] Basename resolution returns the expected `localRepo` for a known clone and rejects unknown basenames with `repo_not_mapped`.
- [ ] Missing or empty `GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_APP_BOT_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` / `GITHUB_WEBHOOK_SECRET` fails gateway and remote-cli boot with a clear error naming the missing var.
- [ ] Workspace-config with an `orgs.<name>.github_app_installation_id` that isn't a positive integer fails validation with a specific error pointing to the offending path.
- [ ] Remote-cli reads `installation_id` from `config.orgs[org].github_app_installation_id` and mints tokens into the existing disk cache. Missing org fails with a clear error naming the unconfigured org and the list of configured ones. On 401/403 from mint, the cache file is unlinked. Unit tests cover cache hit, cache miss, unknown-org, and uninstall eviction.
- [ ] `packages/remote-cli/entrypoint.sh` sets `user.name` = `${GITHUB_APP_SLUG}[bot]` and `user.email` = `${GITHUB_APP_BOT_ID}+${GITHUB_APP_SLUG}[bot]@users.noreply.github.com`.
- [ ] `grep -r GIT_USER_NAME\|GIT_USER_EMAIL` returns zero hits outside `docs/plan/` historical files.

### Phase 2 — Gateway webhook route

1. Add `POST /github/webhook` in `packages/gateway/src/app.ts`. Use Express raw-body capture (same `verify` hook pattern as Slack — parse happens once, `rawBody` Buffer kept for HMAC).
2. Reject invalid signatures with HTTP 401 before any normalization.
3. Apply the filter order above. Every ignored event gets `github_event_ignored` with `deliveryId`, `repoFullName`, `eventType`, `action`, `reason`.
4. Enqueue passing events with:
   - `id: <X-GitHub-Delivery>`
   - `source: "github"`
   - `correlationKey`: built from branch if present, else the literal marker `pending:branch-resolve:{deliveryId}` (queue handler resolves before dispatch).
   - `sourceTs`: payload timestamp if present, else request time.
   - `interrupt` + `delayMs` from mention detection.
5. Respond 200 in all non-401 cases.
6. Compute the mention-login list from `GITHUB_APP_SLUG` at gateway boot. Log it for operator visibility. No network calls.

**Exit criteria:**

- [ ] Valid allowlist webhooks enqueue with correct correlation key, interrupt flag, and delay.
- [ ] Invalid signatures return 401 without enqueueing.
- [ ] Each of the 7 filter reasons has a passing unit test that checks (a) 200/401 response as appropriate, (b) nothing enqueued, (c) structured log emitted with `reason`.
- [ ] Form-encoded webhook payloads (GitHub supports `application/x-www-form-urlencoded`) pass HMAC and still normalize correctly.
- [ ] Mention-login list is resolved at boot and visible in logs.
- [ ] Gateway never touches the App private key.

### Phase 3 — Runner dispatch

1. Add `GitHubQueuedEvent` handling in the `EventQueue` handler in `app.ts`, symmetric to `SlackQueuedEvent` / `CronQueuedEvent`.
2. Add `triggerRunnerGitHub(events, correlationKey, runnerDeps, hasInterrupt, ack, reposMap, reject)` in `packages/gateway/src/service.ts`.
3. Before dispatch, if any event has `pending:branch-resolve:*` as its correlation key, call remote-cli `GET /github/pr-head` (3s timeout, one retry). On 401/403/404 or final timeout, reject with `reason: "installation_gone"` or `"branch_unresolved"` — terminal drop, no further retries.
4. Once branch is resolved, rewrite the correlation key to `git:branch:{localRepo}:{branch}` and batch events by key.
5. Resolve local repo directory via `resolveRepoDirectory(localRepo)` from `workspace-config.ts`.
6. Render each event with the compact one-liner template. Concatenate with `\n\n` as the prompt. Cap at 8KB — if exceeded, truncate oldest events first, log `github_prompt_truncated`.
7. Preserve busy-session semantics: mention events can interrupt, non-mention events defer until the runner accepts.

**Exit criteria:**

- [ ] Mention events interrupt busy sessions for the same `git:branch:*` key.
- [ ] Non-mention events defer and retry until the runner accepts.
- [ ] Runner receives requests with correct `directory` (from local repo map) and `correlationKey` (canonical branch form).
- [ ] Burst of 10 review comments in 30s coalesces into one dispatch, preserving mention-interrupt precedence when interleaved.
- [ ] Branch resolution via remote-cli succeeds for PR-scoped `issue_comment` lacking `head.ref`.
- [ ] Installation-gone (401/403/404) and branch-unresolved terminal drops have unit tests and do not loop.
- [ ] Prompt size cap works; truncation log fires on a 50-event burst.

### Phase 4 — Operator runbook

1. Update `docs/examples/workspace-config.example.json` — remove the `github_app.installations` block; show the new top-level `orgs` block with a single example entry: `{"orgs": {"scoutqa-dot-ai": {"github_app_installation_id": 126669985}}}`.
2. Write `docs/github-app-webhooks.md` with:
   - **Env var matrix** — `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_BOT_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATIONS`, `GITHUB_WEBHOOK_SECRET`. Where each value lives in GitHub's UI (App settings page for the first four; the Install page URL for `installation_id`; the webhook settings for the secret).
   - **Permission matrix** — `issues: read`, `pull_requests: read`, `contents: read`, `metadata: read`.
   - **Event subscriptions** — "Issue comment", "Pull request review", "Pull request review comment".
   - **Webhook URL format** — `https://<gateway-host>/github/webhook`.
   - **Secret rotation** — procedure with overlap window and a verify-next-delivery check.
   - **Local dev** — `smee.io` forwarding recipe.
   - **Troubleshooting table** — one row per `reason` in the filter-order table, with "what it means" and "how to fix."
3. Boot log includes the resolved mention-login list and the bot git identity so operators can verify at a glance.

**Exit criteria:**

- [ ] An operator who has never seen Thor can set up their first webhook end-to-end from the doc in under 15 minutes.
- [ ] The troubleshooting table covers every `github_event_ignored` reason.
- [ ] Workspace-config has exactly one GitHub field: `orgs.<name>.github_app_installation_id`. App-level identity is env-only.
- [ ] Boot log shows the resolved mention-login list and the bot git identity. Docs explain the `basename-must-match-local-dir` convention.

## Decision Log

| #   | Decision                                                                       | Rationale                                                                                                                                    |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Reuse `packages/gateway` for GitHub webhook intake                             | Gateway already owns signed external event intake, queueing, and runner dispatch.                                                            |
| 2   | Narrow allowlist — 3 events, PR-scoped only                                    | Keeps the trigger surface predictable and tests tractable; pure-issue and non-code-flow events route through a future issue-triage plan.     |
| 3   | Normalize payloads before prompting the runner                                 | Smaller prompts, clearer tests, no GitHub-schema coupling in the runner.                                                                     |
| 4   | Map `repository.full_name` → local repo by basename match against `/workspace/repos/<name>/` | Zero config, zero scan, zero cache. Operators already clone to the basename; webhook routing reuses that convention.                         |
| 5   | Single-App, env-sourced identity + per-org `github_app_installation_id` in config.orgs | App-level identity (id, slug, bot_id, private key, webhook secret) is env; installation IDs are per-org in workspace-config. Installation IDs are stable and human-readable from GitHub's UI, so they belong in config; app-level secrets/identity belong in env. |
| 6   | Gateway reads webhook secret + slug only; remote-cli owns App private key      | Single owner for JWT signing + installation-token minting; gateway stays signature-verification + routing.                                   |
| 5b  | Bot git identity derived from slug + bot ID; config override disallowed        | Prevents drift between App identity and commit attribution. GitHub displays bot-authored commits correctly only with the derived format.     |
| 7   | Canonical correlation key is `git:branch:{localRepo}:{branch}`                 | Matches existing `computeGitAlias()` output — one continuity format across all intake sources.                                               |
| 8   | Branch resolution happens in the queue handler, not the HTTP path              | GitHub's 10s webhook budget cannot absorb installation-token mint + API lookup under load.                                                   |
| 9   | Terminal drop on 401/403/404 from branch lookup                                | App uninstalled or repo gone — retries would loop forever.                                                                                   |
| 10  | Fork PRs dropped with explicit `reason: "fork_pr_unsupported"`                 | Fork head branches don't exist in local checkouts; supporting them requires a separate plan.                                                 |
| 11  | Bot-authored events dropped (self-loop guard)                                  | Prevents Thor-on-Thor loops and Dependabot noise.                                                                                            |
| 12  | Empty-body `pull_request_review.submitted` ignored with structured log         | "Approved with no comment" is not an agent trigger; match the Slack `event_ignored_*` pattern.                                               |
| 13  | Pure-issue `issue_comment` ignored with structured log                         | Issue triage is a future plan; ignoring loudly beats silent drops.                                                                           |
| 14  | Queue-overwrite dedupe only; no persistent delivery-ID store                   | MVP agent actions are read-only or worktree-local; double-processing is wasted compute, not corruption. Reassess when a reply path is added. |
| 15  | Mention detection is body-text substring match                                 | GitHub has no dedicated "bot mentioned" webhook; body-scan is the only signal.                                                               |
| 16  | Compact one-liner prompt shape per event                                       | Keeps token budget predictable; runner can fetch more via `gh` when needed.                                                                  |
| 17  | `X-GitHub-Delivery` is the queue event ID                                      | Best available dedupe key for webhook deliveries; aligns with the existing queue overwrite model.                                            |

## Out of Scope

- Replying back to GitHub (issues, PRs, reviews) from Thor.
- Slack progress mirroring for GitHub-originated sessions.
- Full GitHub webhook coverage beyond the 3-event MVP allowlist.
- Issue triage via `git:issue:{repo}:{number}` correlation.
- Fork PR support.
- Monorepo / multi-workdir-per-repo topologies.
- Backfilling historical GitHub activity.
- Durable replay-prevention storage (reassess when a reply path is added).
