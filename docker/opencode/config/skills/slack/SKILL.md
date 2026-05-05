---
name: slack
description: Read Slack threads or channel history and post concise bot replies through slack-post-message when the user asks to answer in Slack or when a Slack event payload provides channel and thread context.
---

## When to use

Use this skill when:

- the user asks you to reply in Slack
- the input contains Slack `channel` and `thread_ts` context
- you need to read a Slack thread before answering
- you need recent channel context to understand a Slack discussion
- you need to fetch a Slack file mentioned in a thread

General reply policy lives in `build.md`. This skill covers how to read Slack
through the proxy and how to post messages through Thor's controlled helper.

## Transport

Talk to Slack through real upstream URLs:

- `https://slack.com/api/...`
- `https://files.slack.com/files-pri/...`

Authentication is injected automatically, do not pass `Authorization` header.

The default tool for Slack reads is `curl`. For message writes, use
`slack-post-message`; it posts through Thor's remote-cli path so Slack thread
aliases are registered. Message input is stdin-only. Do not use raw `curl` or
`fetch` for `chat.postMessage`, and do not pass Slack tokens manually.
For file uploads, keep using `slack-upload` over manually calling Slack's
multi-step upload endpoints.

## Temporary files

`/tmp` is the default location for all temporary Slack artifacts, including:

- downloaded files
- exported thread JSON
- generated reports intended only for inspection or upload

Do not save these files in `/workspace/repos` or `/workspace/worktrees` unless
the user explicitly asks to keep a persistent copy.

Decision rule:

- if the file is only needed for immediate upload, inspection, or short-term
  processing, create a unique temp path under `/tmp` with `mktemp`
- if the filename should stay meaningful, create a unique temp directory with
  `mktemp -d` and write the named file inside it
- if the user asks to keep it, then save it in a persistent workspace path

Do not use fixed paths like `/tmp/report.txt` or relative paths like
`./report.txt` for temporary Slack artifacts.

## Allowed Slack endpoints

Thor supports a narrow Slack surface for this skill: message posts through
`slack-post-message`; `reactions.add`, `conversations.replies`,
`conversations.history`, `files.info`, Slack's external upload endpoints, and
supported `files.slack.com` file URLs through the proxy. Do not call Slack
update/delete methods or reaction update/remove methods through this path.

## Core workflow

### 1. Resolve the reply target

Prefer explicit Slack context from the task:

- `channel`
- `thread_ts`

If `thread_ts` is present, reply in-thread. Do not create a new top-level
message when a thread reply is possible.

### 2. Read context before answering

For a thread reply, read the thread first unless the task already contains the
full context you need.

```bash
curl -sS --get https://slack.com/api/conversations.replies \
  --data-urlencode 'channel=C123' \
  --data-urlencode 'ts=1710000000.001' \
  --data-urlencode 'limit=50'
```

Use channel history only when there is no thread or when the user explicitly
needs broader channel context.

```bash
curl -sS --get https://slack.com/api/conversations.history \
  --data-urlencode 'channel=C123' \
  --data-urlencode 'limit=20'
```

### 3. Fetch files only when they matter

If the thread references a Slack file and the file contents are needed, inspect
the file first and then download from its private Slack URL when necessary.

```bash
curl -sS --get https://slack.com/api/files.info \
  --data-urlencode 'file=F123'
```

When the response includes `url_private` or `url_private_download`, fetch that
URL directly. Auth is injected for the supported `files.slack.com` paths.
Always download temporary Slack files to a unique temp path under `/tmp`.

```bash
DOWNLOAD_DIR="$(mktemp -d /tmp/slack-download.XXXXXX)"
DOWNLOAD_FILE="$DOWNLOAD_DIR/example.bin"

curl -sS -o "$DOWNLOAD_FILE" \
  'https://files.slack.com/files-pri/T123-F123/download/example'
```

### 4. Post a message

For a short single-line reply, pipe text into `slack-post-message`:

```bash
printf '%s\n' 'Root cause looks like a missing env var in the worker deploy. I confirmed the crash started after the 14:10 rollout. Next step: redeploy with FOO_API_KEY restored.' | \
  slack-post-message --channel C123 --thread-ts 1710000000.001
```

Always pass `--channel <id>` because Thor aliases store Slack thread timestamps,
not channel IDs. Message text must come from stdin; positional message text,
`--text`, temp-file expansion flags, and raw JSON passthrough are not supported.

For any multiline reply, use a heredoc or pipe. This is the default when the
message has paragraph breaks, bullets, code spans, or uncertain shell quoting.

```bash
slack-post-message --channel C123 --thread-ts 1710000000.001 <<'EOF'
Good news: the AI did not crash.

The suite still has 0 test cases, so create_manual_ai_session had nothing to run.
EOF
```

### 5. Add a reaction when requested

Use `reactions.add` only when the user explicitly asks for an emoji reaction or
when a workflow instruction calls for one, such as marking a Slack message done.

```bash
curl -sS -X POST https://slack.com/api/reactions.add \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'channel=C123' \
  --data-urlencode 'timestamp=1710000000.001' \
  --data-urlencode 'name=done'
```

### 6. Upload a file

Use the helper instead of re-creating Slack's external upload flow inline.
Generate the file in a unique temp path first unless the user explicitly asks
to keep it. If the filename matters, use a unique temp directory and a named
file inside it.

```bash
UPLOAD_DIR="$(mktemp -d /tmp/slack-upload.XXXXXX)"
REPORT_FILE="$UPLOAD_DIR/report.txt"

cat <<'EOF' >"$REPORT_FILE"
Summary:
- deploy is healthy
- backlog drain is complete
EOF

slack-upload "$REPORT_FILE" \
  --channel C123 \
  --thread-ts 1710000000.001 \
  --comment 'Attached the report.'
```

## Response handling

Slack Web API responses are JSON with an `ok` field.

- `ok: true` means the call succeeded
- `ok: false` means inspect the `error` field and surface the problem clearly

Common failures to report as-is:

- `channel_not_found`
- `not_in_channel`
- `missing_scope`
- `ratelimited`

## Gotchas

- Tool inputs use Slack IDs such as `C...` and `F...`, not channel names.
- `thread_ts` should be the parent message timestamp for the thread.
- Use real Slack URLs for reads, reactions, and uploads. Use
  `slack-post-message` for message posts. Do not route Slack work through
  `mcp slack`.
- `reactions.add` is the only reaction mutation supported through the proxy; do
  not call reaction update/remove methods.
- Do not send multiline Slack text as an inline shell string. Default to a
  heredoc or pipe into `slack-post-message`.
- Do not use literal `\n` inside single-quoted `text=...` arguments.
- Do not use shared temp paths. Default to `mktemp` under `/tmp`; use
  `mktemp -d` when you need a stable filename inside a unique temp directory.
- Use `slack-upload` for uploads; it wraps `files.getUploadURLExternal`,
  the raw `files.slack.com/upload/v1/...` upload, and
  `files.completeUploadExternal`.
- `/tmp` is the default location for temporary Slack artifacts. Treat
  `/workspace/worktrees` as persistent storage and use it only when
  persistence is explicitly requested.
- The gateway may give the agent Slack context, but the agent still has to post
  the actual reply itself.
- Slack Web API reads and writes still depend on the bot token's scopes and
  conversation membership.
- `files.info` gives metadata first; the actual file bytes come from
  `url_private` or `url_private_download`.
