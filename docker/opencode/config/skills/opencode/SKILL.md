---
name: opencode
description: Inspect and manage OpenCode sessions via the local HTTP API — list, check status, read history, create, and prompt sessions.
---

## When to use

Use this skill when:

- Checking active/busy sessions for a repo
- Reading message history from a prior session
- Creating a new session or sending a prompt into an existing one
- Debugging session state or investigating what a session did

---

## API base

```
http://127.0.0.1:4096
```

All requests use `curl`. For repo-scoped requests, set the header `x-opencode-directory: /workspace/repos/<repo>`.

---

## Core endpoints

### List sessions

```bash
curl -s 'http://127.0.0.1:4096/session?directory=%2Fworkspace%2Frepos%2F<repo>'
```

Returns sessions sorted by most recently updated. Supports filters: `directory`, `roots`, `start`, `search`, `limit`.

### Get session by ID

```bash
curl -s 'http://127.0.0.1:4096/session/<sessionID>'
```

Returns session metadata including its `directory` — use this to resolve which repo a session belongs to.

### Check active/busy sessions

```bash
curl -s -H 'x-opencode-directory: /workspace/repos/<repo>' \
  'http://127.0.0.1:4096/session/status'
```

Returns a map of `sessionID -> status`. Idle sessions are omitted — `{}` means nothing is busy.

**Important:** always scope by repo. The global `/session/status` can return `{}` while a repo-scoped call shows busy sessions.

### Read message history

```bash
curl -s 'http://127.0.0.1:4096/session/<sessionID>/message?directory=%2Fworkspace%2Frepos%2F<repo>'
```

Returns conversation history including assistant internal steps and tool calls, not just user-visible replies.

If this returns `404`, the session likely belongs to a different repo. Fetch the session first (`GET /session/<id>`), read its `directory`, and retry with the correct repo path.

### Create a new session

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{}' 'http://127.0.0.1:4096/session'
```

The new session inherits the running OpenCode instance's directory.

### Send a prompt

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"parts":[{"type":"text","text":"<prompt>"}]}' \
  'http://127.0.0.1:4096/session/<sessionID>/message'
```

---

## Busy-session check protocol

When asked about active or busy sessions:

1. Call `GET /session/status` with `x-opencode-directory` for each repo in scope
2. Treat repo-scoped status as the source of truth
3. Use `GET /session` only for history/context, not active-status truth
4. For busy session IDs, inspect with `GET /session/<id>` and `GET /session/<id>/message`
5. Do not claim "no active sessions" from the global call unless the user asked only for global status

---

## Gotchas

- Worklog notes and session API retention can diverge: a worklog note may still exist while `GET /session/<id>` returns `404`
- A worklog note under `/workspace/worklog` does not imply the session belongs to `/workspace/repos/thor` — sessions often ran in another repo
- `POST` requests are not rewritten by the SDK's directory logic — only `GET`/`HEAD` are
