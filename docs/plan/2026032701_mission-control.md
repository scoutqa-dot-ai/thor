# Mission Control Integration

**Date:** 2026-03-27
**Status:** In Progress

## Goal

Replace Slack-as-cron and add a visual task board for dispatching work to Thor, using [Mission Control](https://github.com/builderz-labs/mission-control) as the orchestration UI and a new `@thor/mission-control` bridge package as the glue.

## Architecture

```
Mission Control (Next.js + SQLite)      Thor Stack
┌──────────────────────────┐     ┌──────────────────────┐
│ Kanban board / scheduler │     │ gateway (existing)   │
│ REST API (:3100)         │◄────┤  Slack / GitHub / MC │
│ Task queue               │     │                      │
└──────────┬───────────────┘     │ runner (existing)    │
           │ poll / webhook      │  /trigger endpoint   │
           ▼                     │                      │
┌──────────────────────────┐     │ opencode (existing)  │
│ @thor/mission-control    │────►│  AI engine           │
│ bridge (new package)     │     └──────────────────────┘
│ - registers Thor agent   │
│ - polls task queue       │
│ - calls runner /trigger  │
│ - reports status back    │
└──────────────────────────┘
```

The bridge runs as a new Docker service. It:

1. Registers Thor as an agent in Mission Control on startup
2. Polls `GET /api/tasks/queue` at configurable intervals
3. For each assigned task, calls the runner's `POST /trigger`
4. Consumes the NDJSON stream for status updates
5. Reports completion/failure back to Mission Control via `PATCH /api/tasks/:id`

## Phases

### Phase 1: Mission Control Docker service

Add Mission Control as a service in `docker-compose.yml`. SQLite volume for persistence.

### Phase 2: Bridge package (`@thor/mission-control`)

New package in `packages/mission-control/` that:

- Registers Thor as an agent on startup
- Polls the task queue
- Bridges tasks to runner `/trigger`
- Reports back status + output

### Phase 3: Dockerfile target

Add the bridge to the multi-stage Dockerfile.

### Phase 4: Task templates

Design recurring task templates for common jobs (replacing cron-based Slack triggers).

## Decision Log

| Decision                                        | Rationale                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Separate bridge package vs. gateway integration | Keeps gateway focused on webhooks; bridge is a polling consumer with different lifecycle                                          |
| Poll-based vs. webhook-based                    | Mission Control supports both; polling is simpler for initial integration and doesn't require MC to reach Thor's internal network |
| Keep Slack/GitHub triggers                      | Mission Control is additive — existing triggers continue to work                                                                  |
| Use runner's /trigger endpoint                  | Reuse existing session management, notes, and progress streaming                                                                  |

## Out of Scope

- Mission Control's OpenClaw/CrewAI/LangGraph adapters (we use OpenCode directly)
- Mission Control's built-in Claude Code bridge (we have our own)
- Multi-agent orchestration (Thor is a single agent for now)
