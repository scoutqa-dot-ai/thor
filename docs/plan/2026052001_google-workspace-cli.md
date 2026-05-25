# Google Workspace CLI Integration

## Goal

Give Thor read-only access to Google Workspace through the `gws` CLI so agents can inspect Google Workspace data from an OpenCode session without receiving Google credentials or unrestricted write capability.

## Scope

- Add a `gws` wrapper in the OpenCode container that forwards to `remote-cli`.
- Add a server-side `/exec/gws` handler in `remote-cli`.
- Install/pin the upstream `@googleworkspace/cli` package in the remote-cli image.
- Enforce read-only policy in Thor before invoking `gws`.
- Document authentication, deployment configuration, and agent-facing usage.

Out of scope for v1:

- Mutating Google Workspace actions such as send/create/update/delete/share/upload.
- Agent-visible `gws auth login`, `gws auth setup`, or credential export/import flows.
- Per-request impersonation or domain-wide delegation for user mailbox/calendar access.

## Phases

### Phase 1 — Policy and auth shape

- Decide which Google principal Thor uses.
- Decide which services and read methods are allowed in v1.
- Mount the service-account credential file into `remote-cli` only.
- Set `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` to the mounted file.
- Set `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` to a remote-cli-owned cache directory so token cache is separate from the raw key.
- Treat Gmail/user-mailbox access as available only when the configured service identity can actually read it.

Exit: the boundary is precise enough to implement and test.

### Phase 2 — Remote CLI endpoint and wrapper

- Add `validateGwsArgs` for the chosen read-only command surface.
- Permit `--page-all` only with an absent or bounded `--page-limit`; enforce max 10 pages.
- Force API calls to JSON output unless the command is help/schema.
- Add `POST /exec/gws` in `packages/remote-cli/src/index.ts`; ignore request cwd and execute from `/workspace`.
- Add `docker/opencode/bin/gws` wrapper and route support through `remote-cli.mjs`.
- Install a pinned `@googleworkspace/cli` version in the remote-cli image.

Exit: `gws --help` and one allowed read command work through OpenCode; denied write commands fail before invoking `gws`.

### Phase 3 — Agent docs and deployment docs

- Add one bundled Thor-specific skill at `docker/opencode/config/skills/gws/SKILL.md` for supported command shapes.
- Update Docker Compose, `.env.example`, README Deployment Configuration, and examples for `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`, `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`, and optional `GOOGLE_WORKSPACE_PROJECT_ID` on `remote-cli` only.
- Document read-only constraints and denial behavior.

Exit: operators can configure credentials and agents know how to use the allowed read-only surface.

### Phase 4 — Verification and ship

- Add unit tests for policy allow/deny cases.
- Add targeted integration verification for the wrapper route with a fake or non-secret credential path where possible.
- Run the relevant local tests.
- Push branch, wait for required checks, then open PR.

Exit: tests and push checks are green; PR is open.

## Decision Log

| Decision                    | Choice                                                                              | Rationale                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1 safety boundary          | Read-only first                                                                     | Google Workspace contains sensitive personal and company data; mutating actions need a separate approval model and narrower use-case review.                                                                                    |
| Google identity             | Dedicated service identity                                                          | A service account / Workspace app identity is auditable, not tied to one employee, and keeps credentials server-side in `remote-cli`; operator OAuth credentials are only a fallback if admin setup blocks service-account use. |
| v1 services                 | Drive, Docs, Sheets, Calendar, and Gmail                                            | These cover common engineering/product collaboration lookups while avoiding broader Admin/Directory/Classroom/Chat/Forms surfaces until a concrete use case exists.                                                             |
| Policy shape                | Exact allowlist of read commands/methods                                            | `gws` is discovery-driven and can gain methods as Google changes APIs; exact allowlisting avoids accidentally permitting new mutating methods with unexpected names.                                                            |
| v1 command allowlist        | Help/schema plus selected read methods for Drive, Docs, Sheets, Calendar, and Gmail | The allowlist covers metadata lookup, document/spreadsheet reads, calendar availability/event reads, and Gmail profile/message/thread/label reads while excluding writes and broader Workspace surfaces.                        |
| File output/downloads       | Deny file writes and binary downloads in v1                                         | Keeping v1 stdout-only avoids path validation, cleanup, large binary output, and accidental PII-at-rest questions; controlled exports can be added later.                                                                       |
| Schema/help visibility      | Limit to v1 allowed services/methods                                                | Agent-facing discovery should describe only usable surfaces; exposing schemas for denied APIs encourages failed calls and policy probing.                                                                                       |
| Service identity visibility | Shared-with-Thor visibility only                                                    | A plain service account can reliably read resources available to that service identity; Gmail/user-mailbox reads may be unavailable without domain-wide delegation, which is deferred rather than replaced with human OAuth.    |
| Credential location         | Host-mounted service-account key file, remote-cli only                              | A read-only file secret matches `gws` credential loading, avoids putting Google credentials in the OpenCode container, and keeps operational credentials out of git.                                                            |
| Network path                | Direct outbound from remote-cli                                                     | The explicit command allowlist and `exec_gws` audit logs are the v1 control boundary; routing `gws` through mitmproxy can be revisited if HTTP-level enforcement is needed.                                                     |
| Pagination                  | Allow bounded pagination with max 10 pages                                          | Multi-page reads are useful, but server-side policy should cap `--page-all` so read-only calls cannot dump unbounded Workspace data.                                                                                            |
| Output format               | Force JSON for API calls                                                            | `gws` is agent-facing in Thor; structured JSON is safer and easier to consume reliably, while help/schema can keep their normal text output.                                                                                    |
| Env var surface             | Explicit remote-cli-only Google Workspace env vars                                  | Credential path, config/cache dir, and optional project id are deployment concerns and should be documented in compose/env/README without exposing credentials to OpenCode.                                                     |
| Config cache mount          | Named Docker volume for the writable `gws` config dir                               | The credential directory stays a read-only bind mount, while a named volume preserves cache state without host bind-mount ownership surprises for the non-root `remote-cli` user.                                               |
| Agent-facing docs           | One Thor-specific `gws` skill                                                       | Upstream skills are rich but include writes and broader APIs; a focused Thor skill should list only the supported read-only surface and server-side constraints.                                                                |
| Output size                 | No Thor-side output cap                                                             | OpenCode/harness truncation plus bounded pagination is the v1 boundary, matching Thor's existing policy to avoid duplicating harness output caps without a product-specific contract.                                           |
| Auth commands               | Deny all agent-facing `gws auth` commands                                           | Operators configure credentials outside the agent; exposing auth commands invites interactive or credential-sensitive workflows inside OpenCode.                                                                                |
| Dry-run                     | Deny `--dry-run` entirely                                                           | Help/schema provide safe introspection; v1 should expose actual read-only execution rather than write-request construction previews.                                                                                            |
| Sanitization flags          | Deny `--sanitize` in v1                                                             | Workspace reads should not introduce a second Google service/config path; Thor can revisit sanitization separately if needed.                                                                                                   |
| Cwd handling                | Ignore request cwd and run from `/workspace`                                        | Google Workspace is a global integration rather than repo-scoped, matching Metabase/Langfuse-style handlers.                                                                                                                    |
| Availability                | Always install wrapper; document configuration dependency                           | The image stays simple and consistent, while the Thor-specific skill explains that calls require operator-configured Google credentials.                                                                                        |
| ADR                         | Record the boundary in `docs/adr/0001-google-workspace-cli-boundary.md`             | Future readers should understand why Google Workspace access uses remote-cli, service identity, and an exact read-only allowlist instead of direct sandbox credentials or per-user OAuth.                                       |

## Open Questions

## V1 Command Allowlist

Discovery/help:

- `gws --help`
- `gws <allowed-service> --help`
- `gws schema <allowed-service>.<allowed-resource>.<allowed-method>`

Drive:

- `gws drive about get`
- `gws drive files get`
- `gws drive files list`
- `gws drive files export` only when it returns to stdout; `-o`/`--output` and binary downloads remain denied in v1
- `gws drive drives get`
- `gws drive drives list`
- `gws drive permissions get`
- `gws drive permissions list`
- `gws drive comments get`
- `gws drive comments list`
- `gws drive replies get`
- `gws drive replies list`
- `gws drive revisions get`
- `gws drive revisions list`

Docs:

- `gws docs documents get`

Sheets:

- `gws sheets spreadsheets get`
- `gws sheets spreadsheets getByDataFilter`
- `gws sheets spreadsheets values get`
- `gws sheets spreadsheets values batchGet`
- `gws sheets +read`

Calendar:

- `gws calendar calendarList get`
- `gws calendar calendarList list`
- `gws calendar calendars get`
- `gws calendar events get`
- `gws calendar events list`
- `gws calendar events instances`
- `gws calendar freebusy query`
- `gws calendar settings get`
- `gws calendar settings list`
- `gws calendar +agenda`

Gmail:

- `gws gmail users getProfile`
- `gws gmail users messages get`
- `gws gmail users messages list`
- `gws gmail users threads get`
- `gws gmail users threads list`
- `gws gmail users labels get`
- `gws gmail users labels list`
- `gws gmail +read`
- `gws gmail +triage`

## Exit Criteria

- Thor exposes `gws` to the agent through `remote-cli`, not by direct credential access.
- v1 permits only agreed read-only Google Workspace commands.
- Google credentials are not present in the OpenCode container.
- Denied write attempts fail with clear policy errors.
- Deployment documentation covers setup and credential handling.
