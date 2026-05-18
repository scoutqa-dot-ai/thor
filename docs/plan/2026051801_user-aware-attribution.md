# User-Aware Attribution

## Goal

Give Thor a first-class notion of "who triggered this run" by:

1. Carrying a `users` directory inside `/workspace/config.json` (email ↔ name, plus optional `slack` and `github` handles).
2. Resolving the trigger owner at runtime in **Thor code** (the existing `git`, `gh`, and MCP wrappers) rather than instructing the agent — safer and invisible to the prompt.
3. Auto-adding `Co-authored-by: <name> <email>` trailers to git commits made by the agent — best effort.
4. Auto-assigning Jira tickets (by email) and GitHub PRs (by github login) the agent creates to that human — best effort.

Best-effort means: when the lookup yields nothing, the wrapper proceeds without the attribution step and does not fail the call.

**Scope clarification — identity is cosmetic, not authorization.** This plan attaches a human to artifacts after the fact. It does not gate any action by identity. No code path should ever read a resolved `UserRecord` and decide whether to permit an operation. If/when authorization arrives, it gets its own plan and its own data model.

## Scope

- Schema + loader change in `packages/common/src/workspace-config.ts`.
- A small "current user" resolver that converts a Slack user id or GitHub sender login into a `UserRecord` via `BY_SLACK`/`BY_EMAIL`/`BY_GITHUB`-style lookups.
- Attribution baked into the three existing Thor wrappers (`bin/git`, `bin/gh`, MCP Jira path); the prompt is unchanged.
- "Best effort, don't block" handled by each wrapper's fallback path.

Out of scope:

- Maintaining the user list itself — operators edit `config.json` manually. The seed comes from `.context/user_registry.json` (200 entries) produced earlier; we copy it into the operator's config once and stop tracking the `.context/` copy.
- Any custom Slack profile field sync, GitHub org membership crawl, etc. — re-runnable scripts under `scripts/` only, no automation.
- Rewriting `disclaimer.ts` to embed user identity in the footer (separate plan if/when wanted).

## Phases

### Phase 1 — Schema + loader

- Extend `WorkspaceConfigSchema` with an optional `users: UserRecord[]` field. `UserRecord = { email: string; name: string; slack?: string; github?: string }`.
  - `email` and `name` are required; `slack` and `github` are both optional because some humans only exist on one side (e.g. an external GitHub contributor with no Slack, or a Slack-only stakeholder not in the GitHub org).
  - `email` must be the user's **Jira account email** — do **not** use a `users.noreply.github.com` alias, which will not resolve in Jira. Schema doc comment must state this.
  - No per-user opt-out flags. v1 is opinionated: every resolved user gets the trailer, the PR assignee, the PR body line, and the Jira assignee. If noise becomes a real problem, the fix is a follow-up plan, not a knob.
- Add helpers in `workspace-config.ts`:
  - `findUserBySlack(config, slackId): UserRecord | undefined`
  - `findUserByEmail(config, email): UserRecord | undefined`
  - `findUserByGithub(config, login): UserRecord | undefined`
- Behavior-focused tests: round-trip a sample config with two users, exercise the three lookups + miss paths. No tests for trivial field passthrough.
- Update `.env.example`, `README.md` Deployment Configuration, and any active plan docs that document config keys to mention the new `users` section. (Per AGENTS.md rule 6 — even though `users` is not an env var, the README config table is the canonical surface.) The README addition must include:
  - A literal JSON snippet of a complete `users` block with two example entries (one with `slack`+`github`, one with `email`+`name` only).
  - The exact path to edit (`/workspace/config.json` from inside the container, the mounted host path from outside).
  - The validation command (e.g. `pnpm -F @thor/common test workspace-config`) and an example of the duplicate-`slack` rejection message so operators recognize it when they see it.
  - A note that the config is hot-reloaded — no restart needed after edits.

Exit: `pnpm -r test` green; loader rejects malformed user entries with a clear message; helpers return `Readonly<UserRecord>` so callers cannot mutate shared parsed state; loader fails fast when two records share a `slack` or `github` value (duplicate identity = silent mis-attribution).
- **Mount permission:** verify `/workspace/config.json` is mounted **read-only** inside the sandbox. If it is writable today, fix the mount in the same change. A writable config would let the agent edit `users[]` mid-run and impersonate someone.

### Phase 2 — Thread trigger identity into the sandbox (un-spoofable)

Today the runner extracts `event.user` (Slack) and `sender.login` (GitHub) only for viewer-label rendering at `packages/runner/src/index.ts:1416,1443`. They never reach the sandbox where wrappers run. This phase makes that happen — and does it in a way the agent inside the sandbox cannot tamper with.

**Why not env vars?** The agent runs *inside* the sandbox. It can `export THOR_TRIGGER_GITHUB_LOGIN=ceo` and then `git commit`, producing a forged `Co-authored-by: CEO`. Env vars are unfit for any value humans will read as authoritative attribution.

**Transport: read-only file mounted into the sandbox.**

- When the runner spawns a sandbox for a trigger, it writes a one-shot JSON file to a runner-owned host path (e.g. `/run/thor/<sandbox-id>/trigger.json`):
  ```json
  { "slack": "U06MR2WBTL4", "github": "sondao" }
  ```
  Either field may be absent; the whole file is absent when the trigger has no human (cron, self-event, bot sender).
- The sandbox mounts that path read-only at a fixed location, e.g. `/var/run/thor/trigger.json`. The agent has read access but cannot write. The wrappers read from this file.
- **Snapshot semantics.** The file is written once at sandbox start and never modified. The wrappers, when they resolve, read this file plus the live `config.json`. The trigger identity is frozen for the run; the `UserRecord` it resolves to can change if the admin edits `config.json` mid-run.
- Carry only the **raw** identifier. The `UserRecord` itself is not snapshotted — see Decision Log #T-cache.
- Behavior tests:
  - Slack-triggered run: `/var/run/thor/trigger.json` contains the right `slack`.
  - GitHub-triggered run: contains the right `github`.
  - Non-human trigger: file is absent (not empty — absent).
  - Agent attempts to write the file inside the sandbox: filesystem denies.
  - Agent overrides `$THOR_TRIGGER_*` env vars (which do not exist): wrappers ignore env and use the file, so the forgery has no effect.

Exit: the file is delivered reliably; spoofing attempts have no effect on resolved identity; one unit test per trigger source and one spoof-attempt test are green.

### Phase 3 — Attribution in Thor wrappers (not in the prompt)

The agent prompt does **not** get a `[Trigger owner]` block. Per-prompt injection would be noise, and relying on the agent to consistently format trailers / pass `--assignee` is less safe than doing it in code. Instead, each of the three Thor-side wrappers resolves the trigger owner at call time and injects the attribution itself:

- **`packages/remote-cli/bin/git`** — the current 17-line sh wrapper stays as a thin launcher. It detects `git commit` (the only mutating subcommand we touch) and shells out to a new Node helper `packages/remote-cli/src/commit-attribute.ts`. Every other git subcommand exec's unchanged — no Node startup cost on `status`/`log`/`fetch`/etc.
  The helper:
  - Reads `/var/run/thor/trigger.json`; if absent, exec real git unchanged (`skipped_no_trigger`).
  - Detects rebase/cherry-pick/merge in progress by checking `.git/rebase-merge`, `.git/rebase-apply`, `.git/CHERRY_PICK_HEAD`, `.git/MERGE_HEAD` and exec's real git unchanged (`skipped_in_progress_operation`).
  - Resolves the `UserRecord`. If missing, exec real git unchanged (`skipped_no_user_record`).
  - Composes the message from the supported arg shapes (`-m`, repeated `-m`, `-F path`, `--file=path`, stdin when no `-m` and not in editor mode), checks for an existing `Co-authored-by:` trailer for the same email, and uses `git interpret-trailers --if-exists addIfDifferent --trailer "Co-authored-by: …"` to produce the augmented message. Then exec's real git with the rewritten message.
  - For unsupported shapes (`-c`, `--reuse-message`, `--fixup`, `--squash`, editor mode without `-m`/`-F`): exec real git unchanged (`skipped_unsupported_arg_shape`).
- **`packages/remote-cli/bin/gh`** — extend `auth-helper.js` (already Node-aware). On `gh pr create`:
  - **Format:** the attribution line is `Triggered by {name} (@{github})` when the resolved owner has a `github` field; `Triggered by {name} <{email}>` otherwise. The `@` prefix is only used for actual handles.
  - **Pre-create injection (the easy path).** When the body shape is `--body <text>` or `--body-file <path>`, prepend the attribution line into the body and append `--assignee <github>` (when present) before exec'ing real gh. Most reliable.
  - **Post-create injection (the `--fill` / `--template` / editor path).** When the body shape is one of these, run real `gh pr create` first (without our additions). After it returns with the PR URL/number, run `gh pr edit <number> --add-assignee <github>` and `gh pr edit <number> --body "<existing-body>\n\nTriggered by …"`. This rescues attribution for the most common agent path, which is `gh pr create --fill`. Each `gh pr edit` is independently best-effort; a failure on one does not block the other.
  - **Assignee-rejected handling.** GitHub returns 422 if the user isn't a collaborator. Log `api_rejected` and continue. Never re-run `gh pr create` to retry (would create a duplicate PR).
- **MCP gateway for Jira** — when proxying `createJiraIssue` (and the equivalent direct REST shape), if a resolved owner has an `email`, look up the Jira `accountId` and inject `assignee` into the request **before** the approval gate runs. If approval is interactive, the human reviewer must see the injected assignee in the proposed payload — never mutate after approval. If `lookupJiraAccountId` or the issue creation itself fails the assignee, drop the field and let the original call proceed (logged as `api_rejected`).

How the wrapper knows who triggered the run: it reads the trigger file from `/var/run/thor/trigger.json` (set in Phase 2 — agent-unspoofable) and calls `findUserBySlack` / `findUserByGithub` against the live `config.json`. Resolution runs per mutating call only — not on every `git status` or `git log`.

**Structured drift log.** Only **mutating** wrapper calls (commit, pr create/edit, issue create) emit a log line, via the existing `createLogger` ingestion (the same channel `bin/gh`'s auth-helper already uses today; never stderr — that pollutes agent output). Event name follows repo snake_case convention:
```
attribution_applied {
  surface: "git" | "gh-assignee" | "gh-body" | "jira",
  outcome: "applied"
         | "skipped_no_trigger"
         | "skipped_no_user_record"
         | "skipped_missing_identity_field"   // with field: "github" | "email"
         | "skipped_in_progress_operation"
         | "api_rejected",
  field?: "github" | "email",
  slack?: string, github?: string, email?: string
}
```

**Operator diagnostic.** Ship `scripts/users-drift.sh` (or `.ts`) alongside this plan. It greps the recent runner log for `attribution_applied { outcome: "skipped_no_user_record" }`, groups by raw Slack id / GitHub login, and prints a table with count and last-seen timestamp. Documented in README next to the `users` section. The weekly automated scanner stays in TODOS.md; the manual diagnostic is the day-1 affordance.

No agent-facing skill change is required for *instructions* — the agent runs `git commit` / `gh pr create` / the Jira MCP tool normally and Thor handles the rest. The one exception is a *warning*: add a single sentence to the existing `using-gh` skill (and the equivalent git/Jira skills if they make analogous promises) — "Thor prepends a `Triggered by …` line and (where applicable) appends a disclaimer footer to PR bodies and a `Co-authored-by` trailer to commits. Do not strip them." This warns the agent about state it will observe when reading back its own work; it does not instruct the agent to do anything, so AGENTS.md rule 10 still holds.

Behavior tests:

- `git` wrapper / `commit-attribute.ts`:
  - Resolved owner → trailer appended via `git interpret-trailers`.
  - Existing matching trailer for same email → no duplicate.
  - No trigger file → byte-identical args passed through.
  - Rebase / cherry-pick / merge in progress (`.git/rebase-merge` etc. present) → passed through unchanged, logged `skipped_in_progress_operation`.
  - Message via `-m`, repeated `-m`, `-F path`, `--file=path`, stdin → all supported.
  - Unsupported (`-c`, `--reuse-message`, `--fixup`, `--squash`, editor mode) → passed through, logged `skipped_unsupported_arg_shape`.
  - Malformed `config.json` mid-run → loader falls back to last-good per existing semantics; no crash.
  - Duplicate `slack` id across two `UserRecord`s → loader fails fast at validation (Phase 1 schema test).
  - Agent attempts to override identity via env: env is ignored, file wins.
- `gh` wrapper:
  - Supported body shape (`--body <text>`, `--body-file <path>`) + resolved owner with `github` → `--assignee` added AND `Triggered by` line prepended.
  - `--fill` / `--template` / editor mode → passed through, logged `skipped_unsupported_arg_shape`.
  - GitHub returns 422 on assignee → `gh pr edit --add-assignee` follow-up; if that fails, logged `api_rejected`; no duplicate PR.
  - No `github` field but resolved owner → only the body line is added.
- Jira MCP path:
  - Resolved owner with `email` → outbound payload includes the looked-up `accountId`.
  - `lookupJiraAccountId` returns nothing → call proceeds without an assignee.
  - Approval gate: the approval UI sees the mutated payload (with assignee), not the agent's original payload.

Exit: a manual end-to-end test (Slack trigger from a known user) produces a commit with the trailer, a PR assigned to the user's GitHub handle, and a Jira ticket assigned to their email — without the agent doing anything special.

### Phase 4 — Seed + ship

- Copy `.context/user_registry.json` into the operator's `config.json` once (manual; documented in README).
- Move provenance notes (how the seed was assembled, the GitHub-org reconciliation, the manual overrides) to `docs/feat/users-directory-provenance.md`, then delete the `.context/` working files (`users-*.json`, `user_registry.json`, `slack_users.csv`, `test.sh`). Keeping provenance in `docs/` means future operators can re-derive or extend the list without spelunking git history.
- Push the branch, let `core-e2e` verify nothing regressed, then open the PR.

Exit: green push checks; PR open.

## Decision Log

| Decision | Choice | Rationale |
|---|---|---|
| Where users live | Inside existing `/workspace/config.json` under `users` | One canonical mounted file; no new mount or env var; loader already validates and hot-reloads it. |
| Schema shape | `UserRecord = { email, name, slack?, github? }` | `email` is the only stable identity. `slack` is optional (external GitHub contributors, contractors). `github` is optional (~half of the 200 Slack users aren't in the GitHub org). The seed `.context/user_registry.json` will need a one-time pass to drop `slack` where it's the only-known field for someone, but the schema accepts the current shape unchanged. |
| Inject in code, not prompt | `bin/git`, `bin/gh`, MCP Jira gateway all resolve + inject server-side | Per-prompt `[Trigger owner]` blocks would be noise on every turn and rely on the agent following instructions consistently. Wrappers already exist for these three surfaces, so attribution becomes a property of the runtime, not the prompt. |
| Failure mode | Best effort, never block | Attribution is a nice-to-have; a missing record must not stop the agent from committing, creating Jira tickets, or opening PRs. |
| Carry raw identity, resolve late | Trigger context holds only `slack` id / `github` login; resolution happens on demand against current `config.json` | Operators can correct a user's email/github/name and the fix takes effect on the next action — no cached snapshot to invalidate, no rerun. |
| Where the agent learns the convention | Nowhere — the prompt is unchanged, attribution is invisible to the agent | Code-side wrappers handle every attribution surface; instructing the agent would be both noise and a reliability risk. |
| `.context/user_registry.ts` | Already deleted; do not reintroduce | Operators edit JSON in `config.json`; no need for a typed re-export. |
| Squash-merge survival | PR body line in addition to `Co-authored-by` | GitHub squash UI drops trailers from non-primary commits unless explicitly preserved. The PR body line survives. |
| Drift visibility | Structured `attribution.applied` log line on every wrapper call | Silent fallback otherwise hides registry rot; a query against the event log answers "which Slack ids hit Thor this month with no `UserRecord`." Cheap (one log call per wrapper invocation). |
| Per-session cache vs late-bind every call | Snapshot the resolved `UserRecord` once per wrapper *invocation* (read live `config.json` per mutating call). The trigger identity file is frozen at sandbox start, so the slack id / github login does not change mid-run; the `UserRecord` lookup may change if an admin edits `config.json` mid-run. | Two parallel commits in the same run would each read the current config — so they agree if `config.json` is unchanged, and diverge if an admin edits between them. The divergence window is a few seconds and the failure mode is benign (some commits get the old record, some get the new). Caching the resolved `UserRecord` for the whole sandbox lifetime would prevent any benefit from admin fixes; pure late-bind every call is the chosen middle ground. |
| Resolved identity does not gate any action | Documented explicitly in Scope | Prevents future code from reading a `UserRecord` and using it for permission decisions; authorization is a separate plan. |

## Risks

- **Stale `users` list.** Operators must remember to add new hires. Mitigation: when the agent sees an unresolved Slack id or GitHub login from a known org member, it just proceeds — no nag, no failure. Drift is visible only in attribution gaps.
- **PII in `config.json`.** Emails and names sit in a mounted file. Acceptable: this file already holds GitHub installation ids and proxy auth headers, so the trust boundary is unchanged.
- **Best-effort assignee calls.** Jira and GitHub may reject assignment (unknown account, no permission). The wrapper catches and continues, emits `api_rejected` in the drift log, and the surrounding action proceeds unchanged.
- **Squash-merge eats trailers.** GitHub's squash UI drops `Co-authored-by` from non-primary commits unless preserved manually. Mitigation: the PR body line added by `bin/gh` (Phase 3) survives squash, so attribution is preserved on the PR even when the trailer is lost on `main`.

## Exit Criteria

- `config.json` schema accepts `users` (with optional `slack`/`github`); loader + helpers tested; helpers return `Readonly<UserRecord>`; duplicate `slack`/`github` rejected at validation.
- `config.json` is verified to be mounted read-only inside the sandbox.
- Slack and GitHub triggers thread their raw identifier through a runner-owned read-only file at `/var/run/thor/trigger.json`; env-var spoofing is verified ineffective.
- `git`, `gh`, and the Jira MCP path each resolve the owner at call time, inject the trailer/assignee/body line when possible, fall back silently otherwise.
- Every wrapper attribution attempt emits a structured `attribution.applied` log line with the outcome (applied / skipped_no_trigger / skipped_no_user_record / skipped_no_github_field / api_rejected).
- No new agent-facing prompt content; no skill text rewrites beyond fixing anything that contradicts the new behavior.
- `.context/` extraction artifacts removed; README + `.env.example` updated.
- Push checks green; PR open against `main`.

## Deferred — TODOS.md additions

- **Weekly drift scanner.** Cron job that aggregates the `attribution.applied { outcome: "skipped_no_user_record" }` log lines from the last 7 days and emits a list of raw Slack ids / GitHub logins to add to `config.json`. Out of blast radius for this plan; scheduled-job infrastructure is its own concern.
- **Multi-field identity model (triggered_by / requested_by / acting_agent).** This plan ships only "trigger owner." If/when product needs distinct semantics (e.g. "agent committed at the request of A but on behalf of B"), expand the model in a follow-up. Today: triggerer is owner, full stop.
- **Global `attribution: { enabled: boolean }` kill switch in `config.json`.** Lets operators disable attribution wholesale without deleting `users[]`. Defer — per-user `autoAssign` and the silent-pass-through default cover the realistic incidents. Add if/when needed.
- **`scripts/reconcile-users.ts`.** Re-runnable Slack + GitHub org pull that diffs against the current `users[]` and prints add/remove suggestions. The day-1 manual diagnostic (`scripts/users-drift.sh`, shipped in this plan) covers the visibility gap from the wrapper side. Full reconciliation is bigger infra; defer.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale |
|---|---|---|---|---|---|
| 1 | CEO | Delete stale Decision Log row about `[Trigger owner]` block in prompt | Mech | P5 | Both voices flagged the contradiction with Scope |
| 2 | CEO | Rewrite Risk #3 wording — drop "skill text" reference | Mech | P5 | Internal inconsistency from a prior revision |
| 3 | CEO | Add PR-body `Triggered by @{name}` line in `bin/gh` to survive squash-merge | Taste→Add | P1 + P2 | Subagent HIGH; in blast radius; ~15 min CC |
| 4 | CEO | Add structured `attribution.applied` log line per wrapper call | Taste→Add | P1 + P2 | Both voices flagged silent failure; in blast radius; ~30 min CC |
| 5 | CEO | Promote env-threading from "verification" to explicit Phase 2 work (`THOR_TRIGGER_SLACK_ID` / `THOR_TRIGGER_GITHUB_LOGIN`) | Mech | P5 | Code inspection showed the threading does not exist yet; plan was misleading |
| 6 | CEO | Defer weekly drift scanner to TODOS.md | Mech | P3 | Outside blast radius; acknowledged in Risks; scheduled-job infra is its own concern |
| 7 | CEO | Document "identity is cosmetic, not authorization" in Scope | Mech | P5 | One-line; prevents future code from misusing `UserRecord` for permission decisions |
| 8 | CEO | Keep late-bind (no session cache) | Taste→Keep | P5 | Simpler — no invalidation. If profiling shows hot path, add 30s memo later. Surfaced at gate. |
| 9 | CEO | Keep auto-assign-by-default for Jira + PR | Taste→Keep | User stated direction | Codex argued opt-in; user already said "auto-assign". Add `autoAssign: false` flag to TODOS for later. Surfaced at gate. |
| 10 | CEO | Keep trigger-owner-only identity model | Taste→Keep | P3 + scope | Multi-field model is a larger plan; defer to TODOS. Surfaced at gate. |
| 11 | Eng | Replace env-var trigger transport with read-only file `/var/run/thor/trigger.json` | Mech | P5 + security | Both voices flagged env spoofing; agent runs in sandbox |
| 12 | Eng | Pin `bin/git` shape: sh launcher + `commit-attribute.ts` Node helper using `git interpret-trailers` | Mech | P5 explicit | Both voices flagged sh complexity as hidden 4-hour work |
| 13 | Eng | Enumerate `gh pr create` supported body shapes; `--fill`/`--template`/editor → skip with log | Mech | P5 + P3 | Both voices flagged arg-shape fragility |
| 14 | Eng | Replace 422 retry with `gh pr edit --add-assignee` follow-up | Mech | P5 + safety | Subagent flagged duplicate-PR risk; clean alternative path exists |
| 15 | Eng | Detect in-progress rebase/cherry-pick/merge via `.git/*` state files; skip | Mech | P5 explicit | Subagent flagged; argv alone is insufficient |
| 16 | Eng | Mutate Jira payload BEFORE approval gate, not after | Mech | P5 + correctness | Codex flagged approval/audit mismatch |
| 17 | Eng | Document `config.json` read-only mount in Phase 1 exit | Mech | P5 + security | Codex flagged writable-config impersonation risk |
| 18 | Eng | Drift log via existing `createLogger`, not stderr | Mech | P5 + agent-output hygiene | Codex flagged transport ambiguity |
| 19 | Eng | Limit drift log to mutating ops (commit/pr-create/issue-create) | Mech | P3 pragmatic | Subagent flagged log volume |
| 20 | Eng | Expand test list: env-spoofing, malformed config, duplicate identity, stdin commit, editor mode, rebase-in-progress, `--body-file`, `--fill`, Jira existing assignee, approval-gate payload | Mech | P1 completeness | Both voices |
| 21 | Eng | Helpers return `Readonly<UserRecord>` | Mech | P5 | Subagent LOW; cheap |
| 22 | Eng | Move `.context/user_registry.json` provenance to `docs/feat/users-directory-provenance.md` before deleting | Mech | P5 | Subagent LOW; preserves audit trail |
| 23 | DX | `gh pr create --fill`/`--template`/editor → post-create `gh pr edit` follow-up instead of skip-and-log | Mech | P1 completeness | Both voices flagged — `--fill` is the common agent path |
| 24 | DX | ~~Ship `autoAssign?` in v1~~ → **REVERSED at gate**: user picked "few knobs, less is more". If noise hits, the fix is a follow-up plan, not a flag. | Gate override | User direction | T1 user choice at Phase 4 gate |
| 25 | DX | README operator recipe (JSON snippet + validation cmd + duplicate error example + no-restart note) added to Phase 1 exit | Mech | P1+P5 | Both voices flagged TTHW gap |
| 26 | DX | Ship `scripts/users-drift.sh` day-1 manual diagnostic | Mech | P2 | Both voices flagged "queryable but not actionable" |
| 27 | DX | Rename event `attribution.applied` → `attribution_applied` for repo convention | Mech | P5 | Subagent flagged grep inconsistency |
| 28 | DX | One-sentence skill warning about Thor-injected PR body + commit trailer (warning, not instruction) | Mech | P5 | Subagent flagged agent surprise; consistent with AGENTS.md rule 10 |
| 29 | DX | Attribution text format: `Triggered by {name} (@{github})` or `Triggered by {name} <{email}>` | Mech | P5 | Codex flagged ambiguous `@` + spaces in name |
| 30 | DX | Schema doc comment: `email` must be Jira-account email, not GH noreply | Mech | P5 | Subagent flagged silent fail on noreply alias |
| 31 | DX | Collapse asymmetric `skipped_no_github_field` into `skipped_missing_identity_field { field }` | Mech | P5 | Subagent low; cleaner schema |
| 32 | DX | Defer global kill switch `attribution: { enabled }` to TODOS | Taste→Defer | P3 | Per-user `autoAssign` + best-effort default cover realistic incidents. Surfaced at gate. |
| 33 | DX | Defer `scripts/reconcile-users.ts` (full Slack+GH org sync) to TODOS | Taste→Defer | P3 | Day-1 diagnostic (#26) covers visibility gap; full sync is bigger infra. Surfaced at gate. |

## Gate Resolution (Phase 4 — final)

Approved with one override of the recommended defaults:

- **T1** — overridden. No `autoAssign` opt-out flag in v1. Kept opinionated.
- **T4** — accepted. Late-bind every mutating call against live `config.json`.
- **T6** — accepted. No global kill switch.
- **T7** — accepted. No `scripts/reconcile-users.ts` — each team works differently.
- **T-multi** — accepted. Trigger-owner-only identity model.

Plan is **APPROVED**. Ready for `/ship`.

## GSTACK REVIEW REPORT

| Voice | Source | Concerns | Status |
|---|---|---|---|
| CEO (subagent) | claude | 6 | applied 7 auto-decisions; 3 taste surfaced |
| CEO (codex) | codex | 5 | merged with subagent above |
| Eng (subagent) | claude | 9 | applied 12 auto-decisions; 1 taste surfaced |
| Eng (codex) | codex | 7 | merged with subagent above |
| DX (subagent) | claude | 10 | applied 11 auto-decisions; 2 taste surfaced |
| DX (codex) | codex | 5 | merged with subagent above |

Verdict: ready for your call on the 5 surfaced taste decisions; recommended defaults are the plan as it now stands.
