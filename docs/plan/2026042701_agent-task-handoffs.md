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
- **Update `docker/opencode/config/agents/coder.md` and `thinker.md`** (in scope — subagent edits are required for the protocol to function on day one):
  - Teach each subagent to parse `Run dir:` and `Role:` from the prompt header.
  - Teach each subagent to read `<run-dir>/README.md` as task source of truth.
  - Teach each subagent to append a Log line and update Lifecycle/Verdict/Artifacts when finishing its role.
  - Teach each subagent the fail-fast contract: if the README is missing required content, return an error to the orchestrator rather than guessing.
- Make per-repo plan/feat conventions explicitly take precedence for in-repo durable artifacts.

**Out of scope:**

- Same pattern for the investigation protocol (separate plan if/when wanted).
- Automated archival or cleanup of old run dirs.
- Per-repo memory schema changes.
- Backfilling in-flight tasks into the new layout.

## Design

### Storage

New mount, peer to existing workspace dirs:

| Path                   | Access | Purpose                                    |
| ---------------------- | ------ | ------------------------------------------ |
| `/workspace/cron`      | RW     | Crontab for scheduled jobs                 |
| `/workspace/memory`    | RW     | Persistent agent memory                    |
| `/workspace/repos`     | RO     | Main repo clone                            |
| `/workspace/worklog`   | RO     | Tool call logs and session notes           |
| `/workspace/worktrees` | RW     | Git worktrees for code changes             |
| **`/workspace/runs`**  | **RW** | **Per-run scratch dir for agent handoffs** |

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

Short, structured, scannable. The canonical schema lives inline in `docker/opencode/config/agents/build.md` (the orchestrator instructions) as a fenced skeleton; `coder.md` and `thinker.md` reference build.md's sections by name instead of duplicating the spec.

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

| Missing                                             | Subagent behavior                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `Run dir:`                                          | Reply `ERROR: missing Run dir header` and stop. No fallback to "old protocol."         |
| `Role:`                                             | Reply `ERROR: missing Role header` and stop.                                           |
| `<run-dir>/README.md` does not exist                | Reply `ERROR: README not found at <path>` and stop.                                    |
| Required README field absent (Goal, etc.)           | Reply `ERROR: README missing <field>` and stop; orchestrator amends and re-dispatches. |
| Verdict written by `thinker review` is outside enum | Orchestrator validator rejects, retries once with corrective prompt, then escalates.   |

Anything else the subagent needs (available tools, MCP upstreams, skills, environment hints) is appended to the prompt by the orchestrator — it does not live in the README.

### Loop

Five steps, each reads and updates the README:

1. **Frame** — orchestrator creates `/workspace/runs/<id>/README.md` from the skeleton inlined in `build.md`, with header + goal filled in. One source of truth.
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

The phase set splits the work into a contract-foundation phase (template + direct edit rules), a subagent-edits phase, and behavioral verification before integration — the subagents must know the protocol, and the markdown contract must be tight enough for repeated LLM edits.

### Phase 1 — Volume mount

- Add `./docker-volumes/workspace/runs:/workspace/runs` (RW) to the `opencode` service in `docker-compose.yml`. The mount path stays under the existing `docker-volumes/workspace/<dir>` pattern; do **not** create a new top-level `docker-volumes/runs/`.
- Create `docker-volumes/workspace/runs/.gitkeep` so the host dir exists.
- Verify the container starts and the dir is writable from inside `opencode` and visible (per existing pattern) from any service that already binds the whole `/workspace` tree.

**Exit criteria:** `docker compose up` succeeds; `mkdir /workspace/runs/_smoke && rmdir /workspace/runs/_smoke` works inside the `opencode` container.

### Phase 2 — Schema foundation

Lock the contract before any agent code reads it.

- Inline the canonical README skeleton (header field-prefix lines plus `## Goal` / `## Artifacts` / `## Log` sections) directly into `docker/opencode/config/agents/build.md`. Required fields, field-prefix order, and glossary live there. `coder.md` and `thinker.md` reference build.md's sections by name instead of duplicating the spec.
- Subagents and the orchestrator edit the README directly using their existing file-edit tools:
  - **Frame (run init)** — orchestrator copies the skeleton from build.md, fills `Run-ID:`, `Repo:`, `Branch:`, `Worktree:`, sets `Lifecycle: open`, leaves `Verdict:` empty, fills the Goal section.
  - **Log appends** — shell append (`echo "<timestamp> <agent>: <message>" >> README.md`) or the agent's Edit tool. Append-only; never rewrite the Log section.
  - **Verdict / Lifecycle** — replace the existing field-prefix line in place. Never duplicate it.
  - **Artifacts** — insert a new row into the table; never rewrite the table.
- No helper CLI in v1. Drift is bounded (worst case: 1–2 wasted subagent iterations per drift event; the load-bearing `Verdict:` field is protected by the orchestrator-side validator in Phase 3). If recurrent drift is observed in Phase 6 or in production, add `runs-cli` as a Phase 7 follow-up.
- Free-form artifacts (`plan.md`, `review.md`, `verify.sh`, `fixtures/`) are written directly by subagents.

**Exit criteria:** `build.md` contains the README skeleton inline as a single fenced block starting with `Run-ID:`; a sample populated README built from that skeleton satisfies the field-prefix order, required sections, and verdict/lifecycle enums when checked by the static validator script (Phase 5 T2).

### Phase 3 — Build.md rewrite (orchestrator)

- Add `/workspace/runs` to the path table.
- Replace the existing "Code change protocol" with the README-centric **5-step loop** (Frame → Plan → Implement → Test → Review). Test is preserved as a first-class step — the existing testing policy in `build.md` does not regress.
- Document the run-dir layout, run-id scheme (`YYYYMMDD-HHMMSS-<slug>[-<thread-ts>]`), README schema (the inline skeleton), header field-prefix lines, glossary.
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

**Exit criteria:** both subagent files contain the documented contract; a manual prompt-paste smoke ("Run dir: /workspace/runs/\_missing\nRole: plan\n\nfoo") returns the expected `ERROR: README not found at /workspace/runs/_missing/README.md` from `thinker`, and `coder` rejects unsupported roles with `ERROR:`.

### Phase 5 — Verification

No static lint — see Decision Log for why. Verification is behavioral, against the running stack:

- **Mount smoke.** `docker compose up` succeeds; `mkdir /workspace/runs/_smoke && rmdir` works inside `opencode`. `runner` retains RW on `/workspace/runs/` through the existing whole-workspace bind — v1 accepts this dual-writer surface.
- **Subagent smokes** (run during Phase 6 with the stack up): missing-README → `ERROR:` reply; coder log-append → exactly one new Log line; review verdict → in `{BLOCK, SUBSTANTIVE, NIT}` (force `Verdict: NEEDS_WORK` → orchestrator retries once); single-word coder prompt → reads README without asking for more context; `Run dir: /workspace/memory/../../etc` → rejected.

**Exit criteria:** mount smoke passes; subagent smokes pass during Phase 6.

### Phase 6 — Integration verification

- Push the branch and let the relevant workflow run (or dispatch manually).
- Drive a real non-trivial Slack task and confirm:
  - Orchestrator creates `/workspace/runs/<id>/README.md` from the skeleton in build.md.
  - `thinker` and `coder` update the README directly (Log appends, Artifacts rows, field-prefix lines) and add supporting files only when warranted.
  - The `Verdict:` line drives iterate-vs-stop and the orchestrator's validator passes.
  - One iteration loop on a forced `BLOCK` works end-to-end.
  - Watch for drift — duplicate sections, dropped Artifacts rows, lost Log lines, malformed `Verdict:`. If observed, capture as evidence to motivate a follow-up `runs-cli` helper.
- Open a PR against `main` once push checks are green.

**Exit criteria:** one end-to-end task completes through the new loop with a populated README, valid `Verdict:`, and only the supporting files that were useful.

Verification is behavioral against the running stack: local checks confirm the rendered Docker Compose config includes the `/workspace/runs` mount, and live Slack/subagent smoke runs in the pushed environment because it requires the running Thor/OpenCode stack and real service credentials.

### Phase 7 — Deferred (out of scope of this plan)

Tracked here so they don't get lost; not part of this PR.

- **`runs-cli` helper for atomic structured-field writes.** Speced and then cut from v1 after worst-case-drift analysis: realistic worst case is 1–2 wasted subagent iterations per drift event, the load-bearing `Verdict:` field is already protected by the orchestrator-side validator, PRs still get human review, and run dirs are scratch (no durable consumer). Add only if Phase 6 integration or production usage shows recurrent drift.
- **Runner-owned worktree lease.** Today the orchestrator mints run-ids and worktree reuse is shared across runs (`build.md:113`). A runner-owned lease (1 active run per worktree) is the correct long-term shape per CEO + Eng review. Defer until we observe a real concurrency incident or migrate to runner-owned task state.
- **Runner-issued opaque run IDs.** Same parent decision: when the runner owns task state, it owns ID minting. Keep the seconds-granularity scheme until then.
- **Generalize to `kind:` (investigate, qa, pr-review).** Original "Future" section. Land coding first, generalize from evidence.
- **Per-kind Status vocabularies and lifecycle rules** — same.
- **Automated archival / TTL for old run dirs** — manual deletion is fine to start.

## Decision Log

| Decision                                                                                                                | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | -------------------------------- | ---------------------------------------------------------- |
| Name the mount `/workspace/runs/` (not `tasks/` or `handoffs/`)                                                         | `tasks/` collides semantically with opencode's built-in `task` tool and `permission.task` config — same word, different identifiers, ambiguous in conversation. `handoffs/` biases toward the linear coding case and reads strained for investigations. `runs/` is lifecycle-agnostic and works for every workflow we plan to extend to.                                                                                                                                                                     |
| Single required `README.md` per run, everything else on demand                                                          | One rule instead of a fixed file set or weight tiers. Tiny tasks stay tiny; complex tasks accumulate files organically, always indexed from the README.                                                                                                                                                                                                                                                                                                                                                      |
| Separate `/workspace/runs/` mount instead of nesting under `memory/<repo>/runs/`                                        | Memory is curated and permanent; run scratch is verbose and ephemeral. Co-locating muddles grep semantics and lifecycle rules.                                                                                                                                                                                                                                                                                                                                                                               |
| Drop `<repo>` segment from the run path                                                                                 | Keep the path short. `repo` lives in the README header, so the run-id alone is unique and tools can still filter.                                                                                                                                                                                                                                                                                                                                                                                            |
| Run-id `<YYYYMMDD-HHMMSS>-<slug>[-<thread-ts>]`                                                                         | Sortable, unique enough for v1 without coordination, human-readable. Slack ts suffix optional.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Verdict line `BLOCK                                                                                                     | SUBSTANTIVE                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | NIT | MERGED`in README`Verdict:` field | Mechanical iterate-vs-stop decision without parsing prose. |
| No enforced `iterations/<n>/` split                                                                                     | Iteration history lives in the README Log; agents freely add or replace supporting files. Forcing a numbered split adds ceremony without value for the common case.                                                                                                                                                                                                                                                                                                                                          |
| Distillation runs out of band, not in the main loop                                                                     | Worklog and memory updates are a separate daily/weekly pass (design TBD). Keeping them out of the main loop keeps run completion fast and lets the distillation policy evolve independently.                                                                                                                                                                                                                                                                                                                 |
| Tool/skill hints pass via subagent prompt, not README                                                                   | Runtime info changes between invocations; storing it in a durable artifact means stale hints and a forced rewrite on every call. README captures task content; prompts carry environment.                                                                                                                                                                                                                                                                                                                    |
| Worklog stays read-only and unchanged                                                                                   | Append a pointer line to the existing session note rather than writing artifacts there; preserves its role as the durable index.                                                                                                                                                                                                                                                                                                                                                                             |
| No automatic archival in this change                                                                                    | Cleanup policy can wait until we see real volume; manual deletion is fine to start.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Per-repo plan/feat conventions take precedence                                                                          | Repos already define plan format, location, and decision-log schema in their own `AGENTS.md`. The run dir holds inter-agent scratch; durable plans stay where the repo expects them.                                                                                                                                                                                                                                                                                                                         |
| Mount layout: `docker-volumes/workspace/runs:/workspace/runs` (not `docker-volumes/runs/`)                              | Keep the established `docker-volumes/workspace/<dir>` pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5-step loop with explicit `Test` step (not 4-step)                                                                      | The existing `build.md` testing policy is load-bearing — coder runs targeted tests before review. Folding it into Implement loses the explicit gate.                                                                                                                                                                                                                                                                                                                                                         |
| No helper CLI in v1; subagents edit the README directly                                                                 | A CLI (`runs init`, `log`, `verdict`, `lifecycle`, `artifact`, `cat`) was cut after worst-case-drift analysis: realistic worst case is one wasted subagent iteration when a stale-snapshot rewrite drops a Log line or Artifacts row. The load-bearing `Verdict:` field is already protected by the orchestrator-side validator (Phase 3), PRs still get human review, and run dirs are scratch with no durable consumer. Revisit as a Phase 7 follow-up if integration or production shows recurrent drift. |
| `Lifecycle:` (open/merged/abandoned) and `Verdict:` (BLOCK/SUBSTANTIVE/NIT/MERGED) are different fields                 | A single overloaded `Status` field conflated the two — `MERGED` overlapped with the header lifecycle. Splitting also makes both fields independently grep-able.                                                                                                                                                                                                                                                                                                                                              |
| Required literal field prefixes at top of README (`Run-ID:`, `Repo:`, `Branch:`, `Worktree:`, `Lifecycle:`, `Verdict:`) | Locked literal prefixes give deterministic `grep -l` for "all open runs" / "all blocked runs" without parsing markdown.                                                                                                                                                                                                                                                                                                                                                                                      |
| Run-id at seconds granularity (`YYYYMMDD-HHMMSS`), not minutes                                                          | Minute granularity collides on concurrent Slack mentions or retries; dropping `<repo>` from the path made it worse. Seconds + slug + optional thread-ts is sufficient until runner-owned IDs land in Phase 7.                                                                                                                                                                                                                                                                                                |
| Orchestrator-side `Verdict:` enum validator after every `task()` call                                                   | Without the helper CLI, the orchestrator post-condition check is the only gate that protects iterate-vs-stop logic from model drift. Reads the README, asserts the enum, retries once with a corrective prompt, then escalates.                                                                                                                                                                                                                                                                              |
| Subagent prompt deltas pre-drafted in Phase 4, not freestyled by implementer                                            | The protocol is the contract. Letting Phase 4 invent the contract surface during implementation reintroduces drift across the three files. Pre-drafting + behavioral smokes (Phase 5) catch drift.                                                                                                                                                                                                                                                                                                           |
| Defer runner-owned worktree lease + opaque run-IDs to Phase 7                                                           | Both are correct long-term but require runner state-model changes that exceed this plan's scope. Seconds-granularity IDs + worktree-reuse-with-best-effort is the v1 choice. Revisit on first observed concurrency incident.                                                                                                                                                                                                                                                                                 |
| No static `lint-runs-protocol` script                                                                                   | A lint that grepped the three markdown files for magic strings was dropped: it didn't catch real protocol failures (subagent ignores its role, format drifts in ways the regex can't see, path resolution breaks) and had to be updated in lockstep with every error-string change. Phase 5 is behavioral verification only.                                                                                                                                                                                 |
| Inline the README skeleton into `build.md` instead of a separate `run-readme.template.md` file                          | Once build.md already carries the field list, glossary, and section names, a separate template file is a second copy of the same prose with extra indirection. Inlining keeps build.md self-contained; subagent files reference build.md's section names.                                                                                                                                                                                                                                                    |

---
