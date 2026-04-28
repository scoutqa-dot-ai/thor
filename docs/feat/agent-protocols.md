# Agent Protocols

> Scope: how Thor structures multi-step work that spans the primary agent (`build`) and its subagents (`coder`, `thinker`). Each protocol is a named, file-based handoff pattern. Source of truth for the prompt-level rules: `docker/opencode/config/agents/{build,coder,thinker}.md`.

## Why protocols exist

Thor's primary agent runs in Slack and orchestrates work that often takes several subagent hops. Without structure, each hop re-narrates context from the chat thread, which is lossy and expensive. Protocols replace that with a shared run directory on disk: a small set of files that both the orchestrator and subagents read and append to, so each hop builds on the previous one instead of restating it.

A protocol is not a workflow engine. It is a vocabulary plus a file layout — agents follow it because the prompts say so, not because anything enforces it.

## Run directory: the shared substrate

Every protocol uses the same shared run directory under `/workspace/runs/<run-id>/`:

```
/workspace/runs/<run-id>/
  README.md          # task source of truth
  plan.md            # optional, code-change planning artifact
  review_<n>.md      # optional, numbered per review iteration
  findings_<n>.md    # optional, numbered per investigation hop
  verify.sh          # optional
  fixtures/          # optional
```

Run ID format: `<YYYYMMDD>-<slug>` (kebab-case slug). When tied to a Slack thread, the thread ts goes in a `Thread:` header inside the README — keeping it out of the filename so paths stay parseable.

The README is the task source of truth. It carries `Run-ID`, `Repo`, `Branch`, `Worktree`, optional `Thread`, `Lifecycle` (run lifetime), `Verdict` (latest review state), a `## Goal` paragraph, an `## Artifacts` table, and an append-only `## Log`. `Lifecycle` and `Verdict` values (`open` / `merged` / `abandoned`; `BLOCK` / `SUBSTANTIVE` / `NIT` / `MERGED`) are suggestions, not enums — agents may use other values when the suggested set genuinely doesn't fit.

Subagent invocation always passes the run dir, role, and runtime hints in the prompt — never the README contents. The subagent reads the README itself.

```
Run dir: /workspace/runs/<run-id>
Role: <plan|implement|review|investigate>

<short instruction plus current runtime hints>
```

The run directory is flexible scratch space, not an enforced format. If the target repo has its own way of work in `AGENTS.md` or `CLAUDE.md`, that wins — the run dir lives alongside repo conventions.

## Shared protocol shape

Every protocol follows the same skeleton:

| Step | Purpose |
|---|---|
| **Classify** | Triage gate — decide whether the protocol applies at all. |
| **Frame** | Create the run dir README. Refresh remote state before delegating. |
| **Delegate** | First subagent hop with explicit `Role:`. |
| *(work steps)* | Protocol-specific middle, e.g. implement+test, or further investigate hops. |
| **Iterate** | Read the README. Retry once on missing thinker output then escalate. Stop on a defined exit condition. |
| **Report** | Deliver the user-facing outcome. Prefer file upload over inline paraphrase. |

Subagent output is delivered to the user via **file upload, not paraphrase**, whenever the artifact is non-trivial. The chat reply points at the file; the file is the answer. This applies most strongly at any phase where the loop pauses or stops — the artifact (`plan.md`, `findings_<n>.md`, csv/txt for data) is uploaded verbatim instead of being re-narrated, because LLM paraphrasing introduces mistakes and makes review harder.

## Protocol: Code change

Used when the orchestrator needs to make code changes that warrant subagent involvement.

1. **Classify** — trivial change (single file, no new dependency/schema/migration, no cross-package effect, low blast radius) skips the protocol; orchestrator edits directly.
2. **Frame** — create README from skeleton; refresh remote state (latest `main`, open PRs on the branch, related tickets).
3. **Plan** — `task(thinker, Role: plan)`. Thinker writes `plan.md` if useful. If the loop pauses here (user wants plan only, or thinker is blocked), `plan.md` is uploaded verbatim.
4. **Implement + test** — `task(coder, Role: implement)`. Coder edits the worktree, runs targeted tests, logs the outcome. Coder owns testing — no separate test phase.
5. **Review** — `task(thinker, Role: review)`. Thinker sets `Verdict:` and may write `review_<n>.md` (next free integer).
6. **Iterate** — read README. On missing thinker output, retry once then escalate. On a verdict signaling defects/substantive issues, redispatch coder. Stop when only nitpicks remain.
7. **Report** — summarize what shipped (what changed, test outcome, PR link if applicable). After PR merge, set `Lifecycle: merged` and `Verdict: MERGED`.

Subagent roles touched: `thinker:plan`, `coder:implement`, `thinker:review`.

## Protocol: Investigation

Used for asks containing investigate / debug / root cause / why / analyze.

1. **Classify** — quick triage (label as preliminary, answer in chat) or full investigation. One sharp narrowing question if underspecified.
2. **Frame** — create README; Goal captures question, constraints, and a concrete anchor (failing instance ID, timestamp, or symptom text). Refresh remote state.
3. **Delegate** — `task(thinker, Role: investigate)`. Thinker reads the README, writes `findings_<n>.md` when prose is needed.
4. **Iterate** — read README. On missing thinker output, retry once then escalate. Otherwise re-dispatch `Role: investigate` for follow-up hops; thinker reads prior findings instead of being re-briefed. Treat thinker's "next I would check" as planning cues — decide and continue, don't bounce back. Stop when one lead dominates, alternatives are exhausted, or progress is blocked.
5. **Report** — synthesize with an evidence ladder (Confirmed fact / Strong inference / Open lead — never collapsed). Treat thread theories as context, not proof. Name source-of-truth limits explicitly. Self-audit before posting: fresh? owner identified? source verified? Deliver via file upload, not inline paraphrase.

Subagent roles touched: `thinker:investigate`.

The investigation method (anchor, nearest-hop chain, contradiction-hunting, absence-as-evidence, ownership resolution, source-of-truth limits, standard of proof for "likely bug") lives in `thinker.md` under the `investigate` role — the orchestrator supervises, thinker applies the method.

## Adding a new protocol

A new protocol is justified when a class of work (a) recurs often enough to standardize, (b) benefits from cross-hop state that the chat thread can't carry, and (c) has a clear exit condition. Examples that might earn one in the future: PR review (currently a sub-section in `build.md`, may graduate when the rules grow), incident response, scheduled health sweeps.

When adding one:

1. Reuse the shared shape (Classify → Frame → Delegate → middle → Iterate → Report). Skip steps that genuinely don't apply, but keep the names you do use.
2. Reuse the run-directory layout. New artifact types (`incident_<n>.md`, etc.) are fine — number them per hop the way `review_<n>` and `findings_<n>` do.
3. Add a new `Role:` value if the work doesn't fit the existing four (`plan`, `implement`, `review`, `investigate`), and define it in the relevant subagent prompt.
4. Document the protocol here alongside the existing two so the catalogue stays in one place.
5. Keep durable, instance-portable techniques in the agent prompts; keep instance-specific gotchas (tool quirks, per-repo patterns) in per-instance memory.
