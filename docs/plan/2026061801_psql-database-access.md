# Read-only `psql` database access via remote-cli

Expose a wrapped `psql` to OpenCode so the agent can inspect and query operator-approved Postgres databases (RDS/Aurora and others), reusing the `aws` CLI passthrough pattern added on this branch (`docs/plan/2026061601_aws-write-approval.md`, PR #200) and the per-profile env resolution used by Grafana/Atlassian/PostHog (`docs/plan/2026052701_profile-based-integration-routing.md`, `docs/plan/2026060301_grafana-mcp-per-profile.md`).

The agent runs `psql <alias> -c "select ..."` exactly as it would real `psql`. The wrapper reinterprets the database positional as a **server-side alias**, resolves it to a full connection tuple from per-profile config, injects all credentials via env, and runs `psql` read-only. The agent never sees or supplies a host, username, or password.

## Goal

`POST /exec/psql` accepts a `psql` argv whose first positional is a connection **alias**. remote-cli resolves the session's profile, looks up the alias in that profile's `PSQL_DATABASES[_<PROFILE>]` bundle, injects `PG*` env from the resolved record, and executes `psql` with read-only enforcement (`-X -w`, `PGOPTIONS=-c default_transaction_read_only=on`, `ON_ERROR_STOP=1`). Connection-control flags supplied by the agent (`-h`, `-U`, `-p`, `-d`, connection URIs, `service=`) are rejected fail-closed. An unknown alias returns an error that lists the valid aliases for the current profile. There are no writes to gate, so V1 has no approval path.

## Decisions

| #   | Decision                                                                                                               | Rationale                                                                                                                                                                                                                                               | Rejected                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Expose a wrapped **`psql`**, not a custom `rds`/`thor-rds` tool surface                                                | AGENTS.md rule 10 + the Slack thread: mimic a CLI the model already knows so we never train it. The model knows `psql ... -c`, `\dt`, `\d`, `psql -l`. A bespoke `rds list-tables` discards that and still can't answer ad-hoc questions.               | Custom `rds` subcommands; a `usql`-style universal wrapper; a named-query registry (over-engineered, against repo grain). |
| 2   | Config prefix is **`PSQL_DATABASES_<PROFILE>`**, not `RDS_*`                                                           | RDS is an AWS infra detail irrelevant to the agent and to psql. Repo convention names config by tool/integration (`GRAFANA_*`, `ATLASSIAN_*`, `POSTHOG_*`). Naming by client binary makes the engine implicit and multi-engine symmetric.               | `RDS_*` (leaks infra, stale the moment a target isn't on RDS); `PG*` (collides with libpq's own env namespace).           |
| 3   | Engine is **implicit in the prefix**; no `engine` field in V1                                                          | Every entry in `PSQL_DATABASES_*` is Postgres by definition. A future `mysql` wrapper gets `MYSQL_DATABASES_*` — symmetric, no per-entry flag, no ambiguity.                                                                                            | A per-record `engine` field (dead weight while Postgres-only).                                                            |
| 4   | Agent picks a **logical target** (alias via the native dbname positional); operator config owns network target + creds | The Slack-thread trust boundary: if the model could choose `PGHOST`/`PGDATABASE`, injected creds would work against any reachable endpoint (cross-env reads, weak audit, exfil risk). Alias == dbname in almost every case, so it reads as native psql. | Letting the agent pass `PGHOST`/`PGDATABASE`; a non-native `--cluster`/`--db` flag (R11–R18: not native, invents syntax). |
| 5   | **Read-only by construction**, not by SQL parsing: read-only DB role + `default_transaction_read_only=on` + `-w`       | SQL-text classification is fragile and easy to bypass. A read-only role is the real boundary; the transaction-mode option is cheap defense-in-depth. With no writes possible, V1 needs no approval pipeline.                                            | Regex/keyword SQL read/write classification (like the aws verb split); exposing raw unguarded `psql`.                     |
| 6   | Per-profile bundle resolved **all-or-nothing** via the existing `scopedEnv` pattern, falling back to the global var    | Matches Grafana/Atlassian multi-value resolution and prevents silent credential flips between scoped and global values. One secret to manage per profile; add/remove databases with no code change.                                                     | Flat per-field vars (`PGHOST_QA_BILLING`, …) — hard to validate, painful to maintain (Slack-thread R10).                  |
| 7   | Reject connection-control flags from the agent; allow query/format flags through                                       | Keeps the trust boundary (decision 4) enforceable on a small, explicit deny-set while leaving the rest of psql's surface usable. Per rule 10, unlisted shapes are confirmed by the denial response so policy can tighten later.                         | A positive allowlist of every safe psql flag (large, drifts with psql versions).                                          |

## Phases

### Phase 1 — `PSQL_DATABASES` resolver in `packages/common`

- Add a profile-suffixed resolver (mirroring `scopedEnv` usage in `proxies.ts`): read `PSQL_DATABASES_<PROFILE>`, fall back to `PSQL_DATABASES`.
- Parse the JSON bundle into `alias -> { host, port, database, username, password, sslmode }`. Require `host`, `port`, `database`, `username`, `password`; default `sslmode` to `require`.
- Validate on load: reject malformed JSON, empty/duplicate aliases, missing required fields. Never log credential values.

**Exit criteria:** resolver returns records for a valid bundle; rejects malformed JSON and missing fields with a clear error; profile-scoped var wins over global; absent profile-scoped var falls back to global; empty/duplicate aliases rejected.

### Phase 2 — `psql` binary + OpenCode wrapper + client route

- Add `postgresql-client` to the `remote-cli-tools` stage in the root `Dockerfile` (line ~124; `sandbox/Dockerfile` already installs it for reference).
- Add `docker/opencode/bin/psql` — one-line wrapper forwarding to `remote-cli.mjs psql "$@"` (same shape as `docker/opencode/bin/aws`).
- Add the `psql` endpoint route in `packages/opencode-cli/src/remote-cli.ts` (`POST /exec/psql`).

**Exit criteria:** `psql` is on `PATH` in the remote-cli container; the OpenCode wrapper forwards argv to remote-cli; the client posts to `/exec/psql` with `{ args, cwd }`.

### Phase 3 — `/exec/psql` endpoint + arg policy in `packages/remote-cli`

- Add `POST /exec/psql` (model on `/exec/aws` in `index.ts`): validate `cwd`, validate `args` is a non-empty string array, resolve the profile from the session anchor.
- Parse the first non-flag positional as the **alias**. Resolve it against the profile bundle; unknown alias → error listing the valid aliases for the profile.
- Reject connection-control args fail-closed (`-h`/`--host`, `-U`/`--username`, `-p`/`--port`, `-d`/`--dbname`, `-W`, `service=…`, `postgres://`/`postgresql://` URIs). Pass query/format flags through.
- Execute `psql` with injected `PG*` env (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`) and `PGOPTIONS=-c default_transaction_read_only=on`, plus `-X -w` and `ON_ERROR_STOP=1`. Credentials go through env only, never argv.

**Exit criteria:** a valid alias resolves and runs; rejected flags fail-closed with a clear message and never reach `execCommand`; unknown alias lists valid aliases; credentials appear in neither argv nor the response; the read-only transaction option is set on every invocation; no approval path is invoked.

### Phase 4 — Env-var surfaces, docs, and tests

- Update every env surface in one change (AGENTS.md rule 6): `docker-compose.yml` (pass `PSQL_DATABASES*` to `remote-cli`), `.env.example` (commented `PSQL_DATABASES` block beside the AWS block), `README.md` Deployment Configuration table, and any E2E GitHub workflow env block that exercises this path.
- Document the agent-facing surface (alias as the dbname positional, read-only, discover databases with `psql -l`) without exposing server-side env vars or config keys, per rule 10. Add the read-only boundary to `docs/feat/security-model.md` and a profile note to `docs/feat/profile.md`.
- Tests: resolver (valid/malformed/missing-field/profile-fallback/duplicate-alias), arg rejection for connection-control flags, alias resolution + injected env, unknown-alias message, read-only invocation flags.

**Exit criteria:** `@thor/common` and `@thor/remote-cli` typecheck; targeted suites green; every env surface lists `PSQL_DATABASES[_<PROFILE>]`; agent-facing docs describe only what the agent can do.

## File-level impact

| Path                                      | Change                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/common/src/proxies.ts`          | Add `PSQL_DATABASES[_<PROFILE>]` resolver + bundle validation; never log creds                          |
| `packages/common/src/index.ts`            | Export the resolver / connection-record type                                                            |
| `Dockerfile`                              | Install `postgresql-client` in the `remote-cli-tools` stage                                             |
| `docker/opencode/bin/psql`                | New one-line wrapper forwarding to `remote-cli.mjs psql`                                                |
| `packages/opencode-cli/src/remote-cli.ts` | Route `psql` argv to `POST /exec/psql`                                                                  |
| `packages/remote-cli/src/policy.ts`       | Add psql arg parser: extract alias positional, reject connection-control flags                          |
| `packages/remote-cli/src/index.ts`        | Add `/exec/psql` — resolve profile + alias, inject `PG*` env, run read-only `psql`                      |
| `docker-compose.yml`                      | Pass `PSQL_DATABASES*` env to `remote-cli`                                                              |
| `.env.example`                            | Add commented `PSQL_DATABASES` example bundle                                                           |
| `README.md`                               | Add `PSQL_DATABASES[_<PROFILE>]` to Deployment Configuration                                            |
| `docs/feat/security-model.md`             | Document the alias/credential trust boundary and read-only enforcement                                  |
| `docs/feat/profile.md`                    | Note `PSQL_DATABASES` as a per-profile bundle integration                                               |
| tests                                     | `proxies` resolver cases, `policy` arg-rejection cases, `/exec/psql` alias resolution + read-only flags |

## Known limitations

- **Output size.** psql output is returned as-is; the OpenCode harness owns truncation/timeouts (AGENTS.md rule 9), so the wrapper adds none. Operators relying on bounded result sets should provision read-only roles with `statement_timeout`/row limits at the database, not in Thor.
- **Read-only depends on the DB role.** `default_transaction_read_only=on` plus `-w` is defense-in-depth; the authoritative boundary is the `thor_ro` (or equivalent) read-only role configured per database. A misconfigured read-write role would still be gated by the transaction option for ordinary DML but is not a substitute for a least-privilege role.

## Out of scope (V1)

- MySQL / non-Postgres engines (deferred to a future `MYSQL_DATABASES_*` + `mysql` wrapper behind the same pattern).
- Write SQL and any approval pipeline (everything is read-only by construction).
- AWS `rds-data` / IAM DB auth, RDS Proxy, and per-request SSM/SSH tunnels (the Slack thread recommended direct VPC reachability; tunnels add operator and runtime complexity).
- A named-query registry or admin-UI query surface.
- Cluster-level metadata discovery (use the existing `aws rds describe-*` passthrough for endpoints).
