# Oversize approval content → Slack file, and a fail-hard approval gate

Approval cards cap section text at Slack's 3000-char block limit, so long tool
arguments are truncated in the card and the reviewer loses the exact content
they are being asked to approve (already flagged as a limitation in
`docs/plan/2026061601_aws-write-approval.md`). Fix this by uploading the full
content as a Markdown file in the approval thread and linking it from the card.

While here, close a latent correctness hole: the approval gate accepts a
`tool: string` and silently falls back to a raw-JSON dump for anything it does
not recognize. The set of approval-gated tools is a closed discriminated union
(`ApprovalRequiredEventPayloadSchema`), so an unknown tool at the gate is a bug,
not a case to render. Make it fail hard, and delete the generic renderer that
only existed to handle the impossible case.

## Goal

- An approval whose rendered card body exceeds Slack's block limit uploads the
  **full, untruncated** presentation Markdown as a `.md` file into the same
  Slack thread, and the approval card links to it. The card still shows a short
  readable preview; the reviewer is one click from the complete content.
- Only oversize approvals upload a file; normal-size approvals are unchanged.
- An unknown or invalid `{tool, args}` reaching `createPending` fails the
  approval loudly instead of rendering a degraded card.
- One rendering path (a structured presentation per known tool). The generic
  JSON-dump renderer and its progressive-trimming machinery are removed.

## Decisions

| #   | Decision                                                                                                                                                                                   | Rationale                                                                                                                                                                                                  | Rejected                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Fail hard on unknown/invalid approval tool, guarded at `createPending` (single runtime `ApprovalRequiredEventPayloadSchema` parse)                                                         | Every caller (MCP + CLI) funnels through `createPending`; it is the one choke point. An unknown approval tool is a fail-closed bug, not live-run drift, so it fails in all environments.                   | Guarding only in the MCP handler (CLI path unguarded); tolerating drift in production                             |
| 2   | Compile-time exhaustiveness: `buildApprovalPresentation`'s switch ends in `assertNever(tool)`                                                                                              | Makes "every approval tool has a presentation" a compiler-enforced invariant — adding a union member without a builder fails the build; the runtime throw is defense-in-depth behind the gate.             | `default: return undefined` (silently routes unknown tools to a fallback)                                         |
| 3   | Delete the generic renderer + trimming machinery (`formatApprovalArgs`, `buildInlineApprovalBlocks`, `TRIM_STEPS`, `trimValue`, `summarizeValue`, `buildOversizeSummary`, `MIN_TRIM_STEP`) | With the gate closed and the switch exhaustive, these are unreachable. The whole recursive-JSON-shrink apparatus existed only to fit oversize content into the card; the file upload replaces its purpose. | Keeping them as a defensive fallback (dead code that hides the bug decision #1 makes explicit)                    |
| 4   | Oversize content → upload the full presentation **Markdown** as a `.md` file, linked from the card                                                                                         | Both renderers already emit mrkdwn; `.md` renders well in Slack. The file is channel-scoped to the same thread members who see the card — no new exposure.                                                 | Public `permalink_public` URL (unauthenticated exposure of gated content); upload-without-share (reviewer 403s)   |
| 5   | Upload-first, **fail fast**: when content is oversize the file is required; a failed upload fails the approval                                                                             | The card without the full content is the exact problem we are fixing; silently degrading would reintroduce it. A missing `files:write` scope becomes a clear hard failure, which is correct fail-closed.   | Best-effort upload that falls back to a truncated card (silently drops the content the reviewer must see)         |
| 6   | Post file first, then the card linking its permalink; best-effort `files.delete` the file if the card post then fails                                                                      | The card is the load-bearing message (its `ts` is stored and the gateway `chat.update`s it on resolve). Needing the permalink in the card forces upload-first; cleanup avoids an orphan file reply.        | Card-first then `chat.update` to inject the link (adds a `chat.update` capability remote-cli does not have today) |
| 7   | Server-side upload in remote-cli sends `SLACK_BOT_TOKEN` directly, reusing the proven 3-call external-upload shape                                                                         | `remote-cli` holds the token and calls Slack directly (like `postSlackMessageApi`); `docker/opencode/bin/slack-upload` already proves the 3-call flow. `files:write` is already in the app manifest.       | Routing through mitmproxy injection (that path is for the in-container agent tool, not the remote-cli service)    |

## File-level impact

| Path                                                | Change                                                                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/approval-presentation.ts`      | Exhaustive `assertNever` switch; `buildApprovalPresentation` returns non-optional; delete generic renderer + trimming; `buildApprovalSlackMessage` surfaces full Markdown when the card body is truncated |
| `packages/common/src/index.ts`                      | Drop `formatApprovalArgs` / `buildInlineApprovalBlocks` exports                                                                                                                                           |
| `packages/remote-cli/src/approval-service.ts`       | Runtime `ApprovalRequiredEventPayloadSchema` parse in `createPending` (fail hard); remove the `as` cast; upload-first + link + orphan cleanup in `postSlackApprovalMessage`                               |
| `packages/remote-cli/src/slack-post-message.ts`     | Add `uploadSlackFileApi` (3-call `getUploadURLExternal` → raw POST → `completeUploadExternal`), sharing `fetch`/`env` deps with `postSlackMessageApi`                                                     |
| `packages/gateway/src/approval.test.ts`             | Remove generic-renderer + raw-JSON-fallback tests; keep presentation + routing tests                                                                                                                      |
| `packages/common/src/approval-presentation.test.ts` | Oversize → attachment payload emitted with full Markdown; normal → no attachment                                                                                                                          |
| `docs/slack.md`                                     | Note approvals upload oversize content via `files:write`                                                                                                                                                  |

## Phases

**Phase 1 — Fail-hard gate + single presentation path.** Guard unknown/invalid
tools at `createPending`; make the presentation switch exhaustive; delete the
generic renderer and trimming machinery; remove the `as` cast. Card still
truncates oversize content via one `trimForSlack` path (file upload lands in
Phase 2). Tests: gate rejects unknown tool and invalid args; presentations
render for all known tools; exhaustiveness throws for a force-cast unknown.

**Phase 2 — Oversize content → Slack file + link.** Add `uploadSlackFileApi`;
`buildApprovalSlackMessage` returns the full Markdown alongside the truncated
card when oversize; `postSlackApprovalMessage` uploads first (fail fast), posts
the card linking the file permalink, and cleans up the file if the card post
fails. Docs. Tests: oversize → file uploaded (full Markdown) + card links it;
upload failure fails the approval; card failure triggers file cleanup.

## Exit criteria

- Unknown or invalid `{tool, args}` at `createPending` returns a failing
  `ApprovalExecResult` and never posts a card or persists a pending action.
- Adding a tool to `ApprovalRequiredEventPayloadSchema` without a presentation
  builder fails `tsc`.
- No references remain to `formatApprovalArgs`, `buildInlineApprovalBlocks`, or
  the trimming helpers.
- An oversize approval uploads a `.md` file with the full presentation Markdown
  to the approval thread and links it from the card; a normal approval uploads
  nothing and is byte-for-byte unchanged.
- A failed upload of oversize content fails the approval (no truncated-card
  fallback); a card-post failure after upload removes the orphaned file.
- `@thor/common`, `@thor/remote-cli`, `@thor/gateway` typecheck; targeted suites
  green.

## Out of scope

- Public/external file links (`files.sharedPublicURL`).
- Uploading files for normal-size approvals or for non-approval Slack messages.
- Re-linking the file into the card after the gateway overwrites it on resolve
  (the file reply persists in-thread as the record).
