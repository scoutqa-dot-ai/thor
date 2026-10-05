# Google Drive file and folder downloads

**Status:** Phase 1 implemented and locally verified; Phase 2 pending. No live deployment changes performed.

## Objective

Allow Neo to download ordinary Drive files and recursive folder trees into the agent's own filesystem, preserving requester-owned Google OAuth and the broker filesystem boundary. Metadata listing alone is insufficient for README/code/document work.

## Phases and exit criteria

### Phase 1 — Authorized broker download and bounded transport

Add the exact command `gws drive +download --file-id FILE_ID`. Resolve files through trusted Drive API calls after the existing requester/grant/continuation checks. Return a versioned binary manifest as a dedicated exec response field, never as stdout. Recursively list folders, including pagination/shared drives and empty directories; preserve binary bytes; export native Workspace documents. Keep arbitrary paths, uploads, credential commands and generic local-output flags denied.

Exit: behavioral tests prove bytes, recursion/pagination, exports, denied redirects/permissions, unsafe names/collisions, resource ceilings and all-or-nothing provider failure. Auth waits retain exact safe argv and cannot download without the active requester's token.

### Phase 2 — Agent-local materialization and end-to-end acceptance

Consume the dedicated response in the shared Pi/OpenCode wrapper. Validate the complete manifest before creating a unique private temporary download directory; write exclusively inside it, remove it on failure, and print only a useful local path/summary. Update agent skill, operator guide, README and fixture acceptance.

Exit: tests prove actual readable local files/folder trees, binary fidelity, no base64 in model-visible output, traversal/collision/tampering rejection and cleanup. Existing Google authorization/direct commands remain compatible. Run focused tests and workspace test/typecheck/build, then integration verification where available. Live Google/Slack and deployed image acceptance remain distinct from dummy local checks.

## Decision log

| Decision                                                                                                         | Reason                                                                                                                                                       | Alternative rejected                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| One exact `drive +download --file-id` command, automatically recursive for folders                               | No broker/agent path enters auth continuations; agent can use normal local tools on the reported result                                                      | Unblocking arbitrary `--output`, file flags or upstream download helpers                 |
| Trusted direct Drive REST acquisition using only `GwsAccessToken`                                                | Upstream gws saves media in its private cwd and cannot return binary content; fixed endpoints and no redirects keep token ownership controlled               | Sharing broker filesystem or giving Google tokens to the agent                           |
| Dedicated versioned exec field with base64 binary entries                                                        | Buffered existing exec protocol needs no separate durable capability/server or shared volume; wrapper never prints transfer bytes                            | Raw binary stdout, URL-only results or placing manifests in ordinary stdout              |
| 50 MiB decoded total, 1,000 entries including directories, depth 32                                              | Explicit transfer product/resource boundary; fail completely with actionable narrowing advice rather than silently truncate trees                            | Unbounded recursive memory/HTTP transfer                                                 |
| 60-second deadline per provider request; bounded wire response                                                   | Broker transfer HTTP must stop stalled streams even after a shell wrapper disconnects; this is the download contract, not a duplicate harness output timeout | Leaving broker token-bearing requests/resources open indefinitely                        |
| Fresh generated local directory; no caller-selected output path                                                  | Prevent traversal, symlink/overwrite and cross-container path ambiguity; local `mv`/`cp` remains available                                                   | Writing into arbitrary existing paths                                                    |
| Docs→text, Sheets→xlsx, Slides→pptx, Drawings→pdf; shortcuts are reported/skipped, unsupported native types fail | Makes Workspace content usable without guessing exports or traversing shortcut cycles/outside trees                                                          | Downloading native metadata as if it were content or silently omitting unsupported files |
| New cohesive broker downloader, shared wire contract, local materializer                                         | Deleting these would spread Drive recursion/resource policy or filesystem safety into generic exec/route orchestration; no new dependency                    | A universal transfer framework or filesystem I/O inside the HTTP route                   |

## Out of scope

Uploads, Drive mutations, shared/global credentials, arbitrary authenticated URL fetches, caller-selected broker paths, shortcut following, whole-drive synchronization, resumable/chunked large transfers, runtime-default changes, and reading/altering production secrets or deployment data.

## Verification record

Phase 1: delegated implementation ran focused common/remote-cli Google suites: **126 tests passed**. Common and remote-cli typechecks, changed-file formatting and `git diff --check` passed. Tests include the real OAuth/HTTP route, confirmed private wait/exact argv, denial without an active requester, byte ceilings/chunked media, folder pagination/empty directories, exports, collisions, redirects and provider failures. Production Google acceptance remains unrun. No dependency installation or live secrets used. Sandbox preflight: SBX available, approved base `node:24-bookworm`, no prepared repository/dependency image; isolated host tests use already installed dependencies and dummy fixtures.

Parent Phase 1 recheck: `pnpm exec vitest run packages/common/src/google-drive-download.test.ts packages/remote-cli/src/google-drive-download.test.ts packages/remote-cli/src/gws-args.test.ts packages/remote-cli/src/gws.test.ts packages/remote-cli/src/gws-continuation.test.ts` — **93 tests passed / 5 files**, log `/tmp/neo-drive-phase1-tests.log`. `git diff --check` passed. Node 24.11.1 selected explicitly.
