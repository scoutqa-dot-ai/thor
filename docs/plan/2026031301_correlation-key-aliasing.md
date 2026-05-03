# Correlation Key Aliasing — 2026-03-13-01

> Allow different trigger flows to share the same OpenCode session by aliasing secondary correlation keys to an existing notes file.

## Problem

Today each trigger source generates its own correlation key independently:

| Source       | Format                       | Scope              |
| ------------ | ---------------------------- | ------------------ |
| Slack thread | `slack:thread:{ts}`          | Single thread      |
| GitHub event | `git:branch:{repo}:{branch}` | Single branch      |
| Cron         | `cron:{job}:{window}`        | Single time window |

These are isolated. When a cron job posts to Slack and a user replies in that thread, the reply gets `slack:thread:{ts}` — a different corr key. The session context is lost. Same problem when a Slack trigger creates a GitHub branch/PR and later GitHub events arrive for it.

## Design

### Storage: aliases in notes files

Aliases are appended to the notes file as h3 `### Session:` lines with free-form context below:

```markdown
# Session: cron:posthog-check:2026-03-08T06

Created: 2026-03-08T06:00:00Z
Session ID: abc123

## Trigger

**Prompt**: Check PostHog metrics
...

---

### Session: slack:thread:1710000000.123

Aliased from Slack thread reply to cron post in #ops-alerts

---

### Session: git:branch:acme/acme-project:feat/fix-login

Aliased from branch created during this session
```

- `# Session:` (h1) = canonical key, one per file
- `### Session:` (h3) = alias, appended as needed with context
- **Append-only** — no parallel write conflicts, same pattern as `appendTrigger`
- **No centralized index** — each notes file owns its aliases
- **Self-documenting** — reading any notes file shows all related channels

### Resolution

> **OUTDATED** — Single-key resolution replaced by multi-key resolution. See [Amendment: Multi-key correlation resolution](#amendment-multi-key-correlation-resolution--2026-03-18).

When an event arrives with raw corr key (e.g. `slack:thread:1710000000.123`):

1. **Alias scan** (always first): grep `worklog/*/notes/*.md` for `^#{1,3} Session: {rawKey}$`. If found, read the `# Session:` h1 line from that file to get the canonical corr key.
2. **No match**: `rawKey` is either already canonical or new. Use as-is.

Alias scan runs first because a key may have been aliased to a newer session. Direct lookup would find the old notes file and miss the newer context. Example: GitHub push creates session A, then a Slack review creates session B and aliases the branch key. New GitHub events should route to session B (the active conversation), not session A.

The scan is bounded — only `.md` files in recent day directories, typically 10-50 files. Cheap `readFileSync` + regex on the single matched file.

### Registration

> **OUTDATED** — Tool names and repo inference changed. See [Amendment: Multi-key correlation resolution](#amendment-multi-key-correlation-resolution--2026-03-18).

After a trigger completes, the runner inspects tool call results for cross-channel artifacts and appends aliases:

| Tool call result                                            | Alias registered             |
| ----------------------------------------------------------- | ---------------------------- |
| slack-mcp `post_message` (new thread) → returns `ts`        | `slack:thread:{ts}`          |
| slack-mcp `post_message` (reply) → has `thread_ts` in input | `slack:thread:{thread_ts}`   |
| git-mcp `git push` → pushes branch                          | `git:branch:{repo}:{branch}` |

## Decision Log

| #   | Decision                                                                 | Rationale                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Store aliases in notes files, not a central index**                    | Append-only, no parallel write conflicts, no staleness. Each notes file is self-contained.                                                                                       |
| D2  | **Use `### Session:` (h3) for aliases, `# Session:` (h1) for canonical** | Visually distinct in markdown. Single grep pattern `^#{1,3} Session:` matches both. Resolution reads h1 from matched file.                                                       |
| D3  | **Resolve in gateway before queueing**                                   | Ensures the event queue groups aliased events with the canonical key. No changes needed to runner session lookup.                                                                |
| D4  | **Register aliases in runner after trigger completes**                   | Runner already has the corr key and processes tool call results. Keeps correlation logic centralized.                                                                            |
| D5  | **Scan window bounded by worklog retention**                             | Only active (non-archived) day directories are scanned. Natural TTL via existing archival.                                                                                       |
| D6  | **No transitive resolution**                                             | All aliases point directly to a canonical key's notes file. Cron→Slack→GitHub: both Slack and GitHub aliases go in the cron's notes file. No chain lookups.                      |
| D7  | **Superseded: extract aliases from SSE stream tool call data**           | Current code registers aliases directly in producers that already have session context. The runner no longer collects completed tool artifacts for alias registration.           |
| D8  | **Alias both new threads and replies**                                   | New thread: alias the returned `ts`. Reply (`thread_ts` present): alias the `thread_ts` so future thread events route to this session. Self-aliases (key === alias) are skipped. |
| D9  | **Alias on checkout/switch, not just push**                              | Agent checking out a remote branch for review should receive future GitHub events for that branch. `pull`/`fetch` not needed — agent must already have checked out the branch.   |
| D10 | **No `github:pr:` aliases**                                              | GitHub events all use `git:branch:{repo}:{branch}` keys. PR activity arrives as push/PR events keyed by branch. A `github:pr:` alias would never be looked up.                   |

## Phases

### Phase 1 — Alias read/write in `@thor/common`

**Goal**: Add `registerAlias()` and `resolveCorrelationKey()` to `notes.ts`.

Steps:

1. Add `registerAlias(correlationKey, alias, context)` — appends a `### Session: {alias}` block to today's notes file for the given canonical corr key
2. Add `resolveCorrelationKey(rawKey)` — returns the canonical corr key:
   - Scan `worklog/*/notes/*.md` files for `^#{1,3} Session: {rawKey}$`. On match, read the file's h1 `# Session:` line to get the canonical key. Return it.
   - No match: return `rawKey` unchanged (either already canonical or new session)
   - Alias scan always runs first — a key may have been aliased to a newer session, and direct lookup would find the old stale file instead.
3. Add unit tests for both functions

**Exit criteria**:

- `registerAlias()` appends h3 alias block to the correct notes file
- `resolveCorrelationKey()` returns canonical key for aliased keys, passthrough for unknown keys
- Unit tests cover: direct hit, alias hit, no match, multiple aliases in one file

---

### Phase 2 — Gateway integration

**Goal**: Resolve aliases before queueing events.

Steps:

1. In `packages/gateway/src/app.ts` (or wherever events are queued): after computing the raw corr key, call `resolveCorrelationKey(rawKey)` and use the result as the queue key
2. Log when an alias resolves to a different canonical key

**Exit criteria**:

- Events with aliased corr keys are queued under the canonical key
- Existing direct corr keys work unchanged (no regression)

---

### Phase 3 — Runner alias registration

**Goal**: After a trigger completes, extract cross-channel identifiers from tool call results and register aliases.

#### Background: tool call data IS available in the SSE stream

The OpenCode SDK's `ToolStateCompleted` type includes:

- `input: { [key: string]: unknown }` — tool call args
- `output: string` — tool call result

The runner already receives `ToolPart` events via SSE. Currently it only collects `{ tool, state }` — but it can collect `input` and `output` too. No need to scan proxy worklog files.

#### Tools that produce alias artifacts

> **OUTDATED** — `post_message` became `slack_post_message`; git alias registration now happens in `remote-cli` with direct session context; repo inference changed. See [Amendment: Multi-key correlation resolution](#amendment-multi-key-correlation-resolution--2026-03-18).

| Tool name      | Input to inspect                | Output to extract         | Alias format                 |
| -------------- | ------------------------------- | ------------------------- | ---------------------------- |
| `post_message` | `thread_ts` absent → new thread | parse JSON for `ts` field | `slack:thread:{ts}`          |
| `post_message` | `thread_ts` present → reply     | (not needed)              | `slack:thread:{thread_ts}`   |
| `git`          | `args: ["push", ...]`           | (not needed)              | `git:branch:{repo}:{branch}` |
| `git`          | `args: ["checkout", ...]`       | (not needed)              | `git:branch:{repo}:{branch}` |
| `git`          | `args: ["switch", ...]`         | (not needed)              | `git:branch:{repo}:{branch}` |

**Not aliased**: `git pull`, `git fetch` (agent must already have checked out the branch), `create_pull_request` (GitHub events use `git:branch:` keys, not `github:pr:` keys — the branch alias already covers PR activity).

#### Implementation

1. Tool result schema — Zod discriminated union on `tool` field validates input shape per tool. Loose tool artifacts from the runner were narrowed via `safeParse`.

2. In the older runner stream loop, when a completed `ToolPart` matched an alias-producing tool, collect `{ tool, input, output }` into `collectedArtifacts`.

3. Alias extraction in `@thor/common`:
   - **`post_message`** (new thread): parse output JSON for `ts` → `slack:thread:{ts}`
   - **`post_message`** (reply): `thread_ts` in input → `slack:thread:{thread_ts}` (session is engaging with that thread)
   - **`git`** (`push`/`checkout`/`switch`): extract branch from args, infer repo from `cwd` path convention (`/workspace/repos/{owner}-{repo}`) → `git:branch:{repo}:{branch}`

4. After `appendSummary`, call `registerAlias()` for each extracted alias. Best-effort: failures logged, don't break the trigger response. Self-aliases (key === alias) are skipped.

#### Risks and mitigations

- **Repo inference**: `cwd` input or `GIT_MCP_DEFAULT_CWD` gives the local path. Path→repo mapping via convention: `/workspace/repos/{owner}-{repo}` → `{owner}/{repo}`.
- **Multiple `post_message` calls**: A session may post to multiple channels. Each gets its own alias. Correct — all should route back.
- **Output parsing**: `ToolStateCompleted.output` is a string. For `post_message` it's JSON (`{ok, ts, channel}`). Parsing is best-effort via Zod `safeParse`.

**Exit criteria**:

- After a trigger that calls `post_message` (new thread), the notes file contains a `### Session: slack:thread:{ts}` alias
- After a trigger that replies in a thread, the notes file contains a `### Session: slack:thread:{thread_ts}` alias
- After a trigger that pushes/checks out a branch, the notes file contains a `### Session: git:branch:{repo}:{branch}` alias
- Subsequent events for any alias resolve to the original session
- Failures in alias extraction don't break the trigger response

---

### Phase 4 — Cross-day alias resolution

**Goal**: Ensure aliases work across day boundaries.

Steps:

1. `resolveCorrelationKey()` already scans all active day directories (via glob). Verify this works when the alias was registered yesterday and the event arrives today.
2. `continueNotes()` creates today's notes file with a back-reference. Aliases stay in the original day's file. Resolution finds them because the scan covers all active days.
3. Add integration test: register alias on day N, resolve on day N+1.

**Exit criteria**:

- Alias registered on a previous day resolves correctly today
- No aliases are lost during cross-day continuation

---

## Out of Scope

- Transitive alias chains (all aliases must point to a canonical key directly)
- UI for viewing/managing aliases
- Automatic alias cleanup/expiry (bounded naturally by worklog retention)
- Database-backed alias storage

## Dependencies

| Dependency          | Version | Purpose                         | Status   |
| ------------------- | ------- | ------------------------------- | -------- |
| `@thor/common`      | —       | Notes utilities (extended)      | Existing |
| No new dependencies | —       | File scanning uses `fs` + regex | —        |

---

## Amendment: Multi-key correlation resolution — 2026-03-18

### Problem

The original design assumed the runner could infer the full `owner/repo` from the container filesystem path using a "first hyphen = owner separator" convention (e.g. `acme-project` → `acme/project`). This broke for multi-hyphen names like `acme-multi-hyphen-repo` where the owner is `acme-labs` — the heuristic produced `acme/multi-hyphen-repo` instead of `acme-labs/acme-multi-hyphen-repo`.

Additionally:

- **Worktree paths** (`/workspace/worktrees/{name}/{branch}`) were not matched by `inferRepoFromPath`, which only checked `/workspace/repos/`.
- **Tool names changed**: the `git` MCP tool was removed; git operations now go through the shell wrapper with direct alias registration in `remote-cli`. Similarly `post_message` became `slack_post_message`.

### Design change: multi-key resolution

Instead of trying to reconstruct the full `owner/repo` on the runner side, the gateway now emits **multiple correlation keys** for GitHub events:

```
getGitHubCorrelationKeys(event) → [
  "git:branch:acme-labs/acme-multi-hyphen-repo:feat/foo",   // canonical (full)
  "git:branch:acme-multi-hyphen-repo:feat/foo"              // alias (repo name only)
]
```

The runner registers aliases using only the directory name (no owner prefix):

```
inferRepoFromPath("/workspace/worktrees/acme-multi-hyphen-repo/feat/foo")
→ "acme-multi-hyphen-repo"
→ alias: "git:branch:acme-multi-hyphen-repo:feat/foo"
```

Resolution uses `resolveCorrelationKeys(rawKeys: string[])`:

1. Try resolving each key (both as h1 canonical and h3 alias) across all notes files.
2. Collect all matches with their file paths.
3. Sort by file path descending (paths contain dates → most recent wins).
4. Return the canonical key from the most recent match. Fall back to `rawKeys[0]` if nothing resolves.

This ensures that when an old session matches the canonical key but a newer session matches the alias key, the newer session wins.

### Changes

| Component                   | Change                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `gateway/src/github.ts`     | `getGitHubCorrelationKey()` → `getGitHubCorrelationKeys()`, returns `string[]` with canonical + short alias |
| `gateway/src/app.ts`        | Uses `resolveCorrelationKeys(rawKeys)` for GitHub events                                                    |
| `common/src/notes.ts`       | New `resolveCorrelationKeys()` — tries all keys, picks most recent match                                    |
| `common/src/notes.ts`       | New `grepAllNotesFiles()` — returns all matches instead of just first                                       |
| `common/src/notes.ts`       | `inferRepoFromPath` — matches `/workspace/worktrees/` paths, drops hyphen-split heuristic                   |
| `common/src/correlation.ts` | Git and Slack correlation helpers used by direct producer-side alias registration                           |

### Updated tool → alias mapping

| Tool name                | Input to inspect                | Output to extract         | Alias format                     |
| ------------------------ | ------------------------------- | ------------------------- | -------------------------------- |
| `slack_post_message`     | `thread_ts` absent → new thread | parse JSON for `ts` field | `slack:thread:{ts}`              |
| `slack_post_message`     | `thread_ts` present → reply     | (not needed)              | `slack:thread:{thread_ts}`       |
| `remote-cli` git wrapper | push args                       | (not needed)              | `git:branch:{repo-dir}:{branch}` |
| `remote-cli` git wrapper | checkout args                   | (not needed)              | `git:branch:{repo-dir}:{branch}` |
| `remote-cli` git wrapper | switch args                     | (not needed)              | `git:branch:{repo-dir}:{branch}` |

### Decision log (continued)

| #   | Decision                                                             | Rationale                                                                                                                                                                        |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D11 | **Gateway emits multiple corr keys (canonical + alias)**             | Runner cannot reliably infer `owner/repo` from filesystem. Gateway has the full name from GitHub webhooks. Short alias using repo-name-only matches what the runner can produce. |
| D12 | **Multi-key resolution picks most recent match**                     | An old session may match the canonical key while a newer session matches the alias. Most-recent wins ensures events route to the active conversation.                            |
| D13 | **Drop first-hyphen owner/repo inference**                           | Ambiguous for multi-hyphen names (e.g. `acme-multi-hyphen-repo`). No reliable heuristic exists. Directory name alone is sufficient as an alias key.                              |
| D14 | **Match `/workspace/worktrees/` in addition to `/workspace/repos/`** | Agent creates git worktrees for branches. Push/commit operations happen in worktree paths. Both must be recognized.                                                              |
