# Slack post message controlled path

**Date**: 2026-05-05
**Status**: Planned
**Branch**: `feat/slack-post-message`
**Scope**: Replace agent-facing raw Slack `chat.postMessage` writes with a dedicated `slack-post-message` CLI and remote-cli execution path that preserves Slack thread alias registration.

## Problem

`docs/plan/2026042301_refactor-slack-mcp.md` removed `packages/slack-mcp` and intentionally moved simple agent replies to direct `curl` calls against `https://slack.com/api/chat.postMessage`. That was acceptable for the removal because direct-curl alias repair was documented as an out-of-scope follow-up.

The follow-up is now required. Direct `curl`/`fetch` Slack writes bypass Thor's alias-producing control plane, so outbound Slack threads created from non-Slack sessions no longer bind `slack:thread:{ts}` back to the originating OpenCode session. The investigation in `/workspace/runs/20260505-restore-slack-alias-logic/findings_1.md` confirmed the gateway and common alias resolver still work once an alias exists, but no current producer observes successful `chat.postMessage` responses and calls the alias writer after `slack-mcp` removal.

This plan creates a new durable feature plan rather than amending the removal plan because the work intentionally changes the post-removal architecture: direct `chat.postMessage` writes become disallowed, and a new supported CLI + remote-cli path becomes the controlled agent-facing Slack write surface.

## Goals

- Add a dedicated `slack-post-message` CLI, similar in spirit to `slack-upload`, for agent-authored Slack messages.
- Add a narrow remote-cli endpoint such as `POST /exec/slack-post-message` so posting and alias registration happen inside Thor's policy surface.
- Register Slack thread aliases for successful posts:
  - new top-level messages use the returned Slack `ts`
  - replies use the requested `thread_ts`
- Disable mitmproxy auth injection for raw `chat.postMessage` so `curl`, `fetch`, and hand-written scripts cannot bypass alias tracking.
- Update OpenCode instructions and Slack skill docs to make `slack-post-message` the only supported message-posting path.

## Non-goals

- Do not reintroduce `packages/slack-mcp`, a Slack MCP upstream, or a general-purpose Slack CLI.
- Do not add a generic `--json` passthrough for arbitrary Slack API payloads.
- Do not support `chat.update`, `chat.delete`, broad reaction mutation, or arbitrary Slack write endpoints through this CLI.
- Do not mutate Slack API responses or inject `[thor:meta]` into agent-visible output.
- Do not redesign alias storage in this branch. Current storage represents Slack aliases as `slack:thread:{ts}` and does not preserve channel ID.
- Do not solve file-upload aliasing here. `slack-upload` remains the upload helper; aliasing for upload-created comments can be a later feature if needed.
- Do not add app-level rate limiters; keep rate limiting at infra/proxy/WAF per `AGENTS.md`.

## Current state and implications

- `docker/mitmproxy/rules.py` currently injects `SLACK_BOT_TOKEN` for `/api/chat.postMessage`, which allows direct `curl`/`fetch` writes.
- `docker/opencode/bin/slack-upload` is a shell helper already installed in the OpenCode image and can serve as the packaging/UX model.
- `packages/opencode-cli/src/remote-cli.ts` forwards wrapper commands to `/exec/<endpoint>` and preserves stdout/stderr/exit code for buffered JSON responses.
- `packages/remote-cli/src/index.ts` owns narrow `/exec/*` endpoints and can access `x-thor-session-id` from wrapper calls.
- `packages/common/src/correlation.ts` exposes `appendCorrelationAlias(sessionId, correlationKey)` and already validates aliasable correlation key types.
- Current alias storage only keeps `slack:thread:{ts}`. It does not remember channel ID, so future continuations route by thread timestamp only. That preserves the current resolver contract but means CLI ergonomics cannot infer a channel from an alias; callers must still pass `--channel <id>` for every post.

## CLI contract

Primary shape:

```bash
slack-post-message --channel <id> [--thread-ts <ts>] [--format mrkdwn|blocks]
```

Input is stdin-only:

- `mrkdwn` is the default and primary format. Stdin is the exact Slack `text` body.
- `blocks` may be supported as an explicit format, but only with strict validation before posting.
- Positional message text, `--text`, temp-file expansion flags, and generic `--json` passthrough are intentionally not supported.

Output contract:

- On Slack success, stdout should contain Slack's raw JSON response followed by a newline.
- On Slack/API/validation failure, stderr should explain the problem and the command should exit non-zero.
- Alias registration is a side effect after Slack success. It must not alter stdout.

Validation expectations:

- Require `--channel` for all posts.
- Validate `--thread-ts` shape enough to catch obvious non-timestamps.
- For `mrkdwn`, require non-empty stdin after preserving intended whitespace; enforce a documented max input size that is comfortably below Slack limits and remote-cli buffer limits.
- For `blocks`, parse stdin as JSON, require a top-level array, validate reasonable block count/size limits, reject unknown broad passthrough fields, and include fallback `text` only if the CLI contract defines where it comes from. If fallback text cannot be done cleanly, defer `blocks` to a later phase and ship `mrkdwn` first.

## Enforcement model

1. OpenCode agents call `slack-post-message`; the wrapper sends argv, cwd/directory context, session ID, call ID, and stdin body to remote-cli.
2. remote-cli validates the request and calls Slack `chat.postMessage` using `SLACK_BOT_TOKEN` from the service environment, not through mitmproxy auth injection.
3. remote-cli parses Slack JSON and only treats `ok: true` as success.
4. remote-cli appends the alias via `appendCorrelationAlias(sessionId, correlationKey)` when a Thor session ID is present, where `correlationKey` is `slack:thread:${aliasTs}`:
   - `aliasTs = thread_ts` for replies
   - `aliasTs = response.ts` for new top-level messages
5. remote-cli returns the raw Slack JSON in stdout and preserves non-zero failures in the existing `ExecResult` shape.
6. mitmproxy no longer injects auth for `/api/chat.postMessage`; direct `curl`/`fetch` calls to that endpoint should fail without an explicit token, and docs must tell agents not to pass Slack tokens manually.

Security and policy boundaries:

- `/exec/slack-post-message` is a purpose-built write endpoint, not `/internal/exec` and not a generic Slack proxy.
- The endpoint must not accept arbitrary URL, method, headers, token, or JSON fields.
- The endpoint should log structured metadata such as channel, thread presence, format, Slack ok/error, alias result, session ID/call ID, and duration, but never log full message text or bot tokens.
- If alias registration fails after Slack success, posting should remain successful but log the alias failure clearly. This avoids duplicate Slack posts caused by retrying solely for bookkeeping.

## Files likely affected

- `docker/opencode/bin/slack-post-message` — new CLI wrapper installed in the OpenCode container.
- `docker/opencode/bin/slack-upload` — reference only; no behavior change expected unless shared helper conventions are extracted.
- `packages/opencode-cli/src/remote-cli.ts` — likely needs stdin forwarding support for this endpoint while preserving existing command behavior.
- `packages/remote-cli/src/index.ts` — add `POST /exec/slack-post-message` route.
- `packages/remote-cli/src/slack-post-message.ts` or similar — request validation, Slack API call, response handling, alias registration helper.
- `packages/remote-cli/src/*.test.ts` — endpoint, validation, alias, logging, and failure coverage.
- `packages/common/src/correlation.ts` / tests — likely no production change; may add targeted tests if alias behavior needs clearer coverage.
- `docker/mitmproxy/rules.py` — remove `/api/chat.postMessage` injection rule while keeping read endpoints, `reactions.add`, upload endpoints, and files URLs.
- `docker/mitmproxy/test_rules.py` / `test_addon.py` — enforcement tests for blocked raw `chat.postMessage` and still-allowed Slack reads/uploads/reactions.
- `docker/opencode/config/agents/build.md` — replace direct `curl` posting examples and tool list with `slack-post-message`.
- `docker/opencode/config/skills/slack/SKILL.md` — update transport, allowed endpoints, post examples, gotchas, and response handling.
- `docker/opencode/Dockerfile` or related image setup — ensure the new wrapper is executable and present in PATH, if scripts are copied explicitly.
- `README.md`, `.env.example`, `docker-compose.yml`, GitHub workflow env blocks — only if the implementation introduces or moves environment variables. The preferred design reuses `SLACK_BOT_TOKEN` already required by gateway/mitmproxy surfaces and must still audit these files per `AGENTS.md` if env usage changes.

## Phases

### Phase 1 — Contract and remote-cli post path

**Goal**: add the controlled execution surface and prove alias registration behavior without changing agent instructions yet.

Changes:

- Add a `slack-post-message` request/argument parser for `--channel`, optional `--thread-ts`, and optional `--format`.
- Add stdin/body support to the OpenCode remote-cli wrapper path in the narrowest compatible way.
- Add `POST /exec/slack-post-message` in remote-cli.
- Implement `mrkdwn` posting to Slack `chat.postMessage` with service-held `SLACK_BOT_TOKEN`.
- Parse Slack responses and register aliases through `appendCorrelationAlias` on `ok: true`.
- Decide in code whether `blocks` is implemented now or rejected with a clear "not yet supported" validation error; do not silently accept passthrough JSON.

Exit criteria:

- Unit tests show stdin-only `mrkdwn` posts build the intended Slack request body.
- New-thread success registers `slack:thread:{response.ts}` for the calling session.
- Reply success registers `slack:thread:{thread_ts}` for the calling session.
- Slack `ok: false`, invalid stdin/args, missing token, missing session ID, and alias-writer failure are covered with behavior-focused tests.
- Existing `/exec/git`, `/exec/gh`, `/exec/mcp`, and other remote-cli wrapper behavior remains compatible.

### Phase 2 — OpenCode CLI packaging and instructions

**Goal**: make `slack-post-message` the documented agent-facing Slack write command.

Changes:

- Add executable `docker/opencode/bin/slack-post-message` wrapper with usage text matching the contract.
- Update OpenCode image/build wiring so the command is available in PATH alongside `slack-upload`.
- Update `build.md` tool list and Slack acknowledgement/posting examples to use `slack-post-message` with stdin heredocs or pipes.
- Update Slack skill examples for short and multiline posts, preserving guidance to use unique `/tmp` files only for temporary artifacts unrelated to message stdin.
- Document that callers must always pass channel ID because aliases store thread timestamps, not channel IDs.

Exit criteria:

- CLI help output documents only supported flags and stdin-only input.
- Instruction examples no longer use raw `curl` for `chat.postMessage`.
- `slack-upload` docs remain intact for file uploads.
- Tests or static checks cover that the wrapper calls `/exec/slack-post-message` and forwards stdin.

### Phase 3 — Mitmproxy enforcement

**Goal**: close the bypass path by removing auth injection for raw Slack message posts while preserving supported Slack reads, reactions, and uploads.

Changes:

- Remove the builtin mitmproxy injection rule for `slack.com/api/chat.postMessage`.
- Keep existing rules for `conversations.replies`, `conversations.history`, `files.info`, `files.getUploadURLExternal`, `files.completeUploadExternal`, `files.slack.com` upload/download paths, and the narrow `reactions.add` allowance.
- Update proxy tests to assert `chat.postMessage` is denied or receives no injected auth, depending on the current rule classifier semantics.
- Audit docs for any remaining instruction that suggests direct raw `curl`/`fetch` posting.

Exit criteria:

- Raw `curl https://slack.com/api/chat.postMessage` through mitmproxy no longer receives injected bot auth.
- Slack read endpoints, `reactions.add`, and `slack-upload` flows still have auth injection.
- No agent-facing instructions recommend passing `Authorization` manually.

### Phase 4 — Integration verification and cleanup

**Goal**: verify the cross-layer behavior that motivated the feature.

Changes:

- Add or update an integration-style test showing a non-Slack session can post a Slack thread through `slack-post-message`, register the Slack thread alias, and allow gateway continuation routing to resolve to the originating session.
- Add regression coverage for reply aliasing into an existing Slack thread from a non-Slack session.
- Remove stale references to direct `chat.postMessage` as a supported agent write path.
- Update this plan's Decision Log if implementation choices differ, especially around `blocks` support and alias-failure behavior.

Exit criteria:

- The targeted package tests pass locally.
- Full workspace typecheck/test command selected by the implementer passes locally or has documented, unrelated failures.
- Branch is pushed after phases are complete so GitHub workflows run as the final verification gate before PR creation.

## Verification expectations

Use behavior-focused tests per `AGENTS.md`; avoid tests that only pin trivial string construction.

Minimum local checks expected before review:

- `pnpm --filter @thor/remote-cli test` or targeted remote-cli vitest files covering the new endpoint.
- `python -m pytest docker/mitmproxy` or the repo's existing mitmproxy test command covering rule changes.
- Targeted docs/wrapper checks proving `slack-post-message` is installed and help text is accurate.
- A higher-level gateway/common correlation test or integration-style test showing alias resolution for Slack continuations after a controlled post.

Final verification follows `AGENTS.md`: one commit per phase, push after all phases are complete, use the relevant GitHub workflow result as the final gate, and open the PR only after required push checks are green.

## Decision Log

| #   | Decision                                                                                          | Rationale                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Create a new plan for `slack-post-message` instead of amending `2026042301_refactor-slack-mcp.md` | The slack-mcp removal plan explicitly left direct-curl alias repair out of scope. This branch changes the post-removal architecture and needs its own durable review-first plan.                                                                     |
| D2  | Introduce a purpose-built `slack-post-message` CLI and `/exec/slack-post-message` path            | Posting must happen inside Thor's control plane so the Slack response and session ID are available for alias registration. A narrow endpoint avoids recreating Slack MCP or exposing arbitrary Slack writes.                                         |
| D3  | Make input stdin-only and default to `mrkdwn`                                                     | Stdin avoids fragile shell quoting and aligns with multiline agent replies. `mrkdwn` covers the primary user-visible need with a small, auditable contract.                                                                                          |
| D4  | Do not expose generic `--json` passthrough                                                        | Arbitrary JSON would become a broad Slack write proxy and make policy/validation ambiguous. Structured formats must be explicitly designed and validated.                                                                                            |
| D5  | Disable raw mitmproxy auth injection for `chat.postMessage`                                       | Leaving direct `curl`/`fetch` authenticated would preserve the bypass that caused the alias regression. Enforcement requires the unsupported path to fail closed.                                                                                    |
| D6  | Register aliases in remote-cli after Slack `ok: true` without mutating stdout                     | remote-cli has the session/call IDs and existing alias writer. Keeping raw Slack JSON on stdout preserves agent/API expectations and avoids response rewriting.                                                                                      |
| D7  | Treat alias registration failure as logged side-effect failure after a successful Slack post      | Retrying a successful post solely because bookkeeping failed can duplicate user-visible Slack messages. Operators need logs, but users should not get duplicate replies.                                                                             |
| D8  | Keep channel ID out of alias storage in this branch                                               | Existing resolver keys are `slack:thread:{ts}`. Redesigning alias metadata would widen the feature; the CLI can require `--channel` explicitly for now.                                                                                              |
| D9  | Allow `blocks` only if strict validation is implemented; otherwise reject it clearly              | Blocks are useful but risk becoming arbitrary passthrough. A clear validation boundary is safer than a half-supported `--json` replacement.                                                                                                          |
| D10 | Phase 1 rejects `--format blocks` with a clear validation error                                   | Strict blocks validation and fallback-text semantics are deferred so the first controlled path can ship a narrow stdin-only `mrkdwn` contract without exposing passthrough JSON.                                                                     |
| D11 | Do not restrict `slack-post-message` channels by repo/session directory                           | Outbound Slack posts are controlled by the Thor session boundary and purpose-built endpoint. Thor may need to post to channels that are not listed as inbound trigger channels for the current repo.                                                 |
| D12 | Accept recorded `opencode.subsession` callers for `slack-post-message`                            | Delegated agents receive their child session ID in `x-thor-session-id`; once the runner records the child as `opencode.subsession`, Slack aliases should bind to the parent's current session anchor just like other correlation-producing commands. |
| D13 | Allow `--blocks-file` to reference absolute temp paths                                            | Agents commonly create temporary Slack artifacts under `/tmp`; blocks files are parsed and validated as a top-level JSON array before posting, so they do not need to be constrained to the command cwd.                                             |
| D14 | Share `/tmp` between `opencode` and `remote-cli` with a named Compose volume                      | `slack-post-message` runs in OpenCode but parses block files in remote-cli. A shared temp volume preserves the documented `/tmp` workflow without requiring host-side temp directory setup.                                                          |
