<!-- /autoplan restore point: /Users/son.dao/.gstack/projects/scoutqa-dot-ai-thor/explain-build-agent-autoplan-restore-20260427-215334.md -->
# Agent Run Directories

Switch the `build` agent's coding protocol from in-prompt context passing to a file-based handoff: each task gets a directory under `/workspace/runs/<run-id>/` with a single required `README.md` index, and subagents read/update that directory instead of being re-narrated by the orchestrator on every step.

## Goal

Stop the orchestrator from re-stating task context to `thinker` and `coder` on every invocation. The orchestrator passes only a run-dir path. Subagents read `README.md`, do their role, update the README, and add supporting files (more markdown, verification scripts, fixtures) only when those files earn their place.

## Scope

**In scope:**

- Add `/workspace/runs/` as a new mounted RW volume on the OpenCode container.
- Update `docker/opencode/config/agents/build.md`:
  - Replace the current 5-step "Code change protocol" with a README-centric loop.
  - Add `/workspace/runs` to the path table.
  - Document the README structure, run-id scheme, verdict-line convention, and the link between worklog/memory and run dirs.
- **Update `docker/opencode/config/agents/coder.md` and `thinker.md`** (revised in scope per /autoplan CEO gate, 2026-04-27):
  - Teach each subagent to parse `Run dir:` and `Role:` from the prompt header.
  - Teach each subagent to read `<run-dir>/README.md` as task source of truth.
  - Teach each subagent to append a Log line and update Lifecycle/Verdict/Artifacts when finishing its role.
  - Teach each subagent the fail-fast contract: if the README is missing required content, return an error to the orchestrator rather than guessing.
- Make per-repo plan/feat conventions explicitly take precedence for in-repo durable artifacts.

**Out of scope:**

- Same pattern for the investigation protocol (separate plan if/when wanted).
- Automated archival or cleanup of old run dirs.
<!-- moved IN scope by /autoplan CEO gate 2026-04-27: subagent edits required for protocol to function on day 1 -->
- Per-repo memory schema changes.
- Backfilling in-flight tasks into the new layout.

## Design

### Storage

New mount, peer to existing workspace dirs:

| Path | Access | Purpose |
|---|---|---|
| `/workspace/cron` | RW | Crontab for scheduled jobs |
| `/workspace/memory` | RW | Persistent agent memory |
| `/workspace/repos` | RO | Main repo clone |
| `/workspace/worklog` | RO | Tool call logs and session notes |
| `/workspace/worktrees` | RW | Git worktrees for code changes |
| **`/workspace/runs`** | **RW** | **Per-run scratch dir for agent handoffs** |

### Run directory

```
/workspace/runs/<run-id>/
  README.md         # required — index, status, log, links to everything else
  <whatever>.md     # plan, review, notes — only when needed
  verify.sh         # repro / verification scripts as needed
  fixtures/         # sample payloads, captured logs, screenshots
```

Only `README.md` is mandatory. Everything else exists on demand and is linked from the README. If it isn't in the README, it doesn't exist. Agents are free to add or replace supporting files (verification scripts, fixtures, notes) as needed; iteration history lives in the README's Log, not in separate `iterations/<n>/` directories.

Run-id: `<YYYYMMDD-HHMMSS>-<slug>` (seconds granularity, e.g. `20260427-143052-mcp-approval`). Append a Slack thread ts (`-<thread-ts>`) when the task is tied to one. Seconds + slug + optional thread-ts is uniqueness-sufficient for current concurrency. Runner-issued opaque IDs and a per-worktree lease are deferred to Phase 7 (out of scope here).

### `README.md` shape

Short, structured, scannable. The canonical template lives at `docker/opencode/config/run-readme.template.md` and is the single source of truth for the schema; `build.md`, `coder.md`, and `thinker.md` all reference it instead of duplicating the spec.

Required literal field prefixes at the top (one per line, in this order, exact case, single space after the colon) so the runs are deterministically grep-able:

```
Run-ID: <YYYYMMDD-HHMMSS>-<slug>[-<thread-ts>]
Repo: <repo-name>
Branch: <branch-name>
Worktree: /workspace/worktrees/<repo>/<branch>
Lifecycle: open | merged | abandoned
Verdict: BLOCK | SUBSTANTIVE | NIT | MERGED | (empty before first review)
```

Then sections, in order:

- **Goal** — one paragraph.
- **Artifacts** — table linking to every other file in the run dir with a one-line description.
- **Log** — append-only short entries: `2026-04-27 14:30 thinker: plan ready → plan.md`.

Glossary (also written into `build.md`):

- `BLOCK` — review found a defect that must be fixed; iterate.
- `SUBSTANTIVE` — review found non-trivial improvements; iterate.
- `NIT` — only nitpicks remain; ship.
- `MERGED` — PR landed; run is terminal.

`Lifecycle:` is the run's lifetime state; `Verdict:` is the latest review's outcome. They are different fields with different vocabularies — do not conflate.

### Subagent invocation

OpenCode subagents are invoked through the `task` tool, which takes `subagent_type`, `description`, and a free-text `prompt`. There are no CLI flags. Run-dir and role are passed as well-known fields at the top of the prompt:

```
Run dir: /workspace/runs/<run-id>
Role: <plan | implement | review>

<short instruction for this step>
```

Subagents parse the first two non-empty lines of the prompt against:

- `^Run dir: (?<path>/workspace/runs/[^\s]+)$` — case-sensitive, single space, no trailing whitespace, must be an absolute path under `/workspace/runs/`. Subagents `realpath` the value and reject anything that escapes the prefix.
- `^Role: (?<role>plan|implement|review)$` — case-sensitive, exact enum.

Defaults / missing fields:

| Missing | Subagent behavior |
|---|---|
| `Run dir:` | Reply `ERROR: missing Run dir header` and stop. No fallback to "old protocol." |
| `Role:` | Reply `ERROR: missing Role header` and stop. |
| `<run-dir>/README.md` does not exist | Reply `ERROR: README not found at <path>` and stop. |
| Required README field absent (Goal, etc.) | Reply `ERROR: README missing <field>` and stop; orchestrator amends and re-dispatches. |
| Verdict written by `thinker review` is outside enum | Orchestrator validator rejects, retries once with corrective prompt, then escalates. |

Anything else the subagent needs (available tools, MCP upstreams, skills, environment hints) is appended to the prompt by the orchestrator — it does not live in the README.

### Loop

Five steps, each reads and updates the README:

1. **Frame** — orchestrator creates `/workspace/runs/<id>/README.md` from `run-readme.template.md` with header + goal filled in. One source of truth.
2. **Plan** — orchestrator invokes `thinker` with role `plan`. Thinker reads the README, plans the change, writes `plan.md` if useful, links it from the README's Artifacts table, appends a Log line.
3. **Implement** — orchestrator invokes `coder`. Coder reads README and any linked artifacts, edits the worktree, appends a Log line.
4. **Test** — coder runs targeted tests in the sandbox (per `build.md` testing policy) and records exact commands + outcomes in the Log. Never the full suite — CI handles that on push.
5. **Review** — orchestrator invokes `thinker` with role `review`. Thinker reads README + follows links + reads test results, then replaces the `Verdict:` line; adds `review.md` only if findings warrant prose.

Iteration: on `BLOCK` or `SUBSTANTIVE`, re-invoke `coder`. Each retry appends a Log entry; supporting files are overwritten or replaced as the agent sees fit. No enforced `iterations/<n>/` split.

Distillation into `worklog/` and `memory/<repo>/` is **out of the main loop** — handled by a separate daily/weekly pass, designed later.

### Rules

- Subagent prompts contain the run-dir path, the role, and **runtime context that the README must not capture**: currently available tools, MCP upstreams, skills, and any environment hints that may change between invocations. Task content stays in the README; runtime context stays in the prompt.
- Subagents must not depend on conversational context from the orchestrator about the task itself. If the README lacks task information they need, fail fast and ask the orchestrator to amend it.
- Lifecycle and verdict live in the README; supporting files are optional elaboration.
- `/workspace/runs/` is the working surface. `worklog/` is the index. `memory/` is the distilled knowledge. Don't mix.
- **Per-repo conventions win.** If the target repo defines its own plan/feat layout (e.g. `docs/plan/`, `docs/feat/`, `AGENTS.md` rules, plan filename format, decision-log schema), durable plan documents are written in the repo's preferred location and format. The run dir still holds inter-agent handoffs; the README links to the in-repo plan so subagents can find it.
- Trivial changes (one-line config, doc tweaks) skip the protocol entirely — no run dir created.

## Phases

The phase set was restructured after `/autoplan` review (2026-04-27). The original three phases (mount → build.md rewrite → integration) had a critical scope hole: the subagents didn't know the protocol, and the markdown contract was too loose for repeated LLM edits. The new structure adds a contract-foundation phase (template + direct edit rules), a subagent-edits phase, and a static test phase before integration.

### Phase 1 — Volume mount

- Add `./docker-volumes/workspace/runs:/workspace/runs` (RW) to the `opencode` service in `docker-compose.yml`. The mount path stays under the existing `docker-volumes/workspace/<dir>` pattern; do **not** create a new top-level `docker-volumes/runs/`.
- Create `docker-volumes/workspace/runs/.gitkeep` so the host dir exists.
- Verify the container starts and the dir is writable from inside `opencode` and visible (per existing pattern) from any service that already binds the whole `/workspace` tree.

**Exit criteria:** `docker compose up` succeeds; `mkdir /workspace/runs/_smoke && rmdir /workspace/runs/_smoke` works inside the `opencode` container.

### Phase 2 — Schema foundation

Lock the contract before any agent code reads it.

- Add `docker/opencode/config/run-readme.template.md` as the canonical README schema. Required fields, exact field-prefix lines, section order, glossary — all live here. Other agent files reference this template and never duplicate the spec.
- Subagents and the orchestrator edit the README directly using their existing file-edit tools:
  - **Frame (run init)** — orchestrator copies the template, fills `Run-ID:`, `Repo:`, `Branch:`, `Worktree:`, sets `Lifecycle: open`, leaves `Verdict:` empty, fills the Goal section.
  - **Log appends** — shell append (`echo "<timestamp> <agent>: <message>" >> README.md`) or the agent's Edit tool. Append-only; never rewrite the Log section.
  - **Verdict / Lifecycle** — replace the existing field-prefix line in place. Never duplicate it.
  - **Artifacts** — insert a new row into the table; never rewrite the table.
- No helper CLI in v1. Drift is bounded (worst case: 1–2 wasted subagent iterations per drift event; the load-bearing `Verdict:` field is protected by the orchestrator-side validator in Phase 3). If recurrent drift is observed in Phase 6 or in production, add `runs-cli` as a Phase 7 follow-up.
- Free-form artifacts (`plan.md`, `review.md`, `verify.sh`, `fixtures/`) are written directly by subagents.

**Exit criteria:** template file exists at `docker/opencode/config/run-readme.template.md`; a sample populated README satisfies the field-prefix order, required sections, and verdict/lifecycle enums when checked by the static validator script (Phase 5 T2).

### Phase 3 — Build.md rewrite (orchestrator)

- Add `/workspace/runs` to the path table.
- Replace the existing "Code change protocol" with the README-centric **5-step loop** (Frame → Plan → Implement → Test → Review). Test is preserved as a first-class step — the existing testing policy in `build.md` does not regress.
- Document the run-dir layout, run-id scheme (`YYYYMMDD-HHMMSS-<slug>[-<thread-ts>]`), README schema (referencing `run-readme.template.md`), header field-prefix lines, glossary.
- Specify the subagent invocation contract verbatim: regex for `Run dir:` / `Role:`, defaults table, `ERROR:`-prefix structured failure return.
- Add the rules block (subagent prompts pass only run-dir + role + ephemeral runtime hints; per-repo conventions win for durable plan docs; trivial changes skip the protocol entirely with the heuristic spelled out — single-file change ≤ 30 lines, no new deps, no schema/migration change).
- Add the orchestrator-side verdict validator: after each `task()` call to `thinker review`, the orchestrator reads `<run-dir>/README.md` and asserts the `Verdict:` line is in the enum; on miss, retry once with a corrective prompt, then escalate. This is the load-bearing check that lets the helper CLI stay deferred.
- Add the orchestrator post-condition check: after each `task()` call, assert a Log line was appended for the expected role; on miss, escalate.

**Exit criteria:** `build.md` is internally consistent: every step references the README and direct edit rules; no step relies on re-narrated task content; the path table matches the mount; verdict and post-condition validators are described.

### Phase 4 — Subagent definition updates (`coder.md`, `thinker.md`)

Bring the subagents into the protocol. **The exact post-edit text for each file is drafted as part of this phase and reviewed before merge** — do not let the implementer freestyle the contract surface.

- `coder.md` additions:
  - Header parsing (regex spec) and `realpath` check.
  - "Read `<run-dir>/README.md` first; never act on `Run dir:` alone."
  - "Edit the worktree, then run targeted tests, then append a single Log line: `<timestamp> coder: <one-line summary + test result>`."
  - Fail-fast contract: missing fields → `ERROR: ...` reply, no guessing.
  - Mutation rules: append to Log; replace `Verdict:` / `Lifecycle:` lines in place; insert (never rewrite) Artifacts rows. Forbid wholesale rewrites of the README.
- `thinker.md` additions:
  - Header parsing + `realpath` check (same).
  - Role split: `Role: plan` writes `plan.md` if useful, inserts an Artifacts row linking to it, appends a Log line; `Role: review` reads README + linked artifacts + worktree diff, replaces the `Verdict:` line with one of `BLOCK|SUBSTANTIVE|NIT`, optionally writes `review.md`.
  - Same fail-fast contract and same mutation rules.
- A static lint in CI (or a one-shot script in `scripts/`) checks all three files (`build.md`, `coder.md`, `thinker.md`) for the magic strings: `Run dir:`, `Role:`, the verdict enum, the lifecycle enum. If any of the three drift, CI fails.

**Exit criteria:** both subagent files contain the documented contract; the lint passes; a manual prompt-paste smoke ("Run dir: /workspace/runs/_missing\nRole: plan\n\nfoo") returns the expected `ERROR: README not found at /workspace/runs/_missing/README.md` from `thinker`, and `coder` rejects unsupported roles with `ERROR:`.

### Phase 5 — Static + container test harness

Land verification before the integration phase, not as part of it.

- T1. Static lint: build.md / coder.md / thinker.md all reference the same magic strings (run via `scripts/lint-runs-protocol.sh` or similar).
- T2. Schema validator: parse `run-readme.template.md` and a sample populated README, assert required fields present and enums valid.
- T3. Container smoke: Phase 1's `mkdir/rmdir` test, automated.
- T4. Mount audit: verify (or document) which services have RW on `/workspace/runs/`. If only `opencode` should write, narrow the bind on other services; otherwise document the dual-writer rule.
- T5. Subagent contract test (no Slack): stub a fake README missing `Goal`, dispatch `thinker plan` → assert `ERROR:` reply.
- T6. Subagent log-append test: dispatch `coder` against a valid run dir → assert exactly one Log line was appended (file diff before/after), no duplicate sections, no rewritten artifact rows.
- T7. Verdict enum test: dispatch `thinker review` → assert `Verdict:` line matches enum; force a fault by stubbing the model's reply with `Verdict: NEEDS_WORK` → assert orchestrator retries once.
- T8. Re-narration regression: dispatch `coder` with prompt = only `Run dir:` + `Role:` + a one-word task → assert it does NOT respond "I need more context"; it reads the README.
- T9. Path traversal: dispatch with `Run dir: /workspace/memory/../../etc` → assert subagent rejects.

**Exit criteria:** T1–T9 all green in CI or via a single make target.

### Phase 6 — Integration verification

- Push the branch and let the relevant workflow run (or dispatch manually).
- Drive a real non-trivial Slack task and confirm:
  - Orchestrator creates `/workspace/runs/<id>/README.md` from the template.
  - `thinker` and `coder` update the README directly (Log appends, Artifacts rows, field-prefix lines) and add supporting files only when warranted.
  - The `Verdict:` line drives iterate-vs-stop and the orchestrator's validator passes.
  - One iteration loop on a forced `BLOCK` works end-to-end.
  - Watch for drift — duplicate sections, dropped Artifacts rows, lost Log lines, malformed `Verdict:`. If observed, capture as evidence to motivate a follow-up `runs-cli` helper.
- Open a PR against `main` once push checks are green.

**Exit criteria:** one end-to-end task completes through the new loop with a populated README, valid `Verdict:`, and only the supporting files that were useful.

### Phase 7 — Deferred (out of scope of this plan)

Tracked here so they don't get lost; not part of this PR.

- **`runs-cli` helper for atomic structured-field writes.** Speced and then cut from v1 after worst-case-drift analysis: realistic worst case is 1–2 wasted subagent iterations per drift event, the load-bearing `Verdict:` field is already protected by the orchestrator-side validator, PRs still get human review, and run dirs are scratch (no durable consumer). Add only if Phase 6 integration or production usage shows recurrent drift.
- **Runner-owned worktree lease.** Today the orchestrator mints run-ids and worktree reuse is shared across runs (`build.md:113`). A runner-owned lease (1 active run per worktree) is the correct long-term shape per CEO + Eng review. Defer until we observe a real concurrency incident or migrate to runner-owned task state.
- **Runner-issued opaque run IDs.** Same parent decision: when the runner owns task state, it owns ID minting. Keep the seconds-granularity scheme until then.
- **Generalize to `kind:` (investigate, qa, pr-review).** Original "Future" section. Land coding first, generalize from evidence.
- **Per-kind Status vocabularies and lifecycle rules** — same.
- **Automated archival / TTL for old run dirs** — manual deletion is fine to start.

## Decision Log

| Decision | Rationale |
|---|---|
| Name the mount `/workspace/runs/` (not `tasks/` or `handoffs/`) | `tasks/` collides semantically with opencode's built-in `task` tool and `permission.task` config — same word, different identifiers, ambiguous in conversation. `handoffs/` biases toward the linear coding case and reads strained for investigations. `runs/` is lifecycle-agnostic and works for every workflow we plan to extend to. |
| Single required `README.md` per run, everything else on demand | One rule instead of a fixed file set or weight tiers. Tiny tasks stay tiny; complex tasks accumulate files organically, always indexed from the README. |
| Separate `/workspace/runs/` mount instead of nesting under `memory/<repo>/runs/` | Memory is curated and permanent; run scratch is verbose and ephemeral. Co-locating muddles grep semantics and lifecycle rules. |
| Drop `<repo>` segment from the run path | Keep the path short. `repo` lives in the README header, so the run-id alone is unique and tools can still filter. |
| Run-id `<YYYYMMDD-HHMMSS>-<slug>[-<thread-ts>]` | Sortable, unique enough for v1 without coordination, human-readable. Slack ts suffix optional. |
| Verdict line `BLOCK | SUBSTANTIVE | NIT | MERGED` in README `Verdict:` field | Mechanical iterate-vs-stop decision without parsing prose. |
| No enforced `iterations/<n>/` split | Iteration history lives in the README Log; agents freely add or replace supporting files. Forcing a numbered split adds ceremony without value for the common case. |
| Distillation runs out of band, not in the main loop | Worklog and memory updates are a separate daily/weekly pass (design TBD). Keeping them out of the main loop keeps run completion fast and lets the distillation policy evolve independently. |
| Tool/skill hints pass via subagent prompt, not README | Runtime info changes between invocations; storing it in a durable artifact means stale hints and a forced rewrite on every call. README captures task content; prompts carry environment. |
| Worklog stays read-only and unchanged | Append a pointer line to the existing session note rather than writing artifacts there; preserves its role as the durable index. |
| No automatic archival in this change | Cleanup policy can wait until we see real volume; manual deletion is fine to start. |
| Per-repo plan/feat conventions take precedence | Repos already define plan format, location, and decision-log schema in their own `AGENTS.md`. The run dir holds inter-agent scratch; durable plans stay where the repo expects them. |
| Mount layout: `docker-volumes/workspace/runs:/workspace/runs` (not `docker-volumes/runs/`) | Keep the established `docker-volumes/workspace/<dir>` pattern. Caught by /autoplan eng review (2026-04-27). |
| 5-step loop with explicit `Test` step (not 4-step) | Existing `build.md:102` testing policy is load-bearing — coder runs targeted tests before review. Folding it into Implement loses the explicit gate. /autoplan eng review (Codex + subagent) flagged High regression. |
| No helper CLI in v1; subagents edit the README directly | The CLI was speced (`runs init`, `log`, `verdict`, `lifecycle`, `artifact`, `cat`) but cut after worst-case-drift analysis. Realistic worst case is one wasted subagent iteration (~1–2 min, a few thousand tokens) when a stale-snapshot rewrite drops a Log line or Artifacts row. The load-bearing `Verdict:` field is already protected by the orchestrator-side validator (Phase 3); PRs still get human review; run dirs are scratch with no durable consumer. Building the CLI before observing drift was speculative. Revisit as a Phase 7 follow-up if Phase 6 integration or production shows recurrent drift. /autoplan cross-phase consensus + measurement-first override. |
| `Lifecycle:` (open/merged/abandoned) and `Verdict:` (BLOCK/SUBSTANTIVE/NIT/MERGED) are different fields | Earlier draft had a single `Status` field overloaded across both. /autoplan DX review (both voices) flagged High — `MERGED` semantically overlapped with header lifecycle. Splitting also makes both fields independently grep-able. |
| Required literal field prefixes at top of README (`Run-ID:`, `Repo:`, `Branch:`, `Worktree:`, `Lifecycle:`, `Verdict:`) | "Short, structured, scannable" was prose-only. Locked literal prefixes give deterministic `grep -l` for "all open runs" / "all blocked runs" without parsing markdown. /autoplan DX review. |
| Run-id at seconds granularity (`YYYYMMDD-HHMMSS`), not minutes | Minute granularity collides on concurrent Slack mentions or retries; dropping `<repo>` from the path made it worse. Seconds + slug + optional thread-ts is sufficient until runner-owned IDs land in Phase 7. /autoplan CEO + Eng review. |
| Orchestrator-side `Verdict:` enum validator after every `task()` call | Without the helper CLI, the orchestrator post-condition check is the only gate that protects iterate-vs-stop logic from model drift (`OK`, `NEEDS_WORK`, etc.). Reads the README, asserts the enum, retries once with corrective prompt, then escalates. |
| Subagent prompt deltas pre-drafted in Phase 4, not freestyled by implementer | The protocol is the contract. Letting Phase 4 invent the contract surface during implementation reintroduces drift across the three files. Pre-draft + lint catches it. |
| Defer runner-owned worktree lease + opaque run-IDs to Phase 7 | Both are correct long-term but require runner state-model changes that exceed this plan's scope. Seconds-granularity IDs + worktree-reuse-with-best-effort is the v1 risk-budget choice. Revisit on first observed concurrency incident. |
| Static protocol lint across `build.md`/`coder.md`/`thinker.md` | The 3-way contract lives in three files with no schema. A regex lint for the magic strings (Run dir:, Role:, verdict enum, lifecycle enum) costs ~30 lines and catches the most likely drift. |

---

## /autoplan Review Report

Generated by `/autoplan` on 2026-04-27. Branch: `explain-build-agent`. Commit: `64120aec`.

### Phase 1 — CEO / Strategy (dual voices)

**Codex CEO voice — strategy challenge (verified against codebase):**
- **Critical** — Plan optimizes an unmeasured pain. No data on prompt-token cost from re-narration, observed orchestrator drift, or attributable subagent failures. The 10x reframe is not "how do subagents share context" but "what is the canonical task state model in the runner, made inspectable, resumable, and auditable?"
- **Critical** — "Changes to subagent definitions out of scope" is incoherent with the design. Codex read `docker/opencode/config/agents/coder.md` and `thinker.md` and confirmed they are generic prompts (~12 lines each) with no parsing contract, no filesystem contract, no README mutation behavior. Either bring them in scope or restate the contract in every delegated prompt (which defeats the purpose).
- **High** — Run-id uniqueness claim is false. `<YYYYMMDD-HHMM>-<slug>` at minute granularity, with `<repo>` segment dropped, will collide on concurrent Slack mentions, retries, or same-slug-different-repo. Slack thread ts suffix is "optional" and many runs won't have one.
- **High** — Markdown is wrong format for LLM-to-LLM mechanical handoff. Status, verdict, artifacts, and log fields want deterministic parsing. In 6 months, this becomes pseudo-JSON-in-markdown or grows a sidecar `state.json`. Cleaner: canonical `run.json` + optional human README generated from it.
- **Medium** — Split-brain state. README is "one source of truth" but per-repo `docs/plan/` is also durable truth, plus `worklog/` and `memory/`. Plan intent, execution status, review verdict can diverge across four surfaces.
- **Strategic miss** — Thor's MVP scenarios skew toward investigation/orchestration, not just code implementation. Optimizing the coding loop first improves a secondary path.

**Claude CEO subagent — independent strategic review:**
- **Critical** — Subagent scope gap (same finding, independently surfaced).
- **High** — No problem quantification. Optimizing on vibe.
- **High** — Markdown vs JSON for machine handoff (same finding).
- **High** — Alternatives not analyzed: (a) in-prompt with compression/summary, (b) structured JSON, (c) DB/KV instead of files, (d) do nothing with 200K+ context windows. Decision Log justifies internal choices (path name, run-id format) but not the *approach itself*.
- **High** — README Log will recreate the bloat problem after 5+ iterations on a complex task.
- **High** — P4: orchestrator can resist re-narration. LLMs gravitate toward verbose prompts; without a hard token limit, the orchestrator will paste README contents "just to be safe."
- **Medium** — 6-month regret: protocol calcifies before generalizing; Status vocabulary divergence between coding/investigation will force a v1 rewrite.
- **Medium** — Custom protocol diverges from emerging agent-handoff conventions (LangGraph state, OpenAI Agents SDK handoffs). Mandate `state.json` mirror as cheap insurance.
- **Medium** — "Trivial changes skip the protocol" — heuristic unspecified, future foot-gun.

**CEO DUAL VOICES — CONSENSUS TABLE:**

| Dimension | Claude | Codex | Consensus |
|---|---|---|---|
| 1. Premises valid? | ❌ unmeasured | ❌ unmeasured | **CONFIRMED ❌** |
| 2. Right problem to solve? | ⚠️ secondary to subagent quality | ⚠️ secondary to runner state model | **CONFIRMED ❌ (different reframings)** |
| 3. Scope calibration correct? | ❌ subagent edits required | ❌ subagent edits required (verified) | **CONFIRMED ❌** |
| 4. Alternatives sufficiently explored? | ❌ 4 dismissed | ❌ runner-state, prompt-deltas dismissed | **CONFIRMED ❌** |
| 5. Competitive/standard risks covered? | ⚠️ diverges from emerging standards | — | flagged by Claude only |
| 6. 6-month trajectory sound? | ❌ Log-bloat regret | ❌ pseudo-JSON-in-markdown regret | **CONFIRMED ❌** |

### What already exists (mapped from the plan to current code)

| Plan sub-problem | Existing surface |
|---|---|
| Path table for `/workspace/<dir>` | `docker/opencode/config/agents/build.md:81-87` |
| 5-step Code change protocol | `build.md:98-115` |
| `coder` / `thinker` subagent prompts | `docker/opencode/config/agents/coder.md`, `thinker.md` (do NOT know the proposed protocol) |
| Worktree pattern, durable repo plan | `AGENTS.md:7` requires `docs/plan/YYYYMMDDNN_<slug>.md` already |
| Worklog / memory mounts | `docker-compose.yml:152-159` |
| Bind layout pattern | `docker-volumes/workspace/<dir>` (NOT `docker-volumes/<dir>`) — plan's Phase 1 says `docker-volumes/runs/.gitkeep`, inconsistent |

### NOT in scope (proposed deferrals after CEO review)

- Any change to `coder.md` / `thinker.md` — must move IN scope (see Critical above).
- Cross-kind unification (`investigate`, `qa`, `pr-review`) — already deferred to Future, OK.
- Automated archival — deferred, OK.
- Memory schema changes — deferred, OK.

### Failure Modes Registry (CEO-surfaced)

| # | Mode | Likelihood | Impact | Mitigation candidate |
|---|---|---|---|---|
| F1 | Orphan run dirs because subagents don't know the protocol | **High (day 1)** | Critical — protocol non-functional | Move subagent edits in scope |
| F2 | README Log grows unboundedly, recreates bloat | High after iteration ≥5 | High | Cap, summarize-and-rotate, or sidecar JSON |
| F3 | Run-id collision on concurrent Slack mentions | Medium | Medium — overwrites another run's state | Add seconds + random suffix or runner-issued ID |
| F4 | Orchestrator pastes README into prompt "just to be safe" | High (LLM tendency) | High — defeats goal | Hard token cap on subagent prompts; protocol doc forbids inlining |
| F5 | Split-brain across run README, repo plan, worklog, memory | Medium | Medium — debug-time confusion | Pick one source of truth per kind of fact; document |
| F6 | docker-volumes path inconsistency (`docker-volumes/runs/` vs `docker-volumes/workspace/runs/`) | High (Phase 1) | Low — cosmetic but breaks pattern | Phase 1 wording fix |
| F7 | Verdict-line drift (`BLOCK \| SUBSTANTIVE \| NIT`) under model variance | Medium | Medium — iterate-vs-stop logic breaks | Validate verdict against allowlist; reject and re-prompt |

### Dream state delta

This plan leaves Thor with a partial protocol: the orchestrator follows it, the subagents don't know it. The 12-month ideal is a runner-owned task state model where the runner — not the orchestrator and not the subagents — is the source of truth, and where any agent reading or writing state goes through a typed, audited interface. The current plan moves toward that future *if* it includes (a) subagent contract updates, (b) JSON sidecar from day one, (c) opaque run IDs from the runner. Without those, it's a half-step that calcifies the wrong shape.

### Premise gate (resolved)

User chose **REVISE**: bring `coder.md` / `thinker.md` edits into Phase 2 scope. Other premises (markdown vs JSON, measurement-first, runner-owned state) accepted as-is for v1; flagged for follow-up. Scope and Out-of-scope sections updated above.

### Phase 3 — Eng (dual voices)

#### ASCII dependency graph (post-revise)

```
                ┌──────────────────────────┐
                │ runner (Slack/cron event)│  RW: /workspace (whole)
                └────────────┬─────────────┘
                             │ trigger session
                             ▼
                ┌──────────────────────────┐
                │ build.md (orchestrator)  │
                │  - mints run-id          │
                │  - frames README header  │
                │  - dispatches via task() │
                └──┬──────────────────┬────┘
                   │                  │
              task("plan")       task("implement"/review)
                   ▼                  ▼
        ┌──────────────────┐   ┌──────────────────┐
        │ thinker.md       │   │ coder.md         │
        │  parses headers  │   │  parses headers  │
        │  reads README    │   │  reads README    │
        │  appends Log     │   │  appends Log     │
        │  sets Status     │   │  edits worktree  │
        └────────┬─────────┘   └────────┬─────────┘
                 │ read/write           │ read/write
                 ▼                      ▼
        ┌─────────────────────────────────────────┐
        │ /workspace/runs/<id>/                   │  ◄── dual-writer surface
        │   README.md (5 sections, 4-step Status) │
        │   plan.md / review.md / verify.sh ...   │
        └────────────┬────────────────────────────┘
                     │ links to
                     ▼
        ┌─────────────────────────────────────────┐
        │ /workspace/worktrees/<repo>/<branch>    │  RW (1 worktree : N runs ⚠)
        │ /workspace/repos/                       │  RO
        │ /workspace/worklog/                     │  RO
        │ /workspace/memory/                      │  RW (curated)
        └─────────────────────────────────────────┘
```

#### Codex eng voice — architecture / operational risks (verified against code)

- **Critical** — 1 worktree : N runs, no lock. `build.md:112` mandates worktree reuse. The runner serializes by session ID only (`packages/runner/src/index.ts:397`), no per-worktree lease. Two concurrent `@thor` mentions on the same branch corrupt shared git state. **Fix:** runner-owned worktree lease keyed by canonical path; second run blocks/requeues.
- **High** — Test step regression. Existing `build.md:102` has explicit Test step + testing policy at `build.md:171`. New 4-step loop drops it; Phase 3 exit only validates README behavior (line 88, 127). **Fix:** restore Test/Verify as first-class step or fold into Implement with required verification artifact.
- **High** — Markdown mutation by LLM is unreliable for repeated edits. Concrete failure modes: duplicate Status sections, dropped artifact rows on table rewrite, log entries inserted out of order, stale links after rename, lost updates from snapshot-overwrite. **Fix:** subagent helper CLI (`runs log`, `runs status`, `runs artifact`) doing atomic field updates against a typed state file; regenerate README from state.
- **High** — `Run dir:` parsing has no canonicalization. Repo already uses realpath checks (`packages/common/src/workspace-config.ts:336`, `packages/remote-cli/src/policy.ts:19`). **Fix:** require realpath, prefix-check `/workspace/runs/`, reject symlinks/relative paths.
- **Medium** — Runner has RW on entire `/workspace` via `docker-compose.yml:178`. Run dir becomes dual-writer (runner + opencode). **Fix:** define single-writer-per-field rule or use file locking/CAS.
- **Medium** — Run dir vs session directory ambiguity. `isAllowedDirectory()` (`packages/common/src/workspace-config.ts:343`) only permits `/workspace/repos/`, enforced in `packages/runner/src/index.ts:372`. If someone implements this by setting OpenCode session `directory` to `/workspace/runs/<id>`, runner rejects it. **Fix:** state explicitly that session `directory` stays the repo/worktree; `Run dir:` is a sidecar absolute path. Or widen allowlist and test it.
- **Low** — Phase 1 path inconsistent. Plan line 112 says `docker-volumes/runs/.gitkeep`; existing pattern (`docker-compose.yml:153`) is `docker-volumes/workspace/<dir>/`. **Fix:** use `docker-volumes/workspace/runs/.gitkeep`.
- **Open** — Verdict allowlist enforcement. If model writes `OK` / `NEEDS_WORK` instead of `BLOCK | SUBSTANTIVE | NIT | MERGED`, iterate-vs-stop logic breaks. No validator defined. **Fix:** orchestrator validates verdict against enum; on miss, retry once with explicit re-prompt.

#### Claude eng subagent — independent review

- Same Critical worktree:run multiplicity finding.
- Same High markdown-mutation finding; recommends `runs-cli` helper or `state.json` sidecar.
- Same High Test step regression.
- Adds **High** — Subagent contract not enforced; no orchestrator post-condition check that the Log line was actually appended after a `task()` call.
- Adds **High** — Implicit 3-way contract (build.md ↔ coder.md ↔ thinker.md README structure) lives only as prose in three files; no schema, no validator. Drift is inevitable. **Fix:** linter on the three prompt files for the magic strings.
- Adds **High** — Runner has RW on whole workspace (`docker-compose.yml:189`); narrow runner mount or accept access in plan §Rules.
- Adds **Medium** — Worktree↔run-dir multiplicity unmodeled. Concurrent runs on same worktree fight. **Fix:** one-active-run-per-worktree invariant; orchestrator checks for `open` run on same worktree before minting.
- Adds **Medium** — Run-dir lifecycle / terminal state undefined. Who flips `merged` / `abandoned`? When? Plan defers archival but doesn't define terminal state. **Fix:** orchestrator flips `merged` after `gh pr merge`; `abandoned` after N days idle.
- Adds **Medium** — Path traversal in `Run dir:` (matches Codex finding).
- Adds **Medium** — Trivial-vs-non-trivial heuristic unspecified (line 100). **Fix:** define rule (≤N lines, single file, no deps/schema change → skip).
- Adds proposed test plan (T1–T11) covering linter checks, container-internal smoke, subagent contract tests, E2E.

#### ENG DUAL VOICES — CONSENSUS TABLE

| Dimension | Claude | Codex | Consensus |
|---|---|---|---|
| 1. Architecture sound? | ❌ 1:N worktree, no lock | ❌ 1:N worktree, runner doesn't lease | **CONFIRMED ❌** |
| 2. Test coverage sufficient? | ❌ 4-step drops Test | ❌ 4-step drops Test | **CONFIRMED ❌** |
| 3. Performance risks addressed? | ⚠️ README log growth | ⚠️ stale-snapshot lost updates | **CONFIRMED ⚠️** |
| 4. Security threats covered? | ❌ runner RW on whole /workspace; path traversal | ❌ runner RW; path traversal; session dir allowlist | **CONFIRMED ❌** |
| 5. Error paths handled? | ❌ no post-condition check; no fail-fast contract enforcement | ❌ no verdict validator; no CAS | **CONFIRMED ❌** |
| 6. Deployment risk manageable? | ⚠️ docker-volumes path wrong; bind layout breaks pattern | ⚠️ same | **CONFIRMED ⚠️** |

#### Test diagram (codepaths → coverage)

| Codepath / behavior | Test type | Status in plan | Required (auto-decided) |
|---|---|---|---|
| `build.md` mints run-id; `Run dir:`/`Role:` lines emitted | Static lint of `build.md` | None | **ADD** (T1) |
| README has all 5 sections, Status from allowlist | Schema/regex validator on a sample README | None | **ADD** (T2) |
| `mkdir/rmdir /workspace/runs/_smoke` | Container smoke | Phase 1 exit | OK |
| Two concurrent run-id mints in same minute | Concurrency unit test | None | **ADD** (T4) |
| Runner cannot write to /workspace/runs OR doc the dual-writer rule | Mount audit | None | **ADD** (T5) |
| README missing Goal → thinker fail-fast | Subagent contract test | None | **ADD** (T6) |
| `coder` appends exactly one Log line, mutates Status/Artifacts cleanly | Subagent contract test | None | **ADD** (T7) |
| `thinker review` writes verdict matching enum | Subagent contract test | None | **ADD** (T8) |
| Re-narration regression: prompt with only Run dir:/Role: still works | Subagent contract test | None | **ADD** (T9) |
| 1 BLOCK iteration → coder re-invoked | E2E Slack | Phase 3 exit | OK |
| 2 iterations → Log append-only, supporting files overwrite cleanly | E2E Slack | Implicit | **ADD** (T11) |
| Path traversal: `Run dir: /workspace/memory/../../etc` rejected | Subagent canonicalization test | None | **ADD** |

The test plan artifact (T1–T11) lives in this section; if Phase 2 implementation lands a `runs-cli` helper, those tests run as fast unit tests on the helper rather than the LLM.

#### Eng-surfaced failure modes (additions to F1–F7 above)

| # | Mode | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| F8 | Concurrent runs corrupt shared worktree's git state | High in active-thor | Critical | Runner-owned worktree lease |
| F9 | LLM rewrites README from stale snapshot, drops new Log lines | Medium | Bounded — 1–2 wasted iterations per event | Orchestrator post-condition validator + retry; revisit `runs-cli` if observed recurrently |
| F10 | Verdict line outside enum, iterate-vs-stop logic breaks | Medium | Medium | Orchestrator validator + retry |
| F11 | Session `directory` set to /workspace/runs/<id>, runner rejects | Medium (impl error) | Medium | Document explicitly; widen allowlist deliberately or keep at /workspace/repos |
| F12 | Test step regression: untested code reaches Review | High | High | Restore Test step or mandate verification artifact |

### Phase 3.5 — DX (dual voices)

#### Codex DX voice — agent + human DX

- **Critical** — Prompt-header contract not spec'd, only illustrated (`plan:75`). No regex, case rules, whitespace rules, path canonicalization. **Fix:** `^Run dir: (?<path>/workspace/runs/[^\n]+)$`, `^Role: (?<role>plan|implement|review)$`, case-sensitive, first two non-empty lines.
- **Critical** — README schema has no durable source of truth. Plan describes shape in prose; `build.md:98` still has old protocol; no template file in repo. **Fix:** add `docker/opencode/config/run-readme.template.md` (or similar) checked in; reference from `build.md`, `coder.md`, `thinker.md`.
- **High** — Teaching `coder.md`/`thinker.md` the protocol is not realistic in current form. They're 10–12 lines of generic behavior. **Fix:** plan must include the exact post-edit text for both: parse header, read README, required fields, allowed mutations by role, exact completion format, fail-fast behavior.
- **High** — `Status` is overloaded. Header has `status: open | merged | abandoned` (lifecycle); separate Status/Verdict line has `BLOCK | SUBSTANTIVE | NIT | MERGED`. `MERGED` overlaps. **Fix:** rename header field to `Lifecycle:`; reserve `Verdict:` for review outcome.
- **High** — Human grepability not deterministic. Plan says "short, structured, scannable" but no exact literal prefixes. **Fix:** require fixed single-line fields at top: `Run-ID: ...`, `Repo: ...`, `Lifecycle: ...`, `Verdict: ...`.
- **Medium** — Verdict enum declared but not enforced. **Fix:** orchestrator validator + retry once on miss.
- **Medium** — Fail-fast errors have no visible landing. Plan says "ask orchestrator to amend" but doesn't define where the failure surfaces. **Fix:** failed subagent appends Log entry + sets `Verdict: BLOCK` with machine-readable reason; orchestrator mirrors to worklog.

#### Claude DX subagent — agent + human DX

- Same Critical findings (subagent prompt undrafted, schema sourceless).
- High — Naming consistency: no spec for `Run dir:` casing, trailing slash, multi-line preamble, whitespace. **Fix:** exact regex.
- High — No structured failure return shape. **Fix:** prefix `ERROR:` convention.
- High — Status vocabulary mixes review-verdict with lifecycle (matches Codex finding).
- Medium — Defaults table missing for "what if X is absent". **Fix:** explicit table in plan.
- Medium — Escape hatches limited to "trivial skips". Multi-repo, resume-after-crash, human-edit-mid-flight unaddressed.
- Medium — Status jargon (`BLOCK | SUBSTANTIVE | NIT`) needs glossary in `build.md`.

#### DX DUAL VOICES — CONSENSUS TABLE

| Dimension | Claude | Codex | Consensus |
|---|---|---|---|
| 1. Header contract regex spec'd? | ❌ | ❌ | **CONFIRMED ❌** |
| 2. README schema canonical source? | ❌ no template file | ❌ no template file | **CONFIRMED ❌** |
| 3. coder.md/thinker.md realistic? | ❌ undrafted | ❌ undrafted | **CONFIRMED ❌** |
| 4. Status/Verdict overloaded? | ❌ rename | ❌ Lifecycle: + Verdict: | **CONFIRMED ❌** |
| 5. Grep determinism? | ⚠️ Status line drift risk | ❌ no fixed prefixes | **CONFIRMED ❌** |
| 6. Error/fail-fast visible? | ❌ no landing zone | ❌ no landing zone | **CONFIRMED ❌** |

#### DX Scorecard (averaged from both voices)

| Dimension | Claude | Codex | Avg |
|---|---:|---:|---:|
| TTHW for LLM agent | 4 | 3 | **3.5** |
| TTHW for human maintainer | 7 | 4 | **5.5** |
| Error message quality | 3 | 2 | **2.5** |
| Naming/protocol consistency | 4 | 4 | **4** |
| Documentation clarity | 5 | 3 | **4** |
| Escape hatches / flexibility | 5 | 5 | **5** |
| Discoverability | 5 | 3 | **4** |
| Upgrade path (kind: extension) | 6 | 6 | **6** |
| **Overall** | — | — | **4.3 / 10** |

#### Developer journey (LLM-agent path, post-revise)

| Stage | What the agent sees | Friction |
|---|---|---|
| Receive prompt | `Run dir: /workspace/runs/X\nRole: plan\n<task>` | Header format unspec'd; agent may miss/misread |
| Locate README | Must `cat <run-dir>/README.md` | No instruction in coder.md/thinker.md (yet) |
| Parse 5 sections | Free-form markdown, no schema validator | Sections are headings only; LLM may add own |
| Decide action by Role | Role enum is `plan/implement/review` but not enumerated agent-side | LLM may invent `Role: planning` |
| Mutate README | Append Log + set Status, preserve other sections | LLM rewrites, drops rows, duplicates sections |
| Return | Format unspec'd | Orchestrator can't tell success from failure |
| Fail-fast on missing field | "ask orchestrator to amend" | No structured return; orchestrator ignores |

TTHW current: **5+ cognitive steps, 3+ underspec'd**. Target: 2 steps with explicit grammar + helper CLI.

#### DX Implementation Checklist (additions for Phase 2)

- [ ] Add `docker/opencode/config/run-readme.template.md` as canonical schema source.
- [ ] Spec exact regex for `Run dir:`, `Role:`, `Verdict:` lines in `build.md`.
- [ ] Rename header `status` → `Lifecycle:` to disambiguate from `Verdict:`.
- [ ] Provide exact post-edit text for `coder.md` and `thinker.md` in this plan before implementation.
- [ ] Define structured failure return shape (e.g. first line `ERROR: <reason>` or `Verdict: BLOCK` + machine-readable reason in Log).
- [ ] Define defaults table: missing `Role:`, missing `Run dir:`, missing `Goal`, missing `Status` → behavior.
- [ ] Glossary block in `build.md` defining `BLOCK / SUBSTANTIVE / NIT / MERGED`.
- [ ] Document non-standard cases: multi-repo run, resume-after-crash, human-edit-mid-flight.

### Cross-phase themes (concerns flagged in 2+ phases independently)

- **Subagent contract is the load-bearing crack.** CEO + Eng + DX all surfaced it. Already pulled into Phase 2 scope via the premise gate.
- **Markdown vs typed state.** CEO + Eng + DX all wanted a `state.json` sidecar OR a `runs-cli` helper. Cut from v1 after worst-case-drift analysis showed bounded blast radius (1–2 wasted iterations per drift event; load-bearing `Verdict:` field already protected by orchestrator validator). Re-evaluate as a Phase 7 follow-up if Phase 6 integration or production shows recurrent drift.
- **Run-id collision / locking.** CEO + Eng both raised; runner-owned IDs + worktree leases are the consistent fix.
- **Status/Verdict semantics + enforcement.** Eng + DX both raised; rename to `Lifecycle:` + `Verdict:` with orchestrator validator.
- **Test step regression.** Eng (both voices) flagged High; DX implicit.
- **docker-volumes path inconsistency.** Eng (both voices) flagged Low/Medium — `docker-volumes/workspace/runs/.gitkeep`, not `docker-volumes/runs/.gitkeep`.

### Decision Audit Trail (auto-decided)

| # | Phase | Decision | Classification | Principle | Rationale |
|---|---|---|---|---|---|
| 1 | CEO | Mode: SELECTIVE EXPANSION | Mechanical | P6 bias-to-action | Per /autoplan rule |
| 2 | CEO | Run dual voices | Mechanical | P6 | Per /autoplan rule |
| 3 | CEO | Premise gate → user | Human | — | User chose REVISE |
| 4 | CEO | Bring coder.md/thinker.md edits in scope | Resolved | P1 completeness | User accepted recommendation |
| 5 | Eng | Add T1–T11 test plan to Phase 3 | Mechanical | P1 + P5 | Tests ARE the verification surface |
| 6 | Eng | Restore Test step (or fold into Implement w/ verification artifact) | Surfaced | P1 + P3 | Both voices High; surfaced as taste decision |
| 7 | Eng | Cut `runs-cli` helper from v1; subagents edit README directly | Resolved | P5 + measurement-first | User override after worst-case-drift analysis showed bounded blast radius. Revisit as Phase 7 follow-up if drift observed in Phase 6 or production. |
| 8 | Eng | docker-volumes path → `docker-volumes/workspace/runs/.gitkeep` | Auto-decide | P3 pragmatic | Both voices flagged; existing pattern wins |
| 9 | Eng | Runner worktree lease | Surfaced | P5 | Runner-owned vs orchestrator-owned is a real architecture choice |
| 10 | Eng | Verdict enum validator at orchestrator | Auto-decide | P1 + P5 | Both voices flagged; enforce or break |
| 11 | DX | Rename header `status:` → `Lifecycle:` | Auto-decide | P5 explicit | Both voices High; cheap rename |
| 12 | DX | Required literal field prefixes (`Run-ID:`, `Repo:`, `Lifecycle:`, `Verdict:`) | Auto-decide | P5 | Grep-determinism is a real human DX need |
| 13 | DX | Header parsing regex spec'd in build.md | Auto-decide | P1 + P5 | Both voices Critical |
| 14 | DX | Add `run-readme.template.md` canonical template | Surfaced | P1 | Both voices Critical; could go in plan-doc instead — taste call |
| 15 | DX | Pre-draft exact post-edit text for coder.md/thinker.md in this plan | Surfaced | P5 | Both voices High; ceremony tradeoff vs implementer freedom |
| 16 | DX | Defaults table for missing fields | Auto-decide | P1 completeness | Standard contract hygiene |
| 17 | DX | Glossary for verdict vocabulary in build.md | Auto-decide | P5 | Cheap; both voices flagged |
| 18 | Cross | Drop `<repo>` segment from run-id (Decision Log line 156) | Re-surfaced | — | Both voices argue this REDUCES uniqueness; revisit |

