# User-Aware Attribution

## Goal

Stamp the human who triggered a Thor run onto the artifacts it produces — best effort, never blocks:

1. `Co-authored-by: <name> <email>` trailer on agent-made commits.
2. `--assignee <github>` on agent-opened PRs, plus a `Triggered by …` line in the PR body so attribution survives squash-merge.
3. `assignee` field on agent-created Jira issues.

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

## Phases

### Phase 1 — Schema + helpers

- Extend `WorkspaceConfigSchema` with optional `users: UserRecord[]`. `UserRecord = { email: string; name: string; slack?: string; github?: string }`. `email` and `name` required; `slack` and `github` optional. Schema doc comment: `email` must be the user's **Jira account email** — not a `users.noreply.github.com` alias.
- Add `findUserBySlack` / `findUserByEmail` / `findUserByGithub` to `workspace-config.ts`.
- Behavior-focused tests: sample config with two users, exercise the three lookups + miss paths.
- Update README Deployment Configuration to document `users`, with a minimal JSON snippet and the note that the config is hot-reloaded (no restart needed).

Exit: `pnpm -r test` green.

### Phase 2 — Record the trigger actor on `trigger_start`

- Extend the `trigger_start` event log record (`packages/common/src/event-log.ts:57-60`) with optional `triggerSlackId?: string` and `triggerGithubLogin?: string`.
- The runner already extracts these for viewer labels at `packages/runner/src/index.ts:1416,1443`. Pass them through to the `appendEvent` call that writes `trigger_start`.
- Add `findTriggerActor(sessionId): { slack?: string; github?: string }` next to `findAnchorContext` so any remote-cli handler can resolve "who triggered this session" without new transport.

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
attribution_applied { surface: "git" | "gh" | "jira",
                      outcome: "applied" | "skipped_no_trigger" | "skipped_no_user_record"
                                | "skipped_missing_identity_field" | "api_rejected",
                      field?: "github" | "email", slack?, github?, email? }
```

**`/exec/git` handler.** Before `execCommand("git", effectiveArgs, ...)` at `index.ts:583`: if subcommand is `commit` and a user resolves, append `--trailer "Co-authored-by: <name> <email>"`. `git commit` natively de-dupes trailers, so no manual presence check is needed. `bin/git` is unchanged.

**`/exec/gh` handler.** Extend `withGhDisclaimer` (or add a sibling `withGhAttribution` called right after it at `index.ts:616`) that, when the gh command is `pr create` and a user resolves:
- Prepends `Triggered by {name} (@{github})` (or `Triggered by {name} <{email}>` when no github) to the body using the same `rewriteSingleValueFlag` mechanism the disclaimer already uses for `--body` / `-b`. Supported arg shapes match the disclaimer's existing scope; `--body-file` and `--fill` are pre-existing gaps, not new ones, and are out of scope.
- Appends `--assignee <github>` when the user has a `github` field. GitHub's 422 (not-a-collaborator) is logged as `api_rejected`; the surrounding PR-create proceeds. No retry-by-recreate — same safety stance as the disclaimer.

**MCP Jira.** Extend `injectApprovalDisclaimer` / `buildUpstreamArgs` (`mcp-handler.ts:65, 625`) so that for `createJiraIssue` (and the equivalent direct REST shape), if a user resolves with `email`, look up the Jira `accountId` via the existing primitive and inject `assignee` into the upstream args. **Mutation happens after approval**, matching the existing disclaimer flow — the human approves the agent's payload, Thor stamps attribution before sending upstream. This is the same trust posture Thor already uses for the disclaimer footer; if/when that posture changes, both attributions move together.

Behavior tests (next to existing `gh-disclaimer.test.ts` and `mcp-handler.test.ts`):
- `/exec/git commit`: resolved user → trailer appended; no user → args byte-identical; non-`commit` subcommand → unchanged.
- `/exec/gh pr create`: resolved user with github → body line + `--assignee` injected via supported arg shape; resolved user without github → only body line; `gh` 422 → logged + PR creation proceeds.
- MCP Jira: resolved user with email → outbound payload includes the looked-up `accountId`; failed lookup → call proceeds without assignee.

Exit: a Slack-triggered run produces a commit with the trailer, a PR with both the body line and the assignee, and a Jira ticket assigned to the user's email — without any change to `bin/git`, `bin/gh`, or anything inside the sandbox.

### Phase 4 — Seed + ship

- Copy `.context/user_registry.json` into the operator's `config.json`. Move the provenance notes (Slack export + GitHub-org reconciliation + manual overrides) to `docs/feat/users-directory-provenance.md`, then delete the `.context/` working files (`users-*.json`, `user_registry.json`, `slack_users.csv`, `test.sh`).
- Push the branch, let `core-e2e` verify, open the PR.

Exit: green push checks; PR open against `main`.

## Decision Log

| Decision | Choice | Rationale |
|---|---|---|
| Where users live | Inside existing `/workspace/config.json` under `users` | Already mounted read-only; loader already validates + hot-reloads. |
| Schema shape | `{ email, name, slack?, github? }` | `email` is the stable identity; both handles optional because not every human is in both systems. |
| Where attribution is injected | Remote-cli Node handlers (`/exec/git`, `/exec/gh`, MCP gateway) | Wrappers `bin/git`/`bin/gh` run on the host via `execCommand` but the cleanest insertion point is the Node handler one layer up, matching the existing `withGhDisclaimer` + `injectApprovalDisclaimer` patterns. |
| How the handler knows the trigger actor | Extend `trigger_start` event log + `findTriggerActor(sessionId)` | Session id is already in the HTTP header. The event log is the single source of truth. No new transport, no sandbox-side state. |
| Squash-merge survival | PR body `Triggered by` line in addition to the `Co-authored-by` trailer | GitHub's squash UI drops trailers from non-primary commits; the body line survives. |
| Failure mode | Best effort, never block | Attribution is cosmetic. A missing record must not stop the agent. |
| MCP mutation timing | After approval | Matches existing disclaimer behaviour; changing this is a bigger trust-model conversation. |
| Resolved identity does not gate any action | Documented in Scope | Prevents future code from misusing `UserRecord` for permission decisions. |

## Risks

- **Stale `users` list.** Operators must remember to add new hires. Visible through `attribution_applied { outcome: "skipped_no_user_record" }` lines in the runner log.
- **MCP after-approval mutation.** The Jira assignee shown in the approval card does not include the injected assignee. Acceptable trade-off (same as the existing disclaimer); revisit if a reviewer is surprised.
- **Squash kills trailers.** Mitigated by the PR body line.
- **PII in `config.json`.** Emails sit in a mounted file that already carries GitHub installation ids and proxy auth headers; trust boundary unchanged.

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
