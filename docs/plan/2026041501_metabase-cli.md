<!-- /autoplan restore point: /Users/son.dao/.gstack/projects/scoutqa-dot-ai-thor/metabase-support-autoplan-restore-20260415-121605.md -->

# Plan: Metabase CLI -- data warehouse query access for OpenCode

**Date**: 2026-04-15
**Status**: Reviewed

## Goal

Give Thor's agent read-only access to a Metabase data warehouse so it can query product, growth, revenue, and support data to answer business questions, investigate user issues, and generate data-backed reports.

## Why

Thor already has code access (git/gh), project management (Atlassian), and monitoring (PostHog) tools. Adding Metabase unlocks the data layer. This turns Thor into an agent that can answer data questions without a human running queries manually.

## Architecture

Follow the proven `remote-cli` pattern: a thin CLI wrapper in the OpenCode container calls an HTTP endpoint on the `remote-cli` service, which executes Metabase API requests using a server-side API key.

```
OpenCode container          remote-cli service           Metabase API
+--------------+            +------------------+         +------------------+
| metabase     |--HTTP-->   | POST /exec/      |--HTTP-->| Metabase         |
| (shell       |            |   metabase       |         | instance         |
|  wrapper)    |<--JSON--   |                  |<--JSON--| (read-only role) |
+--------------+            +------------------+         +------------------+
```

**Prerequisite**: The Metabase API key MUST be scoped to a read-only database role. This is the primary security boundary. All other safety measures are defense-in-depth.

### Why not a new service or MCP upstream?

- **Not a new service**: Metabase is a stateless HTTP API call. The `remote-cli` service already handles this pattern. Adding another endpoint is ~100 lines.
- **Not an MCP upstream**: The proxy + MCP pattern adds complexity (connection lifecycle, tool registration). Metabase needs exactly two operations: query and schema exploration. A CLI is simpler and follows the git/gh precedent.
- **Not the data proxy**: The `docker/data/` nginx proxy handles simple credential injection. But schema allowlist filtering and response truncation need code, so remote-cli is the better fit.

## CLI Design

**Name**: `metabase` -- shell wrapper in `docker/opencode/bin/metabase`

### Usage

```bash
metabase schemas                                    # list allowed schemas
metabase tables <schema>                            # list tables in a schema
metabase columns <schema> <table>                   # list columns for a table
metabase query '<SQL>'                              # run a read-only SQL query
```

### Subcommands

| Subcommand                 | Description                             | Metabase API                                             |
| -------------------------- | --------------------------------------- | -------------------------------------------------------- |
| `schemas`                  | List allowed schemas                    | `GET /api/database/{id}/schemas` (filtered by allowlist) |
| `tables <schema>`          | List tables in schema                   | `GET /api/database/{id}/schema/<schema>`                 |
| `columns <schema> <table>` | Column names + types for a table        | `GET /api/table/<table_id>/query_metadata`               |
| `query '<sql>'`            | Execute read-only SQL, return JSON rows | `POST /api/dataset`                                      |

### Output format

- **schemas**: JSON array of schema names
- **tables**: JSON array of `{ name, id, description }` objects
- **columns**: JSON array of `{ name, type, description }` objects
- **query**: JSON object `{ columns: string[], rows: any[][], row_count: number }`

### Authentication

Uses Metabase API key via `x-api-key` header. API keys don't expire like session cookies.

**Verified API endpoints** (tested 2026-04-15):

| Endpoint                           | Method | Auth        | Purpose                                                                    |
| ---------------------------------- | ------ | ----------- | -------------------------------------------------------------------------- |
| `/api/database/{id}/schemas`       | GET    | `x-api-key` | List schemas                                                               |
| `/api/database/{id}/schema/<name>` | GET    | `x-api-key` | List tables (returns `[{name, id, ...}]`)                                  |
| `/api/table/<id>/query_metadata`   | GET    | `x-api-key` | Column metadata (returns `{fields: [{name, database_type, ...}]}`)         |
| `/api/dataset`                     | POST   | `x-api-key` | Run SQL query (body: `{database:id, type:"native", native:{query:"..."}}`) |

**Note**: `columns` requires a two-step lookup -- first get table ID from the schema listing, then fetch metadata by ID.

**Query response shape** (from Metabase):

```json
{
  "data": { "rows": [[...]], "cols": [{"name":"...", "database_type":"...", ...}] },
  "row_count": 1,
  "status": "completed",
  "running_time": 21
}
```

### Safety model

1. **Primary boundary**: Metabase API key is scoped to a read-only database role. This is a hard deployment prerequisite. If the key has write access, no amount of application-level checks will fix it.
2. **Schema allowlist** (`METABASE_ALLOWED_SCHEMAS`): UX-level filtering, not a security boundary. Helps the agent navigate by hiding irrelevant schemas. Enforced at discovery level only (schemas/tables/columns commands). Not enforced on raw SQL queries -- the DB role handles that.
3. **No credential exposure**: `METABASE_API_KEY` lives only in the remote-cli service env. Never passed to OpenCode container.
4. **No response truncation**: OpenCode already truncates tool output. The service returns full Metabase responses.

### Environment variables

| Var                        | Required | Description                                                          |
| -------------------------- | -------- | -------------------------------------------------------------------- |
| `METABASE_URL`             | Yes      | Base URL of the Metabase instance                                    |
| `METABASE_API_KEY`         | Yes      | API key for `x-api-key` header (must be scoped to read-only DB role) |
| `METABASE_DATABASE_ID`     | Yes      | Target database ID                                                   |
| `METABASE_ALLOWED_SCHEMAS` | Yes      | Comma-separated list of allowed schema names (UX filtering)          |

## Phases

### Phase 1: remote-cli endpoint + Metabase client

Add `POST /exec/metabase` to the remote-cli service.

**Files to modify**:

- `packages/remote-cli/src/index.ts` -- new `/exec/metabase` route (no `validateCwd`, no `computeGitAlias`)
- `packages/remote-cli/src/policy.ts` -- new `validateMetabaseArgs()` validator
- `packages/remote-cli/src/metabase.ts` -- **new file**: Metabase API client

**Metabase client** (`metabase.ts`):

```typescript
// Core functions:
export async function listSchemas(): Promise<string[]>;
export async function listTables(schema: string): Promise<TableInfo[]>;
export async function getColumns(schema: string, tableName: string): Promise<ColumnInfo[]>;
export async function executeQuery(sql: string): Promise<QueryResult>;

// Config from env:
// METABASE_URL -- base URL
// METABASE_API_KEY -- API key (x-api-key header)
// METABASE_DATABASE_ID -- database ID
// METABASE_ALLOWED_SCHEMAS -- comma-separated allowlist
```

**Policy validation** (`validateMetabaseArgs()`):

- Subcommand must be one of: `schemas`, `tables`, `columns`, `query`
- `tables` requires exactly 1 arg (schema name), must be in allowlist
- `columns` requires exactly 2 args (schema, table), schema must be in allowlist
- `query` requires exactly 1 arg (SQL string)
- No SQL keyword blocking -- read-only DB role is the real boundary

**Route handler notes**:

- Do NOT call `validateCwd` -- metabase is not repo-scoped
- Do NOT log raw SQL args -- log subcommand + schema name only, never query text (PII risk)
- Return full Metabase response (OpenCode handles truncation)

**Exit criteria**:

- [ ] `schemas` returns only allowed schemas
- [ ] `tables` for an allowed schema returns table list
- [ ] `tables` for a non-allowed schema returns 400
- [ ] `columns` for an allowed schema returns column info
- [ ] `query` with `SELECT 1 AS test` returns result
- [ ] Route does not log raw SQL text
- [ ] Unit tests pass for policy validation and schema allowlist

### Phase 2: OpenCode CLI wrapper + remote-cli integration

Add the `metabase` shell wrapper to the OpenCode container and update `remote-cli.ts` client.

**Files to create/modify**:

- `docker/opencode/bin/metabase` -- **new file**: shell wrapper (like `git`, `gh`)
- `packages/opencode-cli/src/remote-cli.ts` -- add `metabase` endpoint support

**Shell wrapper** (`docker/opencode/bin/metabase`):

```bash
#!/bin/sh
exec node /usr/local/bin/remote-cli.mjs metabase "$@"
```

**remote-cli.ts changes**:

- Add `metabase` to the valid endpoints list
- Metabase uses buffered JSON response (not streaming like scoutqa)
- Do not send `cwd` for metabase requests (not repo-scoped)

**Exit criteria**:

- [ ] `metabase schemas` from inside OpenCode container returns schema list
- [ ] `metabase query 'SELECT 1'` returns query result
- [ ] Help text shown for `metabase` with no args or `metabase --help`

### Phase 3: Metabase skill (agent instructions)

Create a metabase skill file so the agent knows how to use the `metabase` CLI when a user mentions metabase or asks a data question.

**Files to create/modify**:

- `docker/opencode/agents/metabase.md` -- **new file**: subagent skill with metabase CLI usage instructions
- `docker/opencode/agents/build.md` -- add `metabase` to the subagent list and delegation hints

**Skill content** (`metabase.md`):

- CLI usage: `metabase schemas`, `metabase tables <schema>`, `metabase columns <schema> <table>`, `metabase query '<SQL>'`
- Output format for each subcommand
- Workflow: discover schemas -> find tables -> check columns -> write query
- Read-only access (enforced by DB role)

**Exit criteria**:

- [ ] `metabase.md` subagent file exists with CLI instructions
- [ ] `build.md` references metabase skill in subagent list
- [ ] Agent can invoke metabase subagent when asked a data question

### Phase 4: Docker + deployment config

Wire up environment variables and update Docker config.

**Files to modify**:

- `docker-compose.yml` -- pass `METABASE_API_KEY`, `METABASE_DATABASE_ID`, `METABASE_ALLOWED_SCHEMAS` to remote-cli service
- `Dockerfile` -- include `metabase` wrapper in PATH (root Dockerfile, not docker/opencode/Dockerfile)
- `README.md` -- document new env vars and read-only DB role prerequisite

**Exit criteria**:

- [ ] `docker compose up` starts remote-cli with Metabase config available
- [ ] OpenCode container has `metabase` in PATH
- [ ] README documents setup including read-only role prerequisite

---

## Decision Log

| #   | Decision                                                 | Rationale                                                                                                                                                 |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Add to remote-cli, not a new service                     | Metabase is a simple HTTP API. Same pattern as git/gh. No reason for a separate service.                                                                  |
| 2   | CLI, not MCP upstream                                    | Only 4 operations needed (schemas/tables/columns/query). MCP adds connection lifecycle overhead for no benefit.                                           |
| 3   | No SQL keyword blocking                                  | Read-only DB role is the real boundary. Keyword blocklist is trivially bypassable and gives false confidence. Dropped per review.                         |
| 4   | Schema allowlist is UX, not security                     | `METABASE_ALLOWED_SCHEMAS` filters discovery commands to help the agent navigate. Not enforced on queries. DB role permissions are the security boundary. |
| 5   | No response truncation                                   | OpenCode already truncates tool output. Service returns full Metabase responses.                                                                          |
| 6   | No timeout override                                      | Use Metabase's default timeout.                                                                                                                           |
| 7   | No `cwd` parameter                                       | Unlike git/gh, Metabase queries aren't repo-scoped. Client skips sending cwd, route skips validateCwd.                                                    |
| 8   | API key auth (not session cookie)                        | API keys don't expire like session cookies -- no refresh problem.                                                                                         |
| 9   | Metabase skill as subagent with minimal build.md changes | Metabase instructions loaded on-demand via subagent. build.md gets a delegation hint, not full instructions.                                              |
| 10  | Two-step column lookup                                   | Metabase's column metadata API requires table ID, not schema+name. The service resolves the ID from the schema listing.                                   |
| 11  | Single database per deployment                           | `METABASE_DATABASE_ID` env var. No CLI flag to switch.                                                                                                    |
| 12  | Do not log raw SQL                                       | SQL queries may contain PII (emails, account IDs). Log subcommand and schema only.                                                                        |
| 13  | Read-only DB role is a hard prerequisite                 | Primary security boundary. Documented in README and env var description.                                                                                  |

## Out of Scope

- **Saved questions / dashboards**: We query raw SQL, not Metabase's saved question API.
- **Visualization**: No chart rendering. The agent returns data as JSON.
- **Query caching**: Metabase has its own query cache. No need to add another layer.
- **Multi-database support**: Single database via env var. No CLI flag to switch.
- **API key rotation UI**: If the key is revoked, generate a new one in Metabase admin.
- **User-facing validation**: Whether Thor answers business questions correctly is deferred. This plan is infrastructure.

## Risks

| Risk                                              | Mitigation                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| API key revoked/rotated                           | Monitor for 401 responses, log clearly. Document rotation procedure.                                   |
| Agent writes expensive queries (full table scans) | Metabase's own timeout handles this. OpenCode truncates large tool output.                             |
| API key has broader access than allowlist         | The allowlist is UX-only. The DB role is the real boundary. Verify role permissions during deployment. |
| SQL queries in logs leak PII                      | Route logs subcommand + schema only, never raw SQL text.                                               |
| Metabase API rate limiting                        | Unlikely for internal instance. Add retry with backoff if encountered.                                 |

<!-- AUTONOMOUS DECISION LOG -->

## Decision Audit Trail

| #   | Phase | Decision                              | Classification | Principle | Rationale                                                                               |
| --- | ----- | ------------------------------------- | -------------- | --------- | --------------------------------------------------------------------------------------- |
| 1   | CEO   | Keep remote-cli (not data proxy)      | User-decided   | --        | User chose: schema allowlist needs code                                                 |
| 2   | CEO   | Drop keyword blocklist                | User-decided   | --        | Both voices agree, user confirmed                                                       |
| 3   | CEO   | Keep scope minimal (infra only)       | User-decided   | --        | User chose: validation later                                                            |
| 4   | CEO   | Fix Decision 9 contradiction          | Mechanical     | P5        | Decision 9 said "not build.md" but Phase 3 modifies it. Updated wording.                |
| 5   | CEO   | Keep single database                  | Mechanical     | P3        | User already explicitly chose this.                                                     |
| 6   | Eng   | Reframe allowlist as UX, not security | Mechanical     | P5        | Both voices: allowlist not enforced on queries. DB role is boundary.                    |
| 7   | Eng   | No response truncation                | User-decided   | --        | OpenCode already truncates tool output. No need for service-level cap.                  |
| 8   | Eng   | Fix shell wrapper path                | Mechanical     | P3        | Codex: `/opt/opencode/remote-cli.mjs` wrong, should be `/usr/local/bin/remote-cli.mjs`. |
| 9   | Eng   | Fix Dockerfile reference              | Mechanical     | P3        | Codex: `docker/opencode/Dockerfile` wrong, integration in root `Dockerfile`.            |
| 10  | Eng   | Skip cwd for metabase                 | Mechanical     | P5        | Claude subagent: client sends cwd unconditionally, route must not validate it.          |
| 11  | Eng   | Do not log raw SQL                    | Mechanical     | P5        | Codex: PII risk. Log subcommand + schema only.                                          |
| 12  | Eng   | Keep Phase 3 in plan                  | Taste          | P6        | Codex says split out, but user explicitly requested it. Keep it.                        |

## GSTACK REVIEW REPORT

| Review             | Trigger               | Why                            | Runs | Status          | Findings                          |
| ------------------ | --------------------- | ------------------------------ | ---- | --------------- | --------------------------------- |
| CEO Review         | `/plan-ceo-review`    | Scope & strategy               | 1    | issues_resolved | 3 user-decided, 5 auto-decided    |
| Codex Review (CEO) | `codex exec`          | Independent strategy challenge | 1    | complete        | 7 findings, 4 open questions      |
| Codex Review (Eng) | `codex exec`          | Architecture challenge         | 1    | complete        | 5 findings (2 P0, 3 P1)           |
| Eng Review         | `/plan-eng-review`    | Architecture & tests           | 1    | issues_resolved | 6 findings across both voices     |
| Design Review      | `/plan-design-review` | UI/UX gaps                     | 0    | skipped         | No UI scope                       |
| DX Review          | `/plan-devex-review`  | Developer experience           | 0    | skipped         | Covered by eng review (4-cmd CLI) |

**VERDICT:** REVIEWED. 3 user decisions, 9 auto-decisions, 2 taste decisions surfaced. All P0 issues resolved. Plan updated.
