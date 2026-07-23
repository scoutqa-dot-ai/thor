# Oversize approval content → Slack file, and a fail-hard approval gate

Approval cards cap section text at Slack's 3000-char block limit, so long tool
arguments are truncated in the card and the reviewer loses the exact content
they are being asked to approve (already flagged as a limitation in
`docs/plan/2026061601_aws-write-approval.md`). Fix this by uploading the full
content as a self-describing Markdown file reply in the approval thread.

While here, close a latent correctness hole: the approval gate accepts a
`tool: string` and silently falls back to a raw-JSON dump for anything it does
not recognize. The set of approval-gated tools is a closed discriminated union
(`ApprovalRequiredEventPayloadSchema`), so an unknown tool at the gate is a bug,
not a case to render. Make it fail hard, and delete the generic renderer that
only existed to handle the impossible case.

## Goal

- An approval whose rendered card body exceeds Slack's block limit uploads the
  **full, untruncated** presentation Markdown as a `.md` file into the same
  Slack thread with a meaningful approval comment. The card remains a short
  readable preview and does not depend on Slack returning a file URL.
- Only oversize approvals upload a file; normal-size approvals are unchanged.
- An unknown or invalid `{tool, args}` reaching `createPending` fails the
  approval loudly instead of rendering a degraded card.
- One rendering path (a structured presentation per known tool). The generic
  JSON-dump renderer and its progressive-trimming machinery are removed.

## Decisions

| #   | Decision                                                                                                                                                                                   | Rationale                                                                                                                                                                                                  | Rejected                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Fail hard on unknown/invalid approval tool, guarded at `createPending` (single runtime `ApprovalRequiredEventPayloadSchema` parse)                                                         | Every caller (MCP + CLI) funnels through `createPending`; it is the one choke point. An unknown approval tool is a fail-closed bug, not live-run drift, so it fails in all environments.                   | Guarding only in the MCP handler (CLI path unguarded); tolerating drift in production                           |
| 2   | Compile-time exhaustiveness: `buildApprovalPresentation`'s switch ends in `assertNever(tool)`                                                                                              | Makes "every approval tool has a presentation" a compiler-enforced invariant — adding a union member without a builder fails the build; the runtime throw is defense-in-depth behind the gate.             | `default: return undefined` (silently routes unknown tools to a fallback)                                       |
| 3   | Delete the generic renderer + trimming machinery (`formatApprovalArgs`, `buildInlineApprovalBlocks`, `TRIM_STEPS`, `trimValue`, `summarizeValue`, `buildOversizeSummary`, `MIN_TRIM_STEP`) | With the gate closed and the switch exhaustive, these are unreachable. The whole recursive-JSON-shrink apparatus existed only to fit oversize content into the card; the file upload replaces its purpose. | Keeping them as a defensive fallback (dead code that hides the bug decision #1 makes explicit)                  |
| 4   | Oversize content → upload the full presentation **Markdown** as a self-describing `.md` file reply                                                                                         | Both renderers already emit mrkdwn; `.md` renders well in Slack. The file is channel-scoped to the same thread members who see the card — no new exposure.                                                 | Public `permalink_public` URL (unauthenticated exposure of gated content); upload-without-share (reviewer 403s) |
| 5   | Upload-first, **fail fast**: when content is oversize the file is required; a failed upload fails the approval                                                                             | The card without the full content is the exact problem we are fixing; silently degrading would reintroduce it. A missing `files:write` scope becomes a clear hard failure, which is correct fail-closed.   | Best-effort upload that falls back to a truncated card (silently drops the content the reviewer must see)       |
| 6   | Post the file first with a meaningful comment, never request its URL, and never delete an uploaded file                                                                                    | The file reply is useful by itself if a later upload or card post fails. Accepting Slack's `ok: true` completion response and retaining successful uploads removes permalink parsing and cleanup branches. | Linking the file from the card; compensating `files.delete`; card-first then `chat.update`                      |
| 7   | Server-side upload in remote-cli sends `SLACK_BOT_TOKEN` directly, reusing the proven 3-call external-upload shape                                                                         | `remote-cli` holds the token and calls Slack directly (like `postSlackMessageApi`); `docker/opencode/bin/slack-upload` already proves the 3-call flow. `files:write` is already in the app manifest.       | Routing through mitmproxy injection (that path is for the in-container agent tool, not the remote-cli service)  |
| 8   | File-backed Slack inputs allow `/tmp` plus only the exact `/workspace/*` roots mounted into both OpenCode and remote-cli                                                                   | remote-cli mounts all of `/workspace`, including server-only approval data. Allowing the workspace root would let an agent ask the credential-holding service to upload files it cannot otherwise read.    | Allowing all of `/workspace`; maintaining separate path policies for `--file` and `--blocks-file`               |

## File-level impact

| Path                                                | Change                                                                                                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/approval-presentation.ts`      | Exhaustive `assertNever` switch; `buildApprovalPresentation` returns non-optional; delete generic renderer + trimming; add `approvalPresentationIsOversize` + `buildApprovalFileMarkdown`                               |
| `packages/common/src/index.ts`                      | Drop `formatApprovalArgs` / `buildInlineApprovalBlocks` exports                                                                                                                                                         |
| `packages/remote-cli/src/approval-service.ts`       | Runtime `ApprovalRequiredEventPayloadSchema` parse in `createPending` (fail hard); remove the `as` cast; upload the self-describing full-content file before the card                                                   |
| `packages/remote-cli/src/slack-post-message.ts`     | Add `uploadSlackFileApi` (3-call `getUploadURLExternal` → raw POST → `completeUploadExternal`) and repeatable `--file`; accept completion without file metadata, attach stdin as context, and retain successful uploads |
| `packages/gateway/src/approval.test.ts`             | Remove generic-renderer + raw-JSON-fallback tests; keep presentation + routing tests                                                                                                                                    |
| `packages/common/src/approval-presentation.test.ts` | Oversize → attachment payload emitted with full Markdown; normal → no attachment                                                                                                                                        |
| `docs/slack.md`                                     | Note approvals upload oversize content via `files:write`                                                                                                                                                                |

## Phases

**Phase 1 — Fail-hard gate + single presentation path.** Guard unknown/invalid
tools at `createPending`; make the presentation switch exhaustive; delete the
generic renderer and trimming machinery; remove the `as` cast. Card still
truncates oversize content via one `trimForSlack` path (file upload lands in
Phase 2). Tests: gate rejects unknown tool and invalid args; presentations
render for all known tools; exhaustiveness throws for a force-cast unknown.

**Phase 2 — Oversize content → self-describing Slack file.** Add `uploadSlackFileApi`;
when `approvalPresentationIsOversize`, `postSlackApprovalMessage` uploads
`buildApprovalFileMarkdown(presentation)` first with a meaningful approval
comment (fail fast), then posts the preview card. Upload success depends only on
Slack completing the upload; no permalink is requested or rendered, and a file
that reaches Slack is never deleted. Docs. Tests: oversize → file uploaded with
full Markdown + self-contained comment; upload failure fails the approval; card
failure retains the file.

## Exit criteria

- Unknown or invalid `{tool, args}` at `createPending` returns a failing
  `ApprovalExecResult` and never posts a card or persists a pending action.
- Adding a tool to `ApprovalRequiredEventPayloadSchema` without a presentation
  builder fails `tsc`.
- No references remain to `formatApprovalArgs`, `buildInlineApprovalBlocks`, or
  the trimming helpers.
- An oversize approval uploads a `.md` file with the full presentation Markdown
  and a meaningful comment to the approval thread; the card contains no file
  URL, and a normal approval uploads nothing and is byte-for-byte unchanged.
- A failed upload of oversize content fails the approval (no truncated-card
  fallback); any file that reaches Slack remains useful in the thread even when
  a later operation fails.
- `slack-post-message` rejects file and blocks paths under server-only workspace
  directories such as `/workspace/data`, while accepting `/tmp` and the explicit
  workspace roots shared with the agent container.
- `@thor/common`, `@thor/remote-cli`, `@thor/gateway` typecheck; targeted suites
  green.

## Out of scope

- Public/external file links (`files.sharedPublicURL`).
- Uploading files for normal-size approvals.
- Linking uploaded approval files from the card.
