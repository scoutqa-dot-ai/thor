# User-Aware Attribution

## Goal

Stamp the human who triggered a Thor run onto the artifacts it produces — best effort, never blocks:

1. `Co-authored-by: Name <email>` trailer on agent-made commits.
2. `--assignee <github>` on agent-opened PRs (set on `gh pr create` when unset).
3. `assignee_account_id` on agent-created Jira issues (resolved from user email when unset).

The existing Thor disclaimer footer already carries a context link back to the trigger; no separate "Triggered by ..." line in the PR body is needed.

When the lookup yields nothing (unknown user, missing field, upstream rejection), the wrapper proceeds without the attribution step and the action succeeds unchanged.

## Architecture context (so the plan stays grounded)

- The agent in the sandbox runs `git` / `gh` / `mcp` via tiny opencode-cli stubs that HTTP-POST to the remote-cli service on the host with `x-thor-session-id` (`packages/opencode-cli/src/remote-cli.ts`, `docker/opencode/bin/git`).
- Remote-cli's `/exec/git`, `/exec/gh`, and `/exec/mcp` handlers run policy, mutate args if needed (see `withGhDisclaimer` at `packages/remote-cli/src/index.ts:256-275, 616` and `injectApprovalDisclaimer` at `packages/remote-cli/src/mcp-handler.ts:65, 625`), then call `execCommand` or forward to the upstream MCP. All attribution work lives in these Node handlers on the host.
- `/workspace/config.json` is already mounted read-only and loaded by remote-cli via `createConfigLoader` (`packages/common/src/workspace-config.ts:143-164`, `docker-compose.yml:133`).
- The trigger actor (Slack `event.user` / GitHub `sender.login`) is extracted today only for viewer labels at `packages/runner/src/index.ts:1416,1443`, by decoding the inbound trigger's prompt body after it has been echoed back through OpenCode. It is not recorded in the event log and not queryable by session id.

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
- **Minimal field validation** — `users[]` is internal operator-maintained config, so trust the configured values beyond the existing required string/email checks. Keep shape validation light and let downstream services reject bad handles if operators misconfigure them.
- Add `findUserBySlack` / `findUserByEmail` / `findUserByGithub` to `workspace-config.ts`.
- Reject at validation time when two records share a normalized `slack`, normalized `github` (case-insensitive), or `email`. Duplicate identity makes attribution nondeterministic; better to fail loudly at config load than to silently mis-attribute. Note `createConfigLoader` (`workspace-config.ts:143-164`): first load with a duplicate must throw; a reload that introduces a duplicate falls back to `lastGood` and logs `config_reload_failed_using_last_good` — match the existing pattern, but the duplicate-check test must cover both cases.
- Behavior-focused tests: sample config with two users, exercise the three lookups + miss paths + duplicate rejection.
- Update README Deployment Configuration to document `users`:
  - A minimal JSON snippet (one entry with `slack`+`github`, one with `email`+`name` only).
  - "Config hot-reloads — no restart needed."
  - **Verify your entry**: after editing `config.json`, trigger Thor from your own Slack handle and look for `attribution_applied { outcome: "applied" }` carrying your `slack` id. If you see `skipped_no_user_record { slack: "U..." }` instead, the Slack id in your entry doesn't match the id Thor extracted from the event. (No new "config loaded" log: `createConfigLoader` re-reads on every call, so emitting per-load would spam the log without telling the operator anything they can't see from `attribution_applied` on the next trigger.)
  - Link back to `docs/feat/users-directory-provenance.md` so a future operator wondering "where did this 200-entry list come from?" has the trail.

Exit: `pnpm -r test` green.

### Phase 2 — Record the trigger actor on `trigger_start`

- Extend the `TriggerStartRecordSchema` (`packages/common/src/event-log.ts:56-60`) with optional `triggerSlackId?: string` and `triggerGithubLogin?: string`. Additive optional fields — backwards-compatible with existing tests that don't set them.
- **Extraction timing is the catch.** Today the runner extracts `event.user` / `sender.login` at `packages/runner/src/index.ts:1416,1443` for viewer labels — that runs at view-render time, _after_ `trigger_start` is written. Actor extraction now belongs in gateway, where Slack/GitHub source payloads and chronological batch order are still explicit. Gateway passes the last available actor to runner as `triggerSlackId` or `triggerGithubLogin`; dispatch planning only carries explicit actor fields through. Runner treats those fields as optional trigger metadata and writes them to `trigger_start` without parsing source-specific prompt JSON.
- Add `findTriggerActor(sessionId): { slack?: string; github?: string } | undefined` in `packages/common/src/event-log.ts`, anchor-aware so it works for sub-sessions too:
  1. Resolve `sessionId` → anchor via the same alias path `findAnchorContext` already uses (`event-log.ts:994-1016`).
  2. Find the active trigger on that anchor (same logic as `findAnchorContext`). If none active, fall back to the most-recent `trigger_start` on the anchor regardless of `trigger_end` — long-running sub-sessions can outlive their parent trigger; attribution should still land. **Known mis-attribution risk:** if trigger A ends, trigger B starts on the same anchor, and a sub-session of A then writes a commit, that commit is attributed to B's triggerer. Accepted for v1 — attribution is cosmetic, the alternative (no attribution) is worse, and the fact that "most recent on this anchor" gets the credit is at worst surprising, never a safety issue. Re-evaluate if multi-trigger overlap on one anchor becomes common.
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
  return (
    (actor.slack && findUserBySlack(config, actor.slack)) ??
    (actor.github && findUserByGithub(config, actor.github))
  );
}
```

Each handler calls this and skips its mutation step on `undefined`. One structured log line per mutating call via the existing `createLogger`:

```
attribution_applied {
  surface:  "git" | "gh-assignee" | "jira",
  outcome:  "applied"
          | "skipped_no_trigger"            // findTriggerActor returned undefined
          | "skipped_no_user_record"        // actor known, no UserRecord matches
          | "skipped_config_unavailable"    // config could not be loaded; attribution remains best-effort
          | "skipped_missing_identity_field"// resolved user lacks the field this surface needs
          | "skipped_unsupported_arg_shape" // e.g. git commit -F
          | "skipped_already_attributed"    // -m value already contains the email
          | "skipped_existing_assignee"     // gh/Jira request already set the assignee field
          | "api_rejected",
  reason?:  string,                         // sub-reason for skipped_missing_identity_field / api_rejected
                                            // e.g. "lookup_timeout", "lookup_no_match", "upstream_disconnected"
  field?:   "github" | "email",
  slack?:   string,                         // always present on skip outcomes when the actor had a slack id
  github?:  string,                         // always present on skip outcomes when the actor had a github login
  email?:   string                          // only set on outcomes after UserRecord resolution
}
```

**`/exec/git` handler.** Before `execCommand("git", effectiveArgs, ...)` at `index.ts:583`: if subcommand is `commit` and a user resolves, append the `Co-authored-by: Name <email>` line **directly into the last `-m` value as plain text** — no `--trailer` flag, no reliance on `git interpret-trailers`. `validateCommit` (`policy-git.ts:585-604`) already accepts only `-m`/`-F`/`--message`/`--file`; subcommands like `commit --amend`, `revert`, `cherry-pick` never reach this handler because the policy rejects them upstream, so no separate skip outcome for them is needed.

Argument-rewrite helper: generalize the existing `rewriteSingleValueFlag` (`index.ts:212-246`) — currently it errors on multiple matches because every `gh` body surface it serves expects exactly one. Add a `match: "single" | "last"` option (default `"single"` to keep `withGhDisclaimer` byte-identical) and use `"last"` for the commit-trailer rewrite. One helper, two call sites, no duplicated arg-scanning logic.

Trailer text shape: append `\n\n` (or `\n` if the value already ends with a newline) followed by `Co-authored-by: Name <email>`. GitHub's UI recognizes raw `Co-authored-by:` lines in commit bodies for co-author avatars — no `interpret-trailers` round-trip is required for the user-visible outcome.

Skipping cases:

- `-F <path>` (commit message from file) → `skipped_unsupported_arg_shape`. Reading sandbox-side files from the host adds complexity not worth it for v1.
- The last `-m` value already contains the resolved user's email, case-insensitively and in any trailer/body format → `skipped_already_attributed`, args byte-identical. This is the deterministic de-dup path: on a re-run of the same `git commit` the trailer is appended exactly once.
- `bin/git` is unchanged.

Pros/cons of the plain-text append vs. routing through git's trailer machinery:

- **Pro — no policy widening.** `--trailer` stays denied, the commit surface stays narrow.
- **Pro — deterministic output.** No dependency on `trailer.ifExists` / `trailer.ifMissing` config, which differs per-repo and per-user `.gitconfig`.
- **Pro — explicit, testable de-dup.** A substring check on the `-m` value is trivial to unit-test; relying on git's trailer interpreter would require a real `git` invocation in tests.
- **Con — we own line-break correctness.** If the agent's `-m` value ends without a blank line, we must insert one; if it already ends with a trailer block, we must not insert an extra blank line. Covered by the helper, but it's logic we own.
- **Con — no semantic merging.** If the agent itself wrote a `Co-authored-by:` line with a _different_ identity, we append a second one instead of replacing it. Acceptable: the agent should not be writing co-author trailers, and if it does, both names landing is the honest record.

**`/exec/gh` handler.** In the `/exec/gh` route at `index.ts:616-626`, extend the existing arg-rewrite pass so that for `gh pr create`, Thor injects `--assignee <github>` **only when** all of the following are true: (a) a user resolves, (b) that user has `github`, and (c) the agent did not already pass `--assignee` / `-a`. The body itself is untouched — the disclaimer footer already includes a link to the Thor context for this trigger, so a separate "Triggered by …" line would be duplicative.

- If `--assignee` / `-a` is already present, leave the args byte-identical and log `skipped_existing_assignee`.
- When no resolved user or no `github` field, log the appropriate skip outcome and leave PR creation unchanged.
- v1 scope is limited to `gh pr create`; no post-create `gh pr edit` follow-up is needed.

**MCP Jira.** Extend the approval-resolution path so that for `createJiraIssue`, if a user resolves with `email` and the agent did not already provide `assignee_account_id`, Thor calls `lookupJiraAccountId` and injects the returned value into `assignee_account_id` before `createJiraIssue` is sent.

- **Prerequisite — expose the lookup tool on the actual Atlassian MCP upstream surface remote-cli can call internally.** Older repo docs list `lookupJiraAccountId` (`docs/plan/2026032001_atlassian-mcp.md:46`), but this tool must stay hidden from the agent-facing proxy policy. Before implementation, confirm the exact tool name + input/output schema on the live Atlassian upstream and make it callable from remote-cli's internal MCP path. If the tool truly is unavailable, this phase is blocked and needs a replacement lookup path before coding starts.
- **Exact lookup contract to code against.** Confirmed against the live Atlassian MCP upstream: `lookupJiraAccountId` input is an object requiring `{ cloudId, searchString }`, with `cloudId` described as a UUID or site URL. Thor sends `{ cloudId: approvalArgs.cloudId, searchString: resolved UserRecord.email }`. Output handling should be explicit: zero matches → `lookup_no_match`, exactly one match with a usable Jira account id → inject `assignee_account_id`, multiple matches → `lookup_multiple_matches`, tool unavailable/disconnected → `upstream_disconnected`.

Real implementation concerns:

- `buildUpstreamArgs` is currently synchronous. Calling an upstream tool makes the Jira attribution step async — `resolveApprovalActionOnce` must await a resolver that can both preserve disclaimer injection and, for Jira only, perform the lookup before the final upstream call.
- Bound the lookup with a 5s timeout. A slow Atlassian upstream must not stall approval resolution.
- **Unset-only rule.** If `approvalArgs` already contains `assignee_account_id`, leave it unchanged and log `skipped_existing_assignee`.
- **Service boundary / DI.** Don't reach into module globals from `buildUpstreamArgs` — pass the Jira lookup resolver in as a dependency (`lookupJiraAccountIdForIssue: (cloudId, email) => Promise<accountId | undefined>`). Makes tests easy, keeps approval replay clean, and gives a single seam to mock when the Atlassian upstream is the disconnected one.
- Failure modes (all collapse to "drop the assignee, log `api_rejected` with sub-reason"): lookup tool unavailable, zero matches, multiple matches, permission denied, timeout, Atlassian upstream disconnected.

**Mutation happens after approval**, matching the existing disclaimer flow — the human approves the agent's payload, Thor stamps attribution before sending upstream. This is the same trust posture Thor already uses for the disclaimer footer; if/when that posture changes, both attributions move together.

Behavior tests (next to existing `gh-disclaimer.test.ts` and `mcp-handler.test.ts`):

- `/exec/git commit`:
  - Resolved user + `-m "msg"` → trailer appended into the `-m` value.
  - Resolved user + repeated `-m` → trailer appended into the last `-m` only.
  - `-F <path>` → passed through, `skipped_unsupported_arg_shape`.
  - Re-run with the same `-m` or another message that already contains the resolved user's email → args byte-identical, `skipped_already_attributed`.
  - No trigger / no resolved user → args byte-identical.
  - Sub-session whose parent trigger has ended → `findTriggerActor` falls back to most-recent `trigger_start`, trailer still appended.
- `/exec/gh pr create`:
  - Resolved user with `github` + no existing assignee flag → `--assignee <github>` is injected before execution.
  - Existing `--assignee` / `-a` flag → args unchanged, `skipped_existing_assignee` logged.
  - No `github` field → no assignee injection; PR body and creation unchanged.
  - No resolved user → no assignee injection; PR body and creation unchanged.
- MCP Jira `createJiraIssue`:
  - Resolved user with `email` + `cloudId` + no existing `assignee_account_id` → `lookupJiraAccountId` called via injected resolver, returned `accountId` lands in upstream payload as `assignee_account_id`.
  - Existing `assignee_account_id` → args unchanged, `skipped_existing_assignee` logged and lookup skipped.
  - Lookup times out (>5s) → assignee dropped, `api_rejected` logged with sub-reason `lookup_timeout`.
  - Lookup returns zero matches → `api_rejected` with `lookup_no_match`.
  - Atlassian upstream disconnected → `api_rejected` with `upstream_disconnected`.
  - Approval replay: the same stored `ApprovalAction` resolved twice produces deterministic args (injected resolver memoizes per action id, or the lookup is repeated and idempotent).
- Config loader:
  - Duplicate `slack` / `github` / `email` on first load → `loadWorkspaceConfig` throws with the conflict identified.
  - Duplicate introduced on reload → `lastGood` retained, `config_reload_failed_using_last_good` logged.

**Agent-facing note.** Add one paragraph to `AGENTS.md` (or the relevant agent prompt surface) under a heading like "Thor-injected attribution": Thor stamps `Co-authored-by:` trailers on commits and assignee fields on PRs and Jira issues created by the agent. This injection happens server-side; the trailer goes in before commit, the PR assignee is added during `gh pr create` when unset, and the Jira assignee goes in post-approval via `assignee_account_id` lookup when unset. The agent will see this content on `git log`, `gh pr view`, etc. — do not strip it, do not treat it as a user edit, do not re-emit it on re-runs. AGENTS.md rule 10 still holds: this is a warning about observable state, not an instruction.

Exit: a Slack-triggered run produces a commit with the trailer, a PR assigned to the user's GitHub handle, and a Jira ticket assigned via `assignee_account_id` resolved from the user's email — without any change to `bin/git`, `bin/gh`, or anything inside the sandbox.

### Phase 4 — Repo cleanup + ship

- Keep user-registry seeding out of git: operators copy the private registry into their mounted `/workspace/config.json`, while this repo commits only sanitized docs and examples.
- Commit `docs/feat/users-directory-provenance.md` as the durable process note for how the registry is maintained.
- Delete generated extraction/probe artifacts from the workspace before ship (`users-*.json`, `stderr.txt`, local Jira probes, and any transient root TODO scratch file).
- Extend deterministic `pnpm test:e2e` to use the single mounted E2E `config.json`, create an actor-bearing trigger context, and verify `/exec/git` plus approved Jira create-call attribution through the running services. Keep `gh pr create` assignee injection in unit coverage so e2e does not need write access to GitHub.
- Push the branch, let `core-e2e` verify, open the PR.

Exit: no generated registry artifacts in `git status`; green push checks; PR open against `main`.

## Decision Log

| Decision                                   | Choice                                                                                               | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where users live                           | Inside existing `/workspace/config.json` under `users`                                               | Already mounted read-only; loader already validates + hot-reloads.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Schema shape                               | `{ email, name, slack?, github? }`                                                                   | `email` is the stable identity; both handles optional because not every human is in both systems.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Where attribution is injected              | Remote-cli Node handlers (`/exec/git`, `/exec/gh`, MCP gateway)                                      | Wrappers `bin/git`/`bin/gh` run on the host via `execCommand` but the cleanest insertion point is the Node handler one layer up, matching the existing `withGhDisclaimer` + `injectApprovalDisclaimer` patterns.                                                                                                                                                                                                                                                                                              |
| How the handler knows the trigger actor    | Extend `trigger_start` event log + `findTriggerActor(sessionId)`                                     | Session id is already in the HTTP header. The event log is the single source of truth. No new transport, no sandbox-side state.                                                                                                                                                                                                                                                                                                                                                                               |
| Squash-merge survival                      | Not separately addressed                                                                             | GitHub's squash UI concatenates `Co-authored-by:` trailers from all squashed commits into the squash body, so co-author credit usually survives — but the PR author can edit the squash message and strip them, and per-commit trailer ordering/whitespace can drift. The PR assignee survives squash unconditionally, and the Thor disclaimer footer (already in PR bodies) carries the context link back to the trigger. A dedicated "Triggered by …" body line was considered and rejected as duplicative. |
| Failure mode                               | Best effort, never block                                                                             | Attribution is cosmetic. A missing record must not stop the agent.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| MCP mutation timing                        | After approval                                                                                       | Matches existing disclaimer behaviour; changing this is a bigger trust-model conversation.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Resolved identity does not gate any action | Documented in Scope                                                                                  | Prevents future code from misusing `UserRecord` for permission decisions.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Batch trigger actor                        | Use the last trigger user in a batched Slack/GitHub event payload                                    | Batches represent a merged wake for one correlation key; attribution is cosmetic, and the latest event is the best simple proxy for who most recently asked Thor to act.                                                                                                                                                                                                                                                                                                                                      |
| User identity field validation             | Keep validation minimal for internal config                                                          | `users[]` is admin-maintained config. Trust configured Slack/GitHub/name fields beyond required string presence; downstream services can reject bad handles if operators misconfigure them.                                                                                                                                                                                                                                                                                                                   |
| Duplicate co-author trailers               | Skip when the last `-m` already contains the resolved user's email                                   | The email is the stable attribution key. Matching it case-insensitively avoids adding duplicate Thor trailers when the agent or a rerun already credited the same user in another trailer/body format, while still allowing different co-author identities to coexist.                                                                                                                                                                                                                                        |
| Trigger actor extraction owner             | Gateway extracts and passes `triggerSlackId` / `triggerGithubLogin`                                  | Gateway knows event source and batch order; runner should not reverse-parse prompt JSON or carry Slack/GitHub payload semantics, and dispatch planning should not infer a fallback actor from source arrays. Reusing the existing trigger fields keeps schema churn low while preserving "last user available" attribution.                                                                                                                                                                                   |
| Attribution E2E shape                      | Deterministic service E2E for git and failed live Jira create; `gh pr create` stays in unit coverage | The deterministic path proves remote-cli mutates real `/exec` and MCP calls using event-log actor context and the single mounted E2E config without requiring the GitHub App to have repository write permission. Jira assignee E2E approves `createJiraIssue` with a fake project key, verifies `lookupJiraAccountId` and the outgoing `assignee_account_id`, then expects the create call to fail before an issue is created. `lookupJiraAccountId` remains hidden from the agent-facing proxy policy.      |

## Risks

- **Stale `users` list.** Operators must remember to add new hires. Visible through `attribution_applied { outcome: "skipped_no_user_record" }` lines in the runner log.
- **MCP after-approval mutation.** The Jira assignee shown in the approval card does not include the injected assignee. Acceptable trade-off (same as the existing disclaimer); revisit if a reviewer is surprised.
- **Squash drift.** GitHub aggregates `Co-authored-by:` trailers across squashed commits into the squash body, so co-author credit usually survives onto `main` — but the PR author can edit the squash message before merging and drop them. The PR assignee and the Thor disclaimer footer's context link always survive squash; treat the trailer as best-effort on top of those.
- **PII in `config.json`.** Emails sit in a mounted file that already carries GitHub installation ids and proxy auth headers; trust boundary unchanged. README must note that attribution writes name + email into commits and Jira fields — visible externally on GitHub and Atlassian.
- **Trigger actor ≠ work owner in handoff cases.** On-call triggers a deploy for a teammate's PR; Slack thread relays a request from someone else. Plan attributes to the triggerer, full stop. Multi-field model is deferred.
- **GitHub co-author linking depends on commit email.** If a user's GitHub email is set to private and their commit-recognized address is the `users.noreply.github.com` alias, the `Co-authored-by: Name <jira-email>` trailer will show the name but won't link the avatar/profile. The Jira email is still the right choice for the schema (it's the only one that resolves in Jira); GitHub linking is a partial-credit consolation prize.

## Exit Criteria

- `users[]` schema + helpers shipped and tested.
- `trigger_start` records the actor; `findTriggerActor(sessionId)` returns it.
- `/exec/git`, `/exec/gh`, and the MCP Jira path each inject attribution when a user resolves and pass through silently otherwise.
- Every mutating call emits an `attribution_applied` log line.
- `pnpm test:e2e` covers git trailer stamping and live Jira assignee injection on a create call that fails with a fake project key; `gh pr create` assignee injection and email-based duplicate suppression stay in unit coverage.
- README documents `users`; `.context/` artifacts moved/deleted.
- Push checks green; PR open against `main`.

## Deferred Follow-Ups

- Weekly drift scanner that aggregates `attribution_applied { outcome: "skipped_no_user_record" }`.
- Multi-field identity model (`triggered_by` / `requested_by` / `acting_agent`).
- Per-user opt-out, global kill switch, automated registry sync.
