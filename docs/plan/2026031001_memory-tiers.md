# Memory Tiers Plan — 2026-03-10-01

> Give Thor persistent memory so it builds on prior work instead of starting from scratch each time. Demonstrate the "AI team member who keeps notes" behavior for stakeholder demo.

## Decision Log

| #   | Decision                                        | Rationale                                                                                                         |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| D1  | **Correlation key** routes to existing sessions | Matches mvp.md session model. Same thread/issue/job = same conversation. Simple lookup, no embedding search.      |
| D2  | **OpenCode native session resumption**          | SDK already supports `session.messages()` and prompting into existing sessions. No need to reconstruct history.   |
| D3  | **Markdown notes files** as durable memory      | Human-readable, git-friendly, cheap. Agent can read/append during runs.                                           |
| D4  | **Runner owns session mapping**                 | Runner maps correlation keys to OpenCode session IDs in a local JSON file. No database dependency for PoC.        |
| D5  | **Skip cross-session retrieval**                | No semantic search or worklog-to-worklog linking. Each session only sees its own history. Keeps scope tight.      |
| D6  | **Expose OpenCode to admin**                    | OpenCode UI accessible at `http://localhost:4096` for session management. Runner `/sessions` endpoint removed.    |
| D7  | **No prompt seeding from notes**                | OpenCode session retains full conversation history. Notes file is durable record only, not injected into prompts. |

## Architecture

```
                        Docker Compose
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  ┌──────────────────┐       ┌────────────┐                     │
│  │  runner           │──MCP──│  proxy     │──MCP──► Atlassian  │
│  │                   │       │            │──MCP──► PostHog    │
│  │ OpenCode headless │       │ policy +   │                     │
│  │ (0.0.0.0:4096)    │       │ logging    │                     │
│  │ session mgmt      │       │            │                     │
│  │ notes r/w         │       └────────────┘                     │
│  └──────────────────┘                                          │
│        ▲                                                        │
│        │ POST /trigger                                        │
│        │ { prompt, correlationKey?, sessionId? }              │
│        │                                                        │
│  worklog/                                                       │
│  └─ 2026/03/10/                                                │
│     ├─ slack-thread-123.md    ← markdown notes per session   │
│     ├─ jira-ACME-456.md                                      │
│     └─ json/                  ← proxy tool call audit logs     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Phases

### Phase 1 — Session Continuity via Correlation Key

**Goal**: Same correlation key resumes the same OpenCode session. Follow-up prompts carry full conversation history.

Steps:

1. Extend `TriggerRequest` to accept optional `correlationKey` and `sessionId` fields
2. Add a session map store (`session-map.json`) in the runner — maps correlation keys to OpenCode session IDs
   - On trigger with `correlationKey`: look up existing session ID
   - On trigger with `sessionId`: use directly (bypass map)
   - On trigger with neither: create fresh session (current behavior)
3. Before resuming a session, verify it still exists via `client.session.get()` — if deleted or missing, create a new one and update the map
4. When resuming, use the existing session ID with `client.session.promptAsync()` (OpenCode retains full history server-side)
5. Return `correlationKey` in the trigger response alongside `sessionId` so callers can track continuity

**Exit criteria**:

- `curl -X POST /trigger -d '{"prompt":"List 3 recent Jira issues","correlationKey":"test-session-1"}'` creates a new session, returns a `sessionId` and `resumed: false`
- A second `curl -X POST /trigger -d '{"prompt":"Tell me more about the first one","correlationKey":"test-session-1"}'` resumes the same session — the agent references the prior issues without re-listing them, returns `resumed: true`
- The agent can recall information from the first prompt (e.g., secret code word test)

**Test**: `scripts/test-e2e.sh` sends two prompts with the same key, verifying session IDs match and the agent recalls prior context.

---

### Phase 2 — Working Notes as Durable Memory

**Goal**: Each session has a markdown notes file that persists across container restarts. The runner writes trigger context and summaries to it for human review.

Steps:

1. Define notes file structure — markdown, organized by date and correlation key:
   ```
   worklog/
   └─ 2026-03-10/
      ├─ json/              ← proxy audit logs (existing)
      └─ notes/
         ├─ test-session-1.md
         └─ jira-ACME-456.md
   ```
2. On first trigger for a correlation key, create the notes file with a header:

   ```markdown
   # Session: test-session-1

   Created: 2026-03-10T14:30:00Z
   Session ID: ses_xxx

   ## Trigger

   **Prompt**: List 3 recent Jira issues
   **Model**: (default)
   **Time**: 2026-03-10T14:30:00Z
   ```

3. On follow-up triggers (session resume), append the new prompt to the notes file:

   ```markdown
   ---

   ## Follow-up — 2026-03-10T14:35:00Z

   **Prompt**: Tell me more about the first one
   **Model**: (default)
   ```

4. On session completion, append a summary block to the notes:

   ```markdown
   ---

   ## Result — 2026-03-10T14:32:00Z

   **Status**: completed
   **Duration**: 3.2s
   **Tool calls**: 0 ((none))
   **Key findings**: <first 300 chars of response>
   ```

5. Notes files survive container restarts via the `./workspace` bind mount in docker-compose
6. **No prompt seeding** — OpenCode session already has full conversation history; notes file is for human review only

**Exit criteria**:

- After a trigger, a markdown file exists at `worklog/2026-03-10/notes/<key>.md` with the header and trigger context
- After a follow-up trigger with the same key, the file has both entries appended
- After session completion, a result summary block is appended
- The notes file is readable by humans; the agent doesn't need it for context

**Test**: `scripts/test-e2e.sh` checks that the notes file exists and contains trigger prompts and result summaries.

---

### Phase 3 — E2E Test Coverage

**Goal**: Automated tests validate the full memory chain: session continuity, notes persistence, and agent recall.

Steps:

1. `scripts/test-e2e.sh` covers:
   - Health checks (proxy + runner)
   - Tool listing (proxied Atlassian/PostHog tools visible)
   - Tool calls (actual Atlassian API calls work)
   - Memory continuity with secret code recall test:
     - Trigger #1: Tell agent a secret code, verify it confirms
     - Trigger #2 (same correlation key): Ask agent to recall the code, verify it does
     - Verify notes file has both triggers and results
2. Uses unique correlation key per run (timestamp-based), no cleanup needed

**Exit criteria**:

- All 20 assertions pass
- Agent recalls the secret code from trigger #1 in trigger #2 (proves session context works)
- Notes file contains both trigger prompts and result summaries

---

## Out of Scope (deferred)

- Cross-session knowledge retrieval (searching other sessions' worklogs)
- Embedding-based semantic search over worklogs
- Automatic worklog consolidation into `docs/`
- Session forking (`session.fork()` API)
- Database-backed session map (JSON file is sufficient for PoC/demo)
- Runner `/sessions` endpoint (admin uses OpenCode UI directly)
- JSON file writing from runner (proxy still writes tool call logs)
- Slack/webhook triggers (still using curl)
- Approval flow

## Dependencies

| Dependency                 | Version | Purpose                      | Status   |
| -------------------------- | ------- | ---------------------------- | -------- |
| `@opencode-ai/sdk`         | ^1.2.22 | Session resume, message list | Existing |
| `@thor/common`             | —       | Notes utilities              | Existing |
| No new dependencies needed | —       | —                            | —        |
