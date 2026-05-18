# User-Aware Attribution

## Goal

Stamp the human who triggered a Thor run onto the artifacts it produces — best effort, never blocks:

1. `Co-authored-by: <name> <email>` trailer on agent-made commits.
2. `--assignee <github>` on agent-opened PRs (via a `gh pr edit` follow-up after creation).
3. `assignee` field on agent-created Jira issues.

The existing Thor disclaimer footer already carries a context link back to the trigger; no separate "Triggered by ..." line in the PR body is needed.

When the lookup yields nothing (unknown user, missing field, upstream rejection), the wrapper proceeds without the attribution step and the action succeeds unchanged.

## Architecture context (so the plan stays grounded)

- The agent in the sandbox runs `git` / `gh` / `mcp` via tiny opencode-cli stubs that HTTP-POST to the remote-cli service on the host with `x-thor-session-id` (`packages/opencode-cli/src/remote-cli.ts`, `docker/opencode/bin/git`).
- Remote-cli's `/exec/git`, `/exec/gh`, and `/exec/mcp` handlers run policy, mutate args if needed (see `withGhDisclaimer` at `packages/remote-cli/src/index.ts:256-275, 616` and `injectApprovalDisclaimer` at `packages/remote-cli/src/mcp-handler.ts:65, 625`), then call `execCommand` or forward to the upstream MCP. All attribution work lives in these Node handlers on the host.
- `/workspace/config.json` is already mounted read-only and loaded by remote-cli via `createConfigLoader` (`packages/common/src/workspace-config.ts:143-164`, `docker-compose.yml:133`).
- The trigger actor (Slack `event.user` / GitHub `sender.login`) is extracted today only for viewer labels at `packages/runner/src/index.ts:1416,1443`. It is not recorded in the event log and not queryable by session id.

## Scope

- Schema + helper change in `packages/common/src/workspace-config.ts`.
- Event log: capture the trigger actor (slack id / github login) on `trigger_start` so `findAnchorContext`-style lookups can return it.
- Three handler extensions in `packages/remote-cli/src/`: `/exec/git`, `withGhDisclaimer` (extend or sibling), and the MCP Jira path.
- Best-effort fallback handled by each handler.

**Scope clarification — identity is cosmetic, not authorization.** A resolved `UserRecord` never gates an action.

Out of scope:
- Per-user opt-out flags, global kill switch, automated user-registry sync.
- Multi-field identity model (`triggered_by` / `requested_by` / `acting_agent`).
- Rewriting `disclaimer.ts` to embed user identity in the footer.
- Attribution on `gh pr edit`, `gh issue create`, and other mutating surfaces beyond `gh pr create` + `git commit` + MCP `createJiraIssue`. Known gap; revisit if it bites.

## Phases

### Phase 1 — Schema + helpers

- Extend `WorkspaceConfigSchema` with optional `users: UserRecord[]`. `UserRecord = { email: string; name: string; slack?: string; github?: string }`. `email` and `name` required; `slack` and `github` optional. Schema doc comment: `email` must be the user's **Jira account email** — not a `users.noreply.github.com` alias.
- **Strict per-field validation** — these values land in commit trailers. A stray newline in `name` corrupts the trailer; a malformed `email` produces ugly Jira fields. Enforce:
  - `name` — non-empty single-line string (`/^[^\r\n]+$/`).
  - `email` — `z.email()`.
  - `slack` — Slack id shape (`/^U[A-Z0-9]{6,}$/`).
  - `github` — GitHub login shape (`/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/`).
- Add `findUserBySlack` / `findUserByEmail` / `findUserByGithub` to `workspace-config.ts`.
- Reject at validation time when two records share a normalized `slack`, normalized `github` (case-insensitive), or `email`. Duplicate identity makes attribution nondeterministic; better to fail loudly at config load than to silently mis-attribute. Note `createConfigLoader` (`workspace-config.ts:143-164`): first load with a duplicate must throw; a reload that introduces a duplicate falls back to `lastGood` and logs `config_reload_failed_using_last_good` — match the existing pattern, but the duplicate-check test must cover both cases.
- Behavior-focused tests: sample config with two users, exercise the three lookups + miss paths + duplicate rejection.
- Update README Deployment Configuration to document `users`:
  - A minimal JSON snippet (one entry with `slack`+`github`, one with `email`+`name` only).
  - "Config hot-reloads — no restart needed."
  - **Verify your entry**: after editing `config.json`, watch for `config_loaded { users: N }` (a new log event the loader emits on success). Then trigger Thor from your own Slack handle and look for `attribution_applied { outcome: "applied" }` carrying your `slack` id. If you see `skipped_no_user_record { slack: "U..." }` instead, the Slack id in your entry doesn't match the id Thor extracted from the event.
  - Link back to `docs/feat/users-directory-provenance.md` so a future operator wondering "where did this 200-entry list come from?" has the trail.
- `createConfigLoader` (`workspace-config.ts:143-164`) emits `config_loaded { users: N, ok: true }` on every successful load and on every successful reload. Trivial addition, single source of truth for "is my config live?"

Exit: `pnpm -r test` green.

### Phase 2 — Record the trigger actor on `trigger_start`

- Extend the `TriggerStartRecordSchema` (`packages/common/src/event-log.ts:56-60`) with optional `triggerSlackId?: string` and `triggerGithubLogin?: string`. Additive optional fields — backwards-compatible with existing tests that don't set them.
- **Extraction timing is the catch.** Today the runner extracts `event.user` / `sender.login` at `packages/runner/src/index.ts:1416,1443` for viewer labels — that runs at view-render time, *after* `trigger_start` is written. For this plan they need to be extracted in the inbound trigger route, **before** `appendSessionEvent` writes the `trigger_start` record. Plan-time work: factor the existing extraction into a `decodeTriggerActor(promptPayload, source)` helper used in both places (runner trigger route + viewer label render). Source of truth is the raw inbound prompt payload the gateway forwards.
- Add `findTriggerActor(sessionId): { slack?: string; github?: string } | undefined` in `packages/common/src/event-log.ts`, anchor-aware so it works for sub-sessions too:
  1. Resolve `sessionId` → anchor via the same alias path `findAnchorContext` already uses (`event-log.ts:994-1016`).
  2. Find the active trigger on that anchor (same logic as `findAnchorContext`). If none active, fall back to the most-recent `trigger_start` on the anchor regardless of `trigger_end` — long-running sub-sessions can outlive their parent trigger; attribution should still land.
  3. Return the `triggerSlackId` / `triggerGithubLogin` recorded on that trigger's `trigger_start`, or `undefined` when neither was extracted.
  Implementation is a synchronous read over the same event-log structure remote-cli already consumes; no new transport, no new I/O.
- Race note: a very fast first `/exec/git` call could arrive before the runner finishes writing `trigger_start`. That falls through to `skipped_no_trigger` and the commit proceeds unattributed — acceptable, not a bug.

Exit: a Slack-triggered run records `triggerSlackId` in the event log; a GitHub-triggered run records `triggerGithubLogin`; `findTriggerActor` returns them.

### Phase 3 — Attribution at the remote-cli Node handlers

The attribution helper:

```ts
function resolveTriggerUser(sessionId: string): UserRecord | undefined {
  const actor = findTriggerActor(sessionId);
  if (!actor) return undefined;
  const config = getConfig();
  return (actor.slack && findUserBySlack(config, actor.slack))
      ?? (actor.github && findUserByGithub(config, actor.github));
}
```

Each handler calls this and skips its mutation step on `undefined`. One structured log line per mutating call via the existing `createLogger`:
```
attribution_applied {
  surface:  "git" | "gh-assignee" | "jira",
  outcome:  "applied"
          | "skipped_no_trigger"            // findTriggerActor returned undefined
          | "skipped_no_user_record"        // actor known, no UserRecord matches
          | "skipped_missing_identity_field"// resolved user lacks the field this surface needs
          | "skipped_unsupported_arg_shape" // e.g. git commit -F
          | "skipped_amend"                 // git commit --amend
          | "api_rejected",
  reason?:  string,                         // sub-reason for skipped_missing_identity_field / api_rejected
                                            // e.g. "lookup_timeout", "lookup_no_match", "upstream_disconnected"
  field?:   "github" | "email",
  slack?:   string,                         // always present on skip outcomes when the actor had a slack id
  github?:  string,                         // always present on skip outcomes when the actor had a github login
  email?:   string                          // only set on outcomes after UserRecord resolution
}
```

**`/exec/git` handler.** Before `execCommand("git", effectiveArgs, ...)` at `index.ts:583`: if subcommand is `commit` and a user resolves, append the `Co-authored-by: <name> <email>` trailer **into the message body**, not as a `--trailer` flag. The existing `validateCommit` policy (`packages/remote-cli/src/policy-git.ts:585-604`) only allows `-m`/`-F`; `--trailer` would be rejected by Thor's own gate. Implementation: reuse the `rewriteSingleValueFlag` pattern that `withGhDisclaimer` uses (`index.ts:212-246`) to append two newlines and the trailer to the value of the last `-m`. Skipping cases:
  - `-F <path>` (commit message from file) → `skipped_unsupported_arg_shape`. Reading sandbox-side files from the host adds complexity not worth it for v1.
  - Any other subcommand (`commit --amend`, `revert`, `cherry-pick`, etc.) → not touched. `commit --amend` is technically a commit too — keep the policy: only stamp on plain `git commit`, recognise `--amend` and skip with `skipped_amend`.
  - De-dupe note: appending the trailer to the `-m` value relies on `git commit` accepting RFC-2822 trailers via `interpret-trailers` semantics. Native de-dup is **not guaranteed without `trailer.ifExists=addIfDifferent`** — on a re-run, a double trailer is possible but rare. Acceptable for v1; document.
  - `bin/git` is unchanged.

**`/exec/gh` handler.** In the `/exec/gh` route at `index.ts:616-626`, after `withGhDisclaimer` runs and `gh pr create` succeeds, run a best-effort assignee follow-up. The body itself is untouched — the disclaimer footer already includes a link to the Thor context for this trigger, so a separate "Triggered by …" line would be duplicative.

- **Do not pass `--assignee` to `gh pr create`.** Empirically, `gh pr create --assignee <bad-user>` fails the whole call. The safe path is unconditional: let `gh pr create` succeed first, parse the PR URL/number from stdout (the handler already invokes `registerIssueCorrelationAlias` at `index.ts:625`, which already has access to the PR number), then run `gh pr edit <number> --add-assignee <github>` as a follow-up. If the follow-up fails, log `api_rejected`; the PR still exists.
- When no resolved user, no `github` field, or any of the skip conditions fire: log the appropriate outcome and the PR creation goes through unchanged. No body mutation in any path.

**MCP Jira.** Extend `buildUpstreamArgs` (`mcp-handler.ts:56-66`, called from `resolveApprovalActionOnce` at `:625`) so that for `createJiraIssue` (and the equivalent direct REST shape), if a user resolves with `email`, look up the Jira `accountId` via the upstream `lookupJiraAccountId` MCP tool (already in the Atlassian MCP surface, called via `instance.upstream.callTool`) and inject `assignee` into the upstream args.

Real implementation concerns:
- `buildUpstreamArgs` is currently synchronous. Calling an upstream tool makes it `async` — `resolveApprovalActionOnce` must `await` it. The function is already inside an async context, so the change ripples but doesn't change concurrency posture.
- Bound the lookup with a 5s timeout. A slow Atlassian upstream must not stall approval resolution.
- **Service boundary / DI.** Don't reach into module globals from `buildUpstreamArgs` — pass the attribution resolver in as a dependency (`attributionResolver: (email) => Promise<accountId | undefined>`). Makes tests easy, keeps approval replay clean, and gives a single seam to mock when the Atlassian upstream is the disconnected one.
- Failure modes (all collapse to "drop the assignee, log `api_rejected` with sub-reason"): lookup tool unavailable, zero matches, multiple matches, permission denied, timeout, Atlassian upstream disconnected.

**Mutation happens after approval**, matching the existing disclaimer flow — the human approves the agent's payload, Thor stamps attribution before sending upstream. This is the same trust posture Thor already uses for the disclaimer footer; if/when that posture changes, both attributions move together.

Behavior tests (next to existing `gh-disclaimer.test.ts` and `mcp-handler.test.ts`):
- `/exec/git commit`:
  - Resolved user + `-m "msg"` → trailer appended into the `-m` value.
  - Resolved user + repeated `-m` → trailer appended into the last `-m` only.
  - `-F <path>` → passed through, `skipped_unsupported_arg_shape`.
  - `commit --amend` → passed through, `skipped_amend`.
  - No trigger / no resolved user → args byte-identical.
  - Sub-session whose parent trigger has ended → `findTriggerActor` falls back to most-recent `trigger_start`, trailer still appended.
- `/exec/gh pr create`:
  - Resolved user with `github` → `gh pr create` runs untouched (body unchanged), then `gh pr edit --add-assignee` follow-up runs and succeeds.
  - `gh pr edit --add-assignee` 422 → `api_rejected`, PR still exists.
  - No `github` field → no follow-up call; PR body and creation unchanged.
  - No resolved user → no follow-up; PR body and creation unchanged.
- MCP Jira `createJiraIssue`:
  - Resolved user with `email` → `lookupJiraAccountId` called via injected resolver, returned `accountId` lands in upstream payload.
  - Lookup times out (>5s) → assignee dropped, `api_rejected` logged with sub-reason `lookup_timeout`.
  - Lookup returns zero matches → `api_rejected` with `lookup_no_match`.
  - Atlassian upstream disconnected → `api_rejected` with `upstream_disconnected`.
  - Approval replay: the same stored `ApprovalAction` resolved twice produces deterministic args (injected resolver memoizes per action id, or the lookup is repeated and idempotent).
- Config loader:
  - Duplicate `slack` / `github` / `email` on first load → `loadWorkspaceConfig` throws with the conflict identified.
  - Duplicate introduced on reload → `lastGood` retained, `config_reload_failed_using_last_good` logged.

**Agent-facing note.** Add one paragraph to `AGENTS.md` (or the relevant agent prompt surface) under a heading like "Thor-injected attribution": Thor stamps `Co-authored-by:` trailers on commits and `assignee` fields on PRs and Jira issues created by the agent. This injection happens server-side; the trailer goes in before commit, the assignee goes in after PR creation, the Jira assignee goes in post-approval. The agent will see this content on `git log`, `gh pr view`, etc. — do not strip it, do not treat it as a user edit, do not re-emit it on re-runs. AGENTS.md rule 10 still holds: this is a warning about observable state, not an instruction.

Exit: a Slack-triggered run produces a commit with the trailer, a PR assigned to the user's GitHub handle, and a Jira ticket assigned to the user's email — without any change to `bin/git`, `bin/gh`, or anything inside the sandbox.

### Phase 4 — Seed + ship

- Copy `.context/user_registry.json` into the operator's `config.json`. Move the provenance notes (Slack export + GitHub-org reconciliation + manual overrides) to `docs/feat/users-directory-provenance.md`, then delete the `.context/` working files (`users-*.json`, `user_registry.json`, `slack_users.csv`, `test.sh`). Also sweep the untracked `users-200.json` / `users-1631.json` / `stderr.txt` at the repo root left over from extraction runs.
- Push the branch, let `core-e2e` verify, open the PR.

Exit: green push checks; PR open against `main`.

## Decision Log

| Decision | Choice | Rationale |
|---|---|---|
| Where users live | Inside existing `/workspace/config.json` under `users` | Already mounted read-only; loader already validates + hot-reloads. |
| Schema shape | `{ email, name, slack?, github? }` | `email` is the stable identity; both handles optional because not every human is in both systems. |
| Where attribution is injected | Remote-cli Node handlers (`/exec/git`, `/exec/gh`, MCP gateway) | Wrappers `bin/git`/`bin/gh` run on the host via `execCommand` but the cleanest insertion point is the Node handler one layer up, matching the existing `withGhDisclaimer` + `injectApprovalDisclaimer` patterns. |
| How the handler knows the trigger actor | Extend `trigger_start` event log + `findTriggerActor(sessionId)` | Session id is already in the HTTP header. The event log is the single source of truth. No new transport, no sandbox-side state. |
| Squash-merge survival | Not separately addressed | GitHub's squash UI drops trailers from non-primary commits. The PR assignee survives squash, and the Thor disclaimer footer (already in PR bodies) carries the context link back to the trigger. A dedicated "Triggered by …" body line was considered and rejected as duplicative. |
| Failure mode | Best effort, never block | Attribution is cosmetic. A missing record must not stop the agent. |
| MCP mutation timing | After approval | Matches existing disclaimer behaviour; changing this is a bigger trust-model conversation. |
| Resolved identity does not gate any action | Documented in Scope | Prevents future code from misusing `UserRecord` for permission decisions. |

## Risks

- **Stale `users` list.** Operators must remember to add new hires. Visible through `attribution_applied { outcome: "skipped_no_user_record" }` lines in the runner log.
- **MCP after-approval mutation.** The Jira assignee shown in the approval card does not include the injected assignee. Acceptable trade-off (same as the existing disclaimer); revisit if a reviewer is surprised.
- **Squash kills trailers.** Accepted. The `Co-authored-by` trailer is dropped on squash-merge for non-primary commits, so on `main` the human shows up only via the PR assignee and the Thor disclaimer footer's context link. Good enough for v1.
- **PII in `config.json`.** Emails sit in a mounted file that already carries GitHub installation ids and proxy auth headers; trust boundary unchanged. README must note that attribution writes name + email into commits and Jira fields — visible externally on GitHub and Atlassian.
- **Trigger actor ≠ work owner in handoff cases.** On-call triggers a deploy for a teammate's PR; Slack thread relays a request from someone else. Plan attributes to the triggerer, full stop. Multi-field model is deferred.
- **GitHub co-author linking depends on commit email.** If a user's GitHub email is set to private and their commit-recognized address is the `users.noreply.github.com` alias, the `Co-authored-by: Name <jira-email>` trailer will show the name but won't link the avatar/profile. The Jira email is still the right choice for the schema (it's the only one that resolves in Jira); GitHub linking is a partial-credit consolation prize.

## Exit Criteria

- `users[]` schema + helpers shipped and tested.
- `trigger_start` records the actor; `findTriggerActor(sessionId)` returns it.
- `/exec/git`, `/exec/gh`, and the MCP Jira path each inject attribution when a user resolves and pass through silently otherwise.
- Every mutating call emits an `attribution_applied` log line.
- README documents `users`; `.context/` artifacts moved/deleted.
- Push checks green; PR open against `main`.

## Deferred to TODOS.md

- Weekly drift scanner that aggregates `attribution_applied { outcome: "skipped_no_user_record" }`.
- Multi-field identity model (`triggered_by` / `requested_by` / `acting_agent`).
- Per-user opt-out, global kill switch, automated registry sync.
