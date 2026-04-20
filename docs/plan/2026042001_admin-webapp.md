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
- Catch-all redirect to `/admin/config` so the public root of the admin surface is self-documenting
- Nginx `location /admin/` behind `auth_request /vouch/validate`, forwarding `X-Vouch-User`
- Docker-compose service with RW mount of `/workspace`
- Shared `validateWorkspaceConfig` helper in `@thor/common` so the admin UI and every service run the same validation logic

**Out of scope (for now):**

- Persistent audit log on disk (stdout-only logging via pino for phase 1)
- Versioned snapshots of `config.json` / rollback UI
- Config diff preview before save
- Structured "friendly" form over the JSON (schema is small and evolves — JSON textarea with CodeMirror JSON linting is enough)
- Multi-user optimistic locking / last-writer-wins detection
- SSE streaming of remote-cli commands (phase 3 concern)
- Memory dashboard (phase 2 concern)

## Target Shape

After this work:

- Operators open `http://<host>/admin/config`, edit the JSON with syntax highlighting and inline JSON-parse error markers, and save. Validation errors (schema, unknown proxy, duplicate channels) render above the editor as a list.
- The admin container is the sole writer to `config.json`. Other services pick changes up on next read via `createConfigLoader` — no restart.
- Every successful save logs `event: config_saved, user, savedAt` to stdout.
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

### Phase 2 — Memory / runtime dashboard (future)

**Changes (sketch — not committed):**

- New `GET /admin/memory` view — single page polled by htmx `hx-trigger="every 2s"`
- Fragment endpoint returns HTML with per-service memory, CPU, uptime pulled from `docker stats` or a `/stats` endpoint on each service (TBD which)
- Read-only, no writes

**Exit criteria (draft):**

- Dashboard updates live without full page reload
- Each service surfaces at least `rss_mb`, `heap_used_mb`, `uptime_s`
- No privileged Docker socket mounted unless we pick the `docker stats` path (decision deferred to phase start)

### Phase 3 — Run command in `remote-cli` (future)

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

| #   | Decision                                                   | Rationale                                                                                                                                                                                       | Rejected                                           |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Express + htmx over SPA / Next / Remix                     | Matches `gateway` stack exactly. No frontend build step. htmx's SSE + polling primitives cover phase 2/3 without a framework rewrite.                                                           | Next.js / SvelteKit / SPA with Vite                |
| 2   | Hono JSX SSR considered, not chosen                        | Hono is nice but diverges from gateway's Express baseline for no concrete win at this size.                                                                                                     | Hono                                               |
| 3   | Single JSON textarea (CodeMirror) over structured form     | Config schema has dynamic keys (`repos: Record<string, ...>`). Structured forms need add/remove row plumbing for every level; schema evolves, so structured forms break. Textarea never does.   | Structured field-per-key form                      |
| 4   | CodeMirror 6 from esm.sh CDN over Monaco or Prism          | Real editing + JSON linting with ~200KB gzipped, no frontend build. Monaco is 2MB overkill; Prism overlay has caret-alignment and tab-handling edge cases and no error markers.                 | Monaco, highlight.js/Prism overlay, plain textarea |
| 5   | htmx 2 from unpkg, no SRI pin yet                          | Simplicity during scaffold. Easy to pin later once the version is confirmed working in prod.                                                                                                    | Self-host htmx, pin with SRI up front              |
| 6   | Catch-all → 302 `/admin/config`                            | The admin surface currently has exactly one page. Avoids 404s for bookmarked or mistyped URLs and gives phase 2/3 a free nav-free landing.                                                      | Return 404 for unknown paths                       |
| 7   | Extract `validateWorkspaceConfig` in `@thor/common`        | First draft only ran `WorkspaceConfigSchema.safeParse` and silently accepted unknown proxies and duplicate channels — drift between admin-UI and service-startup validation. Unacceptable risk. | Duplicate the extra checks inline in admin         |
| 8   | Aggregate all issues before returning                      | Surface every problem in one response instead of bailing at the first. Faster iteration for the operator.                                                                                       | Throw on first (like pre-refactor loader)          |
| 9   | Atomic write via tmp + `rename`                            | `config.json` is read concurrently by gateway/runner/remote-cli. A partial write during `createConfigLoader` read could produce a lastGood fallback log storm. `rename(2)` is atomic on POSIX.  | `writeFileSync` in place                           |
| 10  | Audit logs to stdout only for phase 1                      | Containers run under Docker; stdout is captured by the existing log pipeline. Persistent audit log is worth adding later but not in phase 1.                                                    | Write NDJSON audit log to `/workspace`             |
| 11  | Behind nginx/vouch, no in-app auth                         | Consistent with the rest of the stack. `X-Vouch-User` is forwarded and shown in UI + audit log. Avoids a second auth surface.                                                                   | App-level session / bearer                         |
| 12  | Catch-all redirect scoped to the admin container           | If run alone on port 3005, the redirect turns any URL into `/admin/config`. Behind nginx, only `/admin/*` reaches the service, so there's no collision with opencode routes.                    | Narrow the catch-all to `/admin/*` only            |
| 13  | Port 3005                                                  | Next free port after remote-cli's 3004. No existing listener.                                                                                                                                   | Reuse an existing service's port                   |
| 14  | `CONFIG_PATH` env var, defaults to `WORKSPACE_CONFIG_PATH` | Lets a dev point the admin container at a throwaway file for UI testing without risking the shared volume.                                                                                      | Hardcode the path                                  |

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
| Any route            | Non-`/admin/config` path             | Y (302 redirect)                                     | Manual | Redirect                               | N       |

**Gaps flagged for follow-up:**

1. No automated tests for the admin HTTP surface — add vitest coverage for `app.ts` (parse error, schema error, atomic write, redirect) before phase 2. **P1**.
2. No persistent audit log — add `/workspace/config.audit.log` append-only NDJSON in a follow-up. **P2**.
3. No rate limiting on `POST /admin/config` — behind vouch it's low-risk, but repeated bad saves could noise logs. **P3**.
4. Docker `--rm` in test runs means container logs vanish when stopped — acceptable for dev, but a prod deployment should not use `--rm`. Document in README when adding one. **P3**.

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
