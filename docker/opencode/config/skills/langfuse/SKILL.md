---
name: langfuse
description: Query and analyze Langfuse observability data (observations, metrics, scores) via the mcp CLI for debugging LLM behavior, cost, and user activity.
---

## When to use

Use this skill when:

- The user asks to debug LLM/agent behavior
- Investigating observations (LLM generations, spans, tool calls) — traces and
  sessions are queried as observations filtered by `traceId` / `sessionId`
- Analyzing cost, usage, or model performance
- Looking up activity for a specific user
- Exploring tool calls, agent steps, or execution flows
- Reviewing evaluation scores

---

## Overview

Langfuse is a **read-only** MCP upstream, reached through the `mcp` CLI like any
other upstream. It appears in `mcp` only when this session's profile resolves
Langfuse credentials.

```bash
mcp                                      # list upstreams available to this session
mcp langfuse                             # list Langfuse tools
mcp langfuse <tool>                      # show a tool's description + input schema
mcp langfuse <tool> '{"arg":"value"}'    # call a tool (single JSON argument)
```

Always start with `mcp langfuse` to list tools, then `mcp langfuse <tool>` to read
a tool's description and exact input schema, then call it with a single JSON argument.

Read-only tools available include:

- Observations: `listObservations`, `getObservation`, and the schema/filter
  helpers (`getObservationFieldSchema`, `getObservationFilterSchema`,
  `getObservationFilterValues`)
- Metrics: `queryMetrics`, `getMetricsSchema`
- Scores: `listScores`, `getScore`, `listScoreConfigs`, `getScoreConfig`

Write/mutation tools are not exposed (Langfuse access is read-only); they will not
appear in the listing.

---

## Core workflows

### 1. List recent observations (default entry point)

Keep payloads small with `limit` and filters:

```bash
mcp langfuse listObservations '{"limit":10,"type":"GENERATION"}'
```

### 2. Get full observation details

```bash
mcp langfuse getObservation '{"observationId":"<id>"}'
```

### 3. Filter by user

Use `getObservationFilterValues` / `getObservationFilterSchema` to discover the
exact filter shape, then pass it to `listObservations`.

### 4. Analyze metrics (cost, usage)

```bash
mcp langfuse getMetricsSchema '{}'
mcp langfuse queryMetrics '{"view":"observations","metrics":[{"measure":"totalCost","aggregation":"sum"}],"dimensions":[{"field":"name"}]}'
```

### 5. Review scores and score configs

```bash
mcp langfuse listScores '{"limit":10}'
mcp langfuse listScoreConfigs '{}'
```

---

## Execution strategy

1. Identify the goal:
   - Debug issue → observations → observation detail
   - User activity → filter observations by user
   - Cost analysis → metrics query
2. Start small: pass `limit` and narrow filters.
3. Read each tool's schema (run `mcp langfuse <tool>`) before constructing
   arguments — argument shapes are defined by the live MCP server, not by this skill.
4. Expand only when needed.

---

## Constraints

- Read-only: no create/update/delete tools are available.
- Avoid large payloads — pass `limit` and the narrowest filters.
- Argument names and pagination shapes come from each tool's live input schema;
  confirm them by running `mcp langfuse <tool>` (prints the input schema) rather than assuming.
