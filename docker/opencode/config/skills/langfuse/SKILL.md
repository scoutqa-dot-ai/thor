---
name: langfuse
description: Query and analyze Langfuse observability data (observations, metrics, scores, prompts, models) via the mcp CLI for debugging LLM behavior, cost, and user activity.
---

## When to use

Use this skill when:

- The user asks to debug LLM/agent behavior
- Investigating traces, spans, generations, or sessions in Langfuse
- Analyzing cost, usage, or model performance
- Looking up activity for a specific user
- Exploring tool calls, agent steps, or execution flows
- Reviewing evaluation scores or prompt definitions

---

## Overview

Langfuse is a **read-only** MCP upstream, reached through the `mcp` CLI like any
other upstream. It appears in `mcp` only when this session's profile resolves
Langfuse credentials.

```bash
mcp                                      # list upstreams available to this session
mcp langfuse                             # list Langfuse tools
mcp langfuse <tool> --help               # show a tool's description + input schema
mcp langfuse <tool> '{"arg":"value"}'    # call a tool (single JSON argument)
```

Always start with `mcp langfuse` and `--help` to read the live tool list and each
tool's exact input schema, then call with a single JSON argument.

Read-only tools available include:

- Observations: `listObservations`, `getObservation`, and the schema/filter
  helpers (`getObservationFieldSchema`, `getObservationFilterSchema`,
  `getObservationFilterValues`)
- Metrics: `queryMetrics`, `getMetricsSchema`
- Scores: `listScores`, `getScore`, `listScoreConfigs`, `getScoreConfig`
- Models: `listModels`, `getModel`
- Prompts: `listPrompts`, `getPrompt`, `getPromptUnresolved`
- Health/media: `getHealth`, `getMedia`

Write/mutation tools are not exposed (Langfuse access is read-only); they will not
appear in the listing.

---

## Core workflows

### 1. List recent observations (default entry point)

Narrow by time and limit to keep payloads small. Inspect the live schema first:

```bash
mcp langfuse getObservationFilterSchema --help
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

### 5. Inspect prompts and models

```bash
mcp langfuse listPrompts '{}'
mcp langfuse getPrompt '{"name":"<prompt-name>"}'
mcp langfuse listModels '{}'
```

---

## Execution strategy

1. Identify the goal:
   - Debug issue → observations → observation detail
   - User activity → filter observations by user
   - Cost analysis → metrics query
2. Start small: pass `limit` and narrow filters.
3. Read each tool's `--help` schema before constructing arguments — argument
   shapes are defined by the live MCP server, not by this skill.
4. Expand only when needed.

---

## Constraints

- Read-only: no create/update/delete tools are available.
- Avoid large payloads — pass `limit` and the narrowest filters.
- Argument names and pagination shapes come from each tool's live input schema;
  confirm them with `mcp langfuse <tool> --help` rather than assuming.
