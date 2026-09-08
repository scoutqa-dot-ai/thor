# Google Workspace CLI Integration

## Goal

Give Thor read-only Google Drive, Docs, and Sheets access through `gws`, without putting Google credentials in OpenCode.

## Scope

- Pin upstream `@googleworkspace/cli@0.22.5` in remote-cli; install only an HTTP wrapper in OpenCode.
- Exact read-method and flag allowlists at `/exec/gws`, structured output, at most 10 pages per auto-pagination call.
- Dedicated service-account file mounted read-only into remote-cli, private config/token/discovery cache.
- Bundle one Thor-specific skill for finding files, reading documents (including tabs), and reading spreadsheet ranges.
- Operator setup documentation and deterministic tests without Google credentials.

## Out of scope

Writes, approvals for writes, uploads/downloads/exports, auth commands, user OAuth setup inside Thor, domain-wide delegation, Calendar/Gmail and other APIs. Live Google verification requires an operator-provided identity and shared fixtures; never create or inspect real credentials for tests.

## Phases

### Phase 1 — Read policy

Implement `parseGwsArgs` and behavior tests. Permit help for allowed command prefixes, schemas for exact read methods, inline JSON params, read-only Sheets request bodies, and `sheets +read`. Reconstruct canonical arguments, force JSON, and bound pagination to 1–10 pages.

Exit: policy tests prove allowed reads and reject mutations, alternate services, credential/file input, media output, and parser-bypass shapes.

### Phase 2 — Runtime, skill, and deployment

Add service execution, HTTP route, image install, wrapper, private mounts/config, deployment docs, and the agent skill. Run gws from its private config directory rather than request cwd. Reuse the existing ExecResult/client contract. Test the HTTP boundary with a real inert subprocess, including disabled/missing-credential cases.

Exit: local tests and typecheck pass; configured calls reach the subprocess, denied calls do not; credentials remain remote-cli-only; operators can follow setup instructions.

### Phase 3 — Integration verification and ship

Add credential-free container integration checks with the pinned real gws binary and local discovery/API fixtures. Verify OpenCode wrapper routing, help/schema, Drive/Docs/Sheets reads, output/exit propagation, denial-before-execution, and credential isolation. Run full local checks, push branch, wait for Unit Tests and Core E2E, open PR only after required checks pass.

Exit: isolated container checks and required push workflows pass; PR opened. Live Google access is explicitly a post-deploy operator check.

## Decision log

| Decision           | Choice                                                                 | Rationale                                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity           | Dedicated service account, resources shared as Viewer                  | Auditable shared identity; no employee token or impersonation. Upstream selects scopes from discovery, so the Thor allowlist and Google resource ACLs—not an assumed read-only OAuth scope—enforce read-only access. |
| Requested services | Drive, Docs, Sheets only                                               | Narrows the earlier draft's Calendar/Gmail scope to the user's request.                                                                                                                                              |
| Version            | 0.22.5                                                                 | Published npm version inspected against upstream tag v0.22.5.                                                                                                                                                        |
| Policy             | Exact methods and flags; canonical argv from parsed input              | Discovery is dynamic. Unknown methods/flags fail closed instead of relying on verbs or help flags.                                                                                                                   |
| Exports            | Deny all exports and `alt` except `json`                               | Upstream executor writes non-JSON responses to `download.<ext>` even without an output flag. Docs/Sheets APIs provide structured content reads. Corrects the draft's stdout-export assumption.                       |
| Working directory  | Private Google config directory, not `/workspace`                      | Upstream loads dotenv from cwd/ancestors. Repo-controlled `.env` and discovery/token caches must not affect authenticated requests. Config directory is never mounted in OpenCode or shared `/tmp`.                  |
| Configuration      | Optional credential file; private cache default; optional project ID   | Unconfigured integration fails clearly without preventing other Thor integrations from starting. Every deployment/env surface is updated together.                                                                   |
| Pagination         | Max 10 pages, JSON/NDJSON                                              | Explicit product boundary for bounded Workspace reads; no added output cap or timeout duplicating OpenCode.                                                                                                          |
| Logging            | Allowlisted operation, outcome, session/call IDs only                  | Queries, document content, credentials, and raw argv are not audit-log fields.                                                                                                                                       |
| Ownership          | Pure policy parser plus cohesive gws execution owner                   | Existing generic execCommand owns subprocess mechanics; gws owns config/credential availability. No provider adapter or changes to the already-generic HTTP wrapper client are needed.                               |
| Parser errors      | Typed tagged errors, translated to existing ExecResult                 | Keep malformed input out of execution while preserving Thor's endpoint contract.                                                                                                                                     |
| Skill              | One focused Thor skill rather than wholesale upstream skills           | Upstream skills include writes and interactive auth unsupported by Thor. Standard discovery details remain in upstream help/schema.                                                                                  |
| Tests              | Policy cases, real HTTP/subprocess, pinned CLI with local HTTP fixture | No module mocks or Google secrets. Finite allowlist and adversarial flag cases are more useful here than a new property-testing dependency.                                                                          |

## Verification record

- Phase 1: 57 policy tests pass; workspace typecheck passes. Reviewed upstream v0.22.5 argument parsing, auth, executor, Sheets helper, and discovery cache behavior.
- Phase 2: 75 focused policy/HTTP/subprocess/exec tests pass; workspace typecheck passes. Credential files are checked without reading their contents. The existing subprocess helper gained an explicit replacement environment mode so gws cannot inherit unrelated Thor secrets. Config defaults to `/var/lib/remote-cli/gws`; `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`, `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`, and optional `GOOGLE_WORKSPACE_PROJECT_ID` are documented in compose, env example, README, deployment docs, and Core E2E env.
