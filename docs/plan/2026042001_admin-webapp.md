# Admin Webapp

A small in-cluster admin UI, behind nginx/vouch, that lets operators view and edit `/workspace/config.json` (phase 1) and later grow into runtime introspection — memory checks, running commands in `remote-cli`, etc.

## Motivation

Editing `config.json` today means SSH + `vim` on the host or round-tripping through git. Validation errors are only surfaced when a service restarts and `loadWorkspaceConfig` throws. A dedicated UI gives:

- zero-restart edits with immediate schema validation
- an obvious audit trail (who changed config, when)
- a single place to expand into other admin-only diagnostics (memory, ad-hoc `remote-cli` commands, cron inspection) without bolting them onto an existing service

## Scope

**In scope:**

- New `@thor/admin` package (TypeScript, Express 5, same conventions as `gateway`)
- `/admin/config` route: view current `config.json`, edit in-browser, save with zod-backed validation and atomic write
- Append-only audit log at `/workspace/config.audit.log` capturing `{ ts, user, event, bytes, config }` for every successful save — doubles as a rollback source
- Catch-all redirect to `/admin/config` so the public root of the admin surface is self-documenting
- Nginx `location /admin/` behind `auth_request /vouch/validate`, forwarding `X-Vouch-User`
- Docker-compose service with RW mount of `/workspace`
- Shared `validateWorkspaceConfig` helper in `@thor/common` so the admin UI and every service run the same validation logic

**Out of scope (for now):**

- Versioned snapshots of `config.json` / rollback UI (but the audit log captures full content on every save, so rollback by `jq` is a one-liner away)
- Config diff preview before save
- Structured "friendly" form over the JSON (schema is small and evolves — JSON textarea with CodeMirror JSON linting is enough)
- Multi-user optimistic locking / last-writer-wins detection
- SSE streaming of remote-cli commands (phase 4 concern)
- Memory dashboard (phase 3 concern)
- Rotation of `config.audit.log` (file is tiny; revisit if it crosses ~10MB)

## Target Shape

After this work:

- Operators open `http://<host>/admin/config`, edit the JSON with syntax highlighting and inline JSON-parse error markers, and save. Validation errors (schema, unknown proxy, duplicate channels) render above the editor as a list.
- The admin container is the sole writer to `config.json`. Other services pick changes up on next read via `createConfigLoader` — no restart.
- Every successful save is recorded both to pino stdout (`event: config_saved`) and to a persistent NDJSON audit file at `/workspace/config.audit.log`. Each entry carries the full post-save config, so the file is self-contained — rollback to any historical state is `jq -s '.[-2].config' | tee config.json`.
- The same surface is ready to host additional admin features without a second package.

## Phases

### Phase 1 — Config view and edit (done)

**Changes:**

- Create `packages/admin/` — `package.json`, `tsconfig.json`, `src/{index,app,views}.ts`.
- Express app with:
  - `GET /health` — liveness probe
  - `GET /admin/config` — render HTML page with pre-filled CodeMirror 6 editor (ESM from esm.sh), htmx for the save round-trip, and a status fragment
  - `POST /admin/config` — `JSON.parse` → `validateWorkspaceConfig` → atomic write (tmp + rename) → audit log
  - Catch-all `app.use` → 302 to `/admin/config`
- Extract `validateWorkspaceConfig(parsed)` in `@thor/common` that aggregates:
  - legacy top-level `proxies` rejection
  - zod `WorkspaceConfigSchema` parse
  - duplicate channel detection across repos
  - unknown proxy references
    Returns `{ ok: true, data }` or `{ ok: false, issues }`. `loadWorkspaceConfig` is refactored to use it so service-startup validation and UI validation cannot drift.
- Wire into infra:
  - `Dockerfile`: new `admin` target + package.json copy in deps stage
  - `docker-compose.yml`: `admin` service on port 3005, RW mount of `/workspace`, healthcheck hitting `/health`; `ingress` gains `depends_on: admin`
  - `docker/ingress/nginx.conf`: new `location /admin/` block with `auth_request /vouch/validate`, forwards `X-Vouch-User`

**Exit criteria:**

- `pnpm -r typecheck` and `pnpm test` both pass (329 tests)
- `docker build --target admin` succeeds
- `GET /admin/config` renders with mtime and signed-in user visible
- `POST /admin/config` with valid JSON writes atomically, returns an htmx status fragment, and logs `config_saved`
- `POST /admin/config` with bad JSON, schema violation, unknown proxy, duplicate channel, or rogue top-level key all return 400 with an aggregated issue list and leave the file untouched
- Any non-`/admin/config` path under the admin service 302s to `/admin/config`

### Phase 2 — Persistent audit log

Phase 1 only logs save events to pino stdout. Docker `--rm` or log rotation can lose that trail, so we add a durable NDJSON file next to `config.json`.

**Changes:**

- `AUDIT_LOG_PATH` env var on the admin service, defaults to `/workspace/config.audit.log`.
- In the `POST /admin/config` success path, after the atomic rename, append one NDJSON line: `{ ts, user, event: "config_saved", bytes, config }`. `config` holds the full post-save object — the file is tiny, and including it turns the audit log into a self-contained history / rollback source.
- Append is non-fatal: if writing to the audit log fails, log `audit_append_failed` via pino but still return success to the operator (the primary config write already happened and can't be undone).
- Use `fs.appendFileSync` with `{ mode: 0o644 }`. The admin container runs as `thor` (uid 1001), same as the other services that mount `/workspace`, so permissions are consistent.
- Surface the audit log path in admin startup logs so operators see where it lives.

**Exit criteria:**

- A successful `POST /admin/config` appends exactly one NDJSON line to `AUDIT_LOG_PATH`.
- Each line parses as JSON and contains `ts` (ISO 8601), `user` (string or null), `event: "config_saved"`, `bytes` (number), `config` (the post-save object).
- Failed saves (parse error, schema error) do **not** append anything.
- Deleting or chmod-ing the audit file so append fails does not break the primary config write — the operator sees "Saved" and pino logs `audit_append_failed`.
- Rolling back via `jq -s '.[-2].config' < config.audit.log > /workspace/config.json` round-trips successfully through the editor.

### Phase 3 — Memory / runtime dashboard (future)

**Changes (sketch — not committed):**

- New `GET /admin/memory` view — single page polled by htmx `hx-trigger="every 2s"`
- Fragment endpoint returns HTML with per-service memory, CPU, uptime pulled from `docker stats` or a `/stats` endpoint on each service (TBD which)
- Read-only, no writes

**Exit criteria (draft):**

- Dashboard updates live without full page reload
- Each service surfaces at least `rss_mb`, `heap_used_mb`, `uptime_s`
- No privileged Docker socket mounted unless we pick the `docker stats` path (decision deferred to phase start)

### Phase 4 — Run command in `remote-cli` (future)

**Changes (sketch — not committed):**

- New `/admin/exec` form with a small allowlist of command templates (no free-form shell)
- POST forwards to `remote-cli` over its existing HTTP surface
- Response streamed to the browser as SSE via htmx `hx-ext="sse"`; output appended to a `<pre>` as lines arrive
- Every invocation logs to the same pino stream with `event: admin_exec, user, command`

**Exit criteria (draft):**

- Only whitelisted commands can be triggered (no `/bin/sh -c` pass-through)
- Long-running commands stream incrementally; the page stays responsive
- Timeouts close the SSE channel cleanly

## Decision Log

| #   | Decision                                                   | Rationale                                                                                                                                                                                        | Rejected                                           |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 1   | Express + htmx over SPA / Next / Remix                     | Matches `gateway` stack exactly. No frontend build step. htmx's SSE + polling primitives cover phase 2/3 without a framework rewrite.                                                            | Next.js / SvelteKit / SPA with Vite                |
| 2   | Hono JSX SSR considered, not chosen                        | Hono is nice but diverges from gateway's Express baseline for no concrete win at this size.                                                                                                      | Hono                                               |
| 3   | Single JSON textarea (CodeMirror) over structured form     | Config schema has dynamic keys (`repos: Record<string, ...>`). Structured forms need add/remove row plumbing for every level; schema evolves, so structured forms break. Textarea never does.    | Structured field-per-key form                      |
| 4   | CodeMirror 6 from esm.sh CDN over Monaco or Prism          | Real editing + JSON linting with ~200KB gzipped, no frontend build. Monaco is 2MB overkill; Prism overlay has caret-alignment and tab-handling edge cases and no error markers.                  | Monaco, highlight.js/Prism overlay, plain textarea |
| 5   | htmx 2 from unpkg, no SRI pin yet                          | Simplicity during scaffold. Easy to pin later once the version is confirmed working in prod.                                                                                                     | Self-host htmx, pin with SRI up front              |
| 6   | Catch-all → 302 `/admin/config`                            | The admin surface currently has exactly one page. Avoids 404s for bookmarked or mistyped URLs and gives phase 2/3 a free nav-free landing.                                                       | Return 404 for unknown paths                       |
| 7   | Extract `validateWorkspaceConfig` in `@thor/common`        | First draft only ran `WorkspaceConfigSchema.safeParse` and silently accepted unknown proxies and duplicate channels — drift between admin-UI and service-startup validation. Unacceptable risk.  | Duplicate the extra checks inline in admin         |
| 8   | Aggregate all issues before returning                      | Surface every problem in one response instead of bailing at the first. Faster iteration for the operator.                                                                                        | Throw on first (like pre-refactor loader)          |
| 9   | Atomic write via tmp + `rename`                            | `config.json` is read concurrently by gateway/runner/remote-cli. A partial write during `createConfigLoader` read could produce a lastGood fallback log storm. `rename(2)` is atomic on POSIX.   | `writeFileSync` in place                           |
| 10  | Audit to stdout **and** to persistent NDJSON file          | Stdout alone disappears with `docker --rm` or log rotation. Writing both gives a short-term (log pipeline) and long-term (on-disk) record without building a log shipper. Phase 2 adds the file. | stdout-only, only on-disk, external log shipper    |
| 11  | Behind nginx/vouch, no in-app auth                         | Consistent with the rest of the stack. `X-Vouch-User` is forwarded and shown in UI + audit log. Avoids a second auth surface.                                                                    | App-level session / bearer                         |
| 12  | Catch-all redirect scoped to the admin container           | If run alone on port 3005, the redirect turns any URL into `/admin/config`. Behind nginx, only `/admin/*` reaches the service, so there's no collision with opencode routes.                     | Narrow the catch-all to `/admin/*` only            |
| 13  | Port 3005                                                  | Next free port after remote-cli's 3004. No existing listener.                                                                                                                                    | Reuse an existing service's port                   |
| 14  | `CONFIG_PATH` env var, defaults to `WORKSPACE_CONFIG_PATH` | Lets a dev point the admin container at a throwaway file for UI testing without risking the shared volume.                                                                                       | Hardcode the path                                  |
| 15  | Full post-save config embedded in each audit entry         | File is ~1KB per entry and config contains no secrets (credentials live in env vars). Self-contained history beats a side-car snapshot store. Diff two entries with `jq`.                        | Hash-only, or store a pointer to an external blob  |
| 16  | Audit append is non-fatal                                  | The atomic rename already happened — failing the HTTP response after that would mislead the operator. Log the audit failure loudly via pino instead.                                             | Fail the save if audit append fails                |
| 17  | `AUDIT_LOG_PATH` env var, defaults to workspace location   | Mirrors the `CONFIG_PATH` override so tests can point at a throwaway file. Same dir as the config → same mount, no extra volume plumbing.                                                        | Hardcode `/workspace/config.audit.log`             |

## Failure Modes Registry

| Codepath             | Failure Mode                         | Rescued?                                             | Test?  | User Sees?                             | Logged? |
| -------------------- | ------------------------------------ | ---------------------------------------------------- | ------ | -------------------------------------- | ------- |
| `GET /admin/config`  | Config file missing                  | Y (renders empty editor + banner)                    | N      | "Failed to read config: ENOENT…"       | N       |
| `GET /admin/config`  | Config file unreadable (permissions) | Y (same banner path)                                 | N      | Error banner                           | N       |
| `POST /admin/config` | Body not a string                    | Y (falls through to empty-string parse)              | N      | `JSON parse error: Unexpected end…`    | N       |
| `POST /admin/config` | Malformed JSON                       | Y (400 + parse-error fragment)                       | Manual | Red status fragment                    | N       |
| `POST /admin/config` | Zod schema violation                 | Y (400 + issues list)                                | Manual | Status fragment with per-path messages | N       |
| `POST /admin/config` | Unknown proxy / dup channel          | Y (400 + issues list)                                | Manual | Same as above                          | N       |
| `POST /admin/config` | Disk full / write failure            | Y (400 + error fragment, logs `config_write_failed`) | N      | Red banner                             | Y       |
| `POST /admin/config` | Rename crosses device                | N (rename throws → write-fail path)                  | N      | Red banner                             | Y       |
| `POST /admin/config` | Audit append fails                   | Y (config already saved; logs `audit_append_failed`) | Manual | Saved (primary write succeeded)        | Y       |
| Any route            | Non-`/admin/config` path             | Y (302 redirect)                                     | Manual | Redirect                               | N       |

**Gaps flagged for follow-up:**

1. No automated tests for the admin HTTP surface — add vitest coverage for `app.ts` (parse error, schema error, atomic write, redirect, audit append) before phase 3. **P1**.
2. No rate limiting on `POST /admin/config` — behind vouch it's low-risk, but repeated bad saves could noise logs. **P3**.
3. Docker `--rm` in test runs means container logs vanish when stopped — acceptable for dev, but a prod deployment should not use `--rm`. Document in README when adding one. **P3**.
4. No rotation for `config.audit.log` — low priority since entries are ~1KB and edits are rare; revisit if the file crosses ~10MB. **P3**.

## Verification

Manual verification performed against an isolated scratch workspace (`.context/admin-test/`) with the following matrix:

| Test                                    | Expected               | Result |
| --------------------------------------- | ---------------------- | ------ |
| `GET /health`                           | 200 `{"ok":true}`      | pass   |
| `GET /admin/config` with `X-Vouch-User` | 200, editor + metadata | pass   |
| `GET /foo`                              | 302 `/admin/config`    | pass   |
| `POST` valid config                     | 200 + "Saved" fragment | pass   |
| `POST` malformed JSON                   | 400 + parse-error      | pass   |
| `POST` unknown proxy                    | 400 + issues list      | pass   |
| `POST` duplicate channel across repos   | 400 + issues list      | pass   |
| `POST` rogue top-level key (strict)     | 400 + "(root)"         | pass   |
| `POST` multiple issues simultaneously   | 400, all issues shown  | pass   |
| File state after failed POSTs           | Unchanged from last OK | pass   |
| `event: config_saved` only on success   | Only one entry seen    | pass   |

Full test suite (`pnpm test`): 329 passed after the `validateWorkspaceConfig` refactor.

### Phase 2 verification

Additional manual runs against the same scratch workspace:

| Test                                                     | Expected                                                                            | Result |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------ |
| Startup log shows `auditLogPath`                         | `/workspace/config.audit.log` in startup event                                      | pass   |
| Three successful saves append three NDJSON lines         | `wc -l config.audit.log` = 3                                                        | pass   |
| Each line has `ts, user, event, bytes, config`           | All parse with `jq`; `user` is string or null                                       | pass   |
| Invalid save (unknown proxy) leaves line count unchanged | Still 3 after 400 response                                                          | pass   |
| Missing `X-Vouch-User` header stores `user: null`        | Line shows `"user":null`                                                            | pass   |
| Rollback: `jq -s '.[-2].config' \| POST`                 | File returns to prior state; editor accepts it; new audit entry appended            | pass   |
| Audit file chmod 0444 → append fails                     | HTTP save still returns 200; pino logs `audit_append_failed`; `config.json` updated | pass   |
