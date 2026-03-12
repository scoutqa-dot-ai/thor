# GitHub Webhook Handler

**Created**: 2026-03-11
**Status**: Done

## Goal

Add a `POST /github/events` endpoint to the gateway so Thor can receive GitHub events from the Acme repo (and any other repo). Events are sent by GitHub Actions workflows that `curl` into the gateway. This enables Thor to react to PRs, issues, releases, pushes, and comments.

## Architecture

The gateway already has a queue-based event pipeline for Slack. GitHub events plug into the same pipeline:

```
GitHub Actions (Acme repo)
  → curl POST /github/events with JSON body { event, ... }
  → Validate with Zod schema
  → Enqueue with source: "github", readyAt: now (no batching)
  → Queue handler dispatches to runner with prompt
```

The GitHub Actions workflow wraps the raw `github.event` context in a thin envelope with the event type. No transformation, no signature verification.

### Payload Format

```json
{
  "event": "pull_request",
  "payload": { ... raw github.event context ... }
}
```

The `payload` is the raw `${{ toJSON(github.event) }}` — we forward it as-is. This means:

- Zero transformation in the workflow
- Thor automatically gets any new fields GitHub adds
- Gateway only validates the envelope (`event` + `payload`), and extracts routing fields (repo, number, branch, etc.) from the payload for correlation keys

### Key Differences from Slack

| Aspect        | Slack                      | GitHub                             |
| ------------- | -------------------------- | ---------------------------------- |
| Batching      | Yes (3s–60s delay)         | No (immediate)                     |
| Auth          | HMAC-SHA256 signature      | None (internal)                    |
| Source        | Slack platform webhook     | GitHub Actions `curl`              |
| Payload       | Slack-defined envelope     | Thin envelope + raw `github.event` |
| Correlation   | `slack:thread:{ts}`        | `github:{type}:{repo}:{id}`        |
| Session reuse | Same thread → same session | Same PR/issue → same session       |

### Correlation Keys

All supported events use `git:branch:{repo}:{branch}` so that PR activity, reviews, and pushes to the same branch share a session:

- PR events: `git:branch:{repo}:{head.ref}`
- PR review events: `git:branch:{repo}:{head.ref}`
- Push events: `git:branch:{repo}:{branch}`

Issues, releases, and issue comments are out of scope (use Linear instead).

## Phases

### Phase 1: GitHub module — schemas and helpers

**Files**: `packages/gateway/src/github.ts`

- Zod envelope schema: `{ event: string, payload: object }`
- Minimal Zod schemas per event type to extract routing fields (repo, number, branch, tag) for correlation keys — uses `.passthrough()` so unknown fields are preserved
- `parseGitHubEvent(body)` — validates envelope, returns typed event or undefined
- `getGitHubCorrelationKey(event)` — returns correlation key string
- Type exports

**Exit criteria**:

- All types compile
- Unit-testable in isolation (no Express dependency)

### Phase 2: Gateway route and service integration

**Files**: `packages/gateway/src/app.ts`, `packages/gateway/src/service.ts`

- Add `POST /github/events` route to Express app
- Route GitHub events through queue handler with `source: "github"`
- Generalize queue handler to dispatch GitHub events to runner

**Exit criteria**:

- Unsupported event types return 200 with `{ ok: true, ignored: true }`
- Supported events enqueue and trigger the runner

### Phase 3: Tests

**Files**: `packages/gateway/src/github.test.ts`

- PR opened event → enqueue → runner trigger
- Issue opened event → enqueue → runner trigger
- Release published → enqueue → runner trigger
- Unsupported event type → ignored
- Invalid payload shape → ignored

**Exit criteria**:

- All tests pass (`pnpm test`)
- Coverage mirrors existing Slack test patterns

### Phase 4: Ingress config

**Files**: `docker/ingress/nginx.conf`

- Add `/github/` route in nginx ingress

**Exit criteria**:

- Requests to `http://host:8080/github/events` reach the gateway

## Maintenance

When Thor adds support for new GitHub event types (by updating `SUPPORTED_EVENTS` in `github.ts`), the example workflow in `docs/notify-thor.example.yml` must also be updated — add the new event to the `on:` triggers and the branch resolution `case` block. Source repos that have already copied the workflow will need to update their copy.

## Out of Scope

- Acme-side GitHub Actions workflow file (separate repo)
- Runner system prompt changes to interpret GitHub events
- GitHub API calls from Thor (already handled by Thor's MCP tools)
- Rate limiting or abuse protection

## Decision Log

| #   | Decision                                         | Rationale                                                                                    |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1   | No batching for GitHub events                    | GitHub events are independent; unlike Slack thread messages, there's no benefit to grouping  |
| 2   | Reuse existing EventQueue                        | Same infrastructure, just different source/correlation pattern                               |
| 3   | Forward raw `github.event` payload               | Zero transformation in workflow, automatically picks up new GitHub fields, less maintenance  |
| 4   | Separate `github.ts` module                      | Mirrors `slack.ts` structure; keeps concerns isolated                                        |
| 5   | No signature verification                        | Endpoint is internal, not publicly discoverable. Keep it simple.                             |
| 6   | Thin envelope (`event` + `payload`) in JSON body | Workflow just does `{ "event": context.eventName, "payload": context.event }` — minimal glue |
