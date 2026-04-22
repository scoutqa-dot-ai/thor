---
name: slack
description: Read Slack threads or channel history and post concise bot replies through Slack's real Web API URLs over Thor's mitmproxy path when the user asks to answer in Slack or when a Slack event payload provides channel and thread context.
---

## When to use

Use this skill when:

- the user asks you to reply in Slack
- the input contains Slack `channel` and `thread_ts` context
- you need to read a Slack thread before answering
- you need recent channel context to understand a Slack discussion
- you need to fetch a Slack file mentioned in a thread

General reply policy lives in `build.md`. This skill only covers how to read
and write Slack through the proxy.

## Transport

Talk to Slack through real upstream URLs:

- `https://slack.com/api/...`
- `https://files.slack.com/...`

Authentication is injected by `mitmproxy`. Do not pass `Authorization`
manually and do not look for a separate Slack MCP tool.

The default tool for this skill is `curl`. Prefer URL-encoded form for simple
Slack writes. Switch to JSON only when the payload becomes structured, such as
`blocks` or `attachments`.
For file uploads, prefer `slack-upload` over manually calling Slack's
multi-step upload endpoints.

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
URL directly. Auth is injected for `.slack.com` too. Use `/tmp` for temporary
downloads instead of assuming the current directory is writable.

```bash
curl -sS -o /tmp/slack-file.bin 'https://files.slack.com/files-pri/T123-F123/download/example'
```

### 4. Post a message

Example:

```bash
curl -sS -X POST https://slack.com/api/chat.postMessage \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'channel=C123' \
  --data-urlencode 'thread_ts=1710000000.001' \
  --data-urlencode 'text=Root cause looks like a missing env var in the worker deploy. I confirmed the crash started after the 14:10 rollout. Next step: redeploy with FOO_API_KEY restored.'
```

For multiline text, send real newline characters. Do not write literal `\n`
inside single quotes, or Slack will receive backslash-n text.

```bash
curl -sS -X POST https://slack.com/api/chat.postMessage \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'channel=C123' \
  --data-urlencode 'thread_ts=1710000000.001' \
  --data-urlencode "$(cat <<'EOF'
text=Good news: the AI did not crash.

The suite still has 0 test cases, so create_manual_ai_session had nothing to run.
EOF
)"
```

### 5. Upload a file

Use the helper instead of re-creating Slack's external upload flow inline.

```bash
slack-upload /tmp/report.txt \
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
- Use real Slack URLs. Do not route Slack work through `mcp slack`.
- Use `slack-upload` for uploads; it wraps `files.getUploadURLExternal`,
  the raw upload, and `files.completeUploadExternal`.
- Use `/tmp/...` for downloaded or generated files before re-uploading them.
- The gateway may give the agent Slack context, but the agent still has to post
  the actual reply itself.
- Slack Web API reads and writes still depend on the bot token's scopes and
  conversation membership.
- `files.info` gives metadata first; the actual file bytes come from
  `url_private` or `url_private_download`.
