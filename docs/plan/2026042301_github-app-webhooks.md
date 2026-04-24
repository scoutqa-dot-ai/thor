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

### Repo mapping (inferred, not configured)

No `full_names` config. At gateway boot (and on config reload):

1. Scan `/workspace/repos/*/`.
2. For each repo dir, run `git -C <dir> remote get-url origin`, parse to `owner/name`, lowercase.
3. Build `githubFullName -> localRepo` map in memory.
4. Log `github_repo_mapping` entries on boot so operators can verify.
5. If two local repos resolve to the same GitHub full name, fail boot with a clear error.

Webhooks for unmapped repos (repo not cloned, parse failure, etc.) are ignored with `reason: "repo_not_mapped"`.

### Mention detection (inferred, not configured)

No `mention_logins` config by default. At gateway boot:

1. Call `GET /app` via remote-cli using the installed App's JWT.
2. Read `slug`, build default mention list: `[slug, slug + "[bot]"]`, all lowercased.
3. Detect mentions by word-boundary substring match on `@<login>` in normalized `body`.

Optional override: `repos.<name>.github_mention_logins: string[]` in workspace-config, lowercased at load. Used only when an operator wants extra identities (multi-app, legacy user-bot handle, etc.).

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

Gateway holds **only** the webhook secret (`GITHUB_WEBHOOK_SECRET` env). All installation-token minting and GitHub API calls stay in `remote-cli`, which already owns the App private key via `github_app.installations`. Gateway calls two new internal remote-cli endpoints:

- `GET /github/app` — returns `{ slug, name }` for the configured App. Called once at boot.
- `GET /github/pr-head?installation={id}&repo={full}&number={n}` — returns `{ ref, headRepoFullName }` or 404. Called by the queue handler for PR-backed events missing `head.ref`.

No private-key handling in the gateway process.

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
2. Add `packages/gateway/src/github-mapping.ts`:
   - `scanGitHubRepoMap(reposRoot)` — shells out to `git -C <dir> remote get-url origin`, returns `Map<fullName, localRepo>`.
   - Fails with a clear error if two local repos resolve to the same GitHub full name.
3. Extend `packages/common/src/workspace-config.ts` with optional `repos.<name>.github_mention_logins: string[]`.

**Exit criteria:**

- [ ] HMAC verification rejects mutated-whitespace, mutated-unicode, wrong-secret, and missing-header cases.
- [ ] HMAC uses `crypto.timingSafeEqual` on Buffers of equal length.
- [ ] Allowlist zod schemas accept real payloads from GitHub fixture captures, reject off-allowlist.
- [ ] `normalizeGitHubEvent` returns `{ ignored: true, reason }` for each of: pure-issue comment, fork PR, bot sender, empty review body, unsupported action.
- [ ] Mention detection is case-insensitive and word-boundary-safe (`@thorbot` ≠ `@thor`).
- [ ] Correlation key format matches `computeGitAlias()` byte-for-byte.
- [ ] Repo map scan returns correct `{ fullName → localRepo }` entries and fails boot on collisions.

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
6. Call `scanGitHubRepoMap` and `GET /github/app` once at gateway boot. Log the resulting map and mention-login list.

**Exit criteria:**

- [ ] Valid allowlist webhooks enqueue with correct correlation key, interrupt flag, and delay.
- [ ] Invalid signatures return 401 without enqueueing.
- [ ] Each of the 7 filter reasons has a passing unit test that checks (a) 200/401 response as appropriate, (b) nothing enqueued, (c) structured log emitted with `reason`.
- [ ] Form-encoded webhook payloads (GitHub supports `application/x-www-form-urlencoded`) pass HMAC and still normalize correctly.
- [ ] Repo map and mention-login list are resolved at boot and visible in logs.
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

1. Update `docs/examples/workspace-config.example.json` — show the optional `github_mention_logins` override with a comment explaining when to use it.
2. Write `docs/github-app-webhooks.md` with:
   - **Permission matrix** — `issues: read`, `pull_requests: read`, `contents: read`, `metadata: read`.
   - **Event subscriptions** — "Issue comment", "Pull request review", "Pull request review comment".
   - **Webhook URL format** — `https://<gateway-host>/github/webhook`.
   - **Secret env** — `GITHUB_WEBHOOK_SECRET`.
   - **Secret rotation** — procedure with overlap window and a verify-next-delivery check.
   - **Local dev** — `smee.io` forwarding recipe.
   - **Troubleshooting table** — one row per `reason` in the filter-order table, with "what it means" and "how to fix."
3. Boot log includes the resolved repo map and mention-login list so operators can verify at a glance.

**Exit criteria:**

- [ ] An operator who has never seen Thor can set up their first webhook end-to-end from the doc in under 15 minutes.
- [ ] The troubleshooting table covers every `github_event_ignored` reason.
- [ ] Example config has zero required GitHub fields.
- [ ] Boot log shows the full `{fullName → localRepo}` map and mention-login list.

## Decision Log

| #   | Decision                                                                       | Rationale                                                                                                                                    |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Reuse `packages/gateway` for GitHub webhook intake                             | Gateway already owns signed external event intake, queueing, and runner dispatch.                                                            |
| 2   | Narrow allowlist — 3 events, PR-scoped only                                    | Keeps the trigger surface predictable and tests tractable; pure-issue and non-code-flow events route through a future issue-triage plan.     |
| 3   | Normalize payloads before prompting the runner                                 | Smaller prompts, clearer tests, no GitHub-schema coupling in the runner.                                                                     |
| 4   | Infer local repo mapping from `git remote get-url origin` — no config required | The mapping already exists on disk; requiring operators to duplicate it in config is drift-prone.                                            |
| 5   | Infer `mention_logins` from `GET /app` — optional override only                | App slug is authoritative; operators override only for multi-app or legacy handles.                                                          |
| 6   | Gateway holds webhook secret only; remote-cli owns App private key             | Single owner for installation-token minting; gateway stays signature-verification + routing.                                                 |
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
