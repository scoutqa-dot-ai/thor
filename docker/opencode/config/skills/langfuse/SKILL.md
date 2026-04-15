---
name: langfuse
description: Query and analyze Langfuse observability data (traces, observations, metrics) via CLI for debugging LLM behavior, cost, and user activity.
---

## When to use

Use this skill when:

- The user asks to debug LLM/agent behavior
- Investigating traces, sessions, or observations in Langfuse
- Analyzing cost, usage, or model performance
- Looking up activity for a specific user (via Katalon UUID)
- Exploring tool calls, agent steps, or execution flows

---

## Overview

This skill provides **read-only access** to Langfuse via CLI:

```bash
langfuse api <resource> <action> [options]
```

Available resources:

- `traces`
- `sessions`
- `observations`
- `metrics`
- `models`
- `prompts`

Inspect schema:

```bash
langfuse api __schema
```

---

## Core workflows

### 1. List recent traces (default entry point)

Always narrow by timestamp to avoid errors.

```bash
langfuse api traces list \
  --limit 10 \
  --from-timestamp "<ISO_TIMESTAMP>" \
  --fields "core,metrics"
```

---

### 2. Get full trace details

```bash
langfuse api traces get <trace-id>
```

Use this after identifying a relevant trace.

---

### 3. Filter traces by user

```bash
langfuse api traces list \
  --limit 50 \
  --from-timestamp "<ISO_TIMESTAMP>" \
  --filter '[{"type":"string","column":"userId","operator":"=","value":"<uuid>"}]' \
  --fields "core,metrics"
```

---

### 4. Inspect observations (tool calls, LLM steps)

```bash
langfuse api observations list \
  --user-id "<uuid>" \
  --type "TOOL" \
  --fields "core,basic"
```

Pagination with `--cursor "<cursor-from-body.meta.cursor>"`

---

### 5. Analyze metrics (cost, usage)

```bash
langfuse api metrics list \
  --query '<JSON_QUERY>'
```

Example (cost by model):

```json
{
  "view": "observations",
  "dimensions": [{ "field": "name" }],
  "metrics": [
    { "measure": "totalCost", "aggregation": "sum" },
    { "measure": "count", "aggregation": "sum" }
  ],
  "fromTimestamp": "...",
  "toTimestamp": "...",
  "config": { "row_limit": 20 }
}
```

---

## Execution strategy

1. Identify the goal:
   - Debug issue → traces → trace detail → observations
   - User activity → filter by userId
   - Cost analysis → metrics query

2. Start small:
   - Use `--limit`
   - Use `--fields`

3. Expand only when needed:
   - Fetch full trace
   - Traverse observations

4. Handle pagination:
   - Traces → `--page`
   - Observations → `--cursor`

---

## Response format

All responses follow:

```json
{
  "ok": true,
  "status": 200,
  "body": {
    "data": [...],
    "meta": {
      "totalItems": 100,
      "totalPages": 10,
      "page": 1
    }
  }
}
```

Access:

- Data → `body.data[]`
- Pagination → `body.meta`

---

## Constraints

- Read-only usage only (no mutations)
- Always include `--from-timestamp` when listing traces
- Avoid large payloads:
  - Use `--limit`
  - Use `--fields`
- Do not assume pagination type (resource-dependent)

---

## Gotchas

- Pagination differs:
  - `traces` → page-based (`--page`)
  - `observations` → cursor-based (`meta.cursor`)
- Trace IDs must be full 32-character values
- Observation types include:
  - `GENERATION`, `TOOL`, `AGENT`, `SPAN`, `EVENT`, etc.
- Only `startTimeMonth` is valid for time aggregation in metrics
