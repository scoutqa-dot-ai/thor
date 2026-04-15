# Langfuse CLI — LLM Trace Queries

Read-only access to the Langfuse observability backend for KAI (Katalon AI).

## CLI syntax

```
langfuse api <resource> <action> [options]
langfuse api __schema                        # list all resources
langfuse api <resource> --help               # show options for a resource
```

Resources: `traces`, `sessions`, `observations`, `metrics`, `models`, `prompts`.

## Response format

All responses wrap in `{ok, status, body}`. List endpoints return `body.data[]` with pagination at `body.meta`.

```json
{
  "ok": true,
  "status": 200,
  "body": {
    "data": [...],
    "meta": { "totalItems": 100, "totalPages": 10, "page": 1 }
  }
}
```

## Cheat sheet

### List recent traces (always narrow by date to avoid 422)

```
langfuse api traces list --limit 10 --from-timestamp "2026-04-12T00:00:00Z" --fields "core,metrics"
```

### Get a specific trace

```
langfuse api traces get <trace-id>
```

### Metrics — cost by model

```
langfuse api metrics list --query '{"view":"observations","dimensions":[{"field":"name"}],"metrics":[{"measure":"totalCost","aggregation":"sum"},{"measure":"count","aggregation":"sum"}],"fromTimestamp":"2026-04-01T00:00:00Z","toTimestamp":"2026-04-14T00:00:00Z","config":{"row_limit":20}}'
```

### Filter traces by user (userId = Katalon auth_users.uuid)

```
langfuse api traces list --limit 50 --from-timestamp "2026-04-12T00:00:00Z" --filter '[{"type":"string","column":"userId","operator":"=","value":"<katalon-platform-uuid>"}]' --fields "core,metrics"
```

### List observations for a user (cursor-based pagination)

```
langfuse api observations list --user-id "<uuid>" --type "TOOL" --fields "core,basic"
# Next page: add --cursor "<cursor-from-body.meta.cursor>"
```

## Gotchas

- **Pagination differs by resource.** Traces use `--page N` with `meta.totalPages`. Observations use cursor-based: read `body.meta.cursor` and pass `--cursor <value>` for the next page.
- **Large traces can be multi-MB.** Browser automation traces (`manual_test_execution_agent`) can have 1,500–2,700+ observations. Use `--limit` and `--fields` to keep responses small.
- **Trace IDs are full 32-char hex.** They look truncated in list view but are complete. Use the full `id` field for `traces get`.
- **User IDs are Katalon Platform UUIDs** (e.g., `5fe059fe-19cf-...`) mapping to `dw_katone.auth_users.uuid` in Metabase, not the numeric `auth_users.id`.
- **Observation types:** `GENERATION` (LLM calls), `SPAN`, `EVENT`, `AGENT`, `TOOL` (function calls), `CHAIN`, `RETRIEVER`, `EVALUATOR`, `EMBEDDING`, `GUARDRAIL`.
- **Only `startTimeMonth` is valid** for observation time dimensions. There is no `startTimeDay`. For daily breakdowns, paginate traces and aggregate client-side.
- **`--json` is auto-appended** for `list` and `get` commands. Do not add it manually.
