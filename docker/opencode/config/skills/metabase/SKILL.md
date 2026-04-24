---
name: metabase
description: Query and analyze Metabase warehouse data (schemas, tables, columns, SQL results) for business questions, investigations, and reporting.
---

## When to use

Use this skill when:

- The user asks a data question or wants product, growth, revenue, or support metrics
- Investigating user activity or account state via warehouse data
- Exploring available schemas, tables, or columns before writing a query
- Validating assumptions with direct SQL instead of guessing from code or dashboards
- Producing a data-backed summary or report

---

## Overview

This skill provides **read-only access** to Metabase via CLI:

```bash
metabase schemas
metabase tables <schema>
metabase columns <schema> <table>
metabase query '<SQL>'
metabase question <question-id>
```

Discovery commands (`schemas`, `tables`, `columns`) are filtered by `METABASE_ALLOWED_SCHEMAS`.

---

## Core workflows

### 0. Start from a saved question URL

When the user gives you a Metabase question URL like
`https://insights-metabase.katalon.com/question/7751-daily-log-web-pages-paths`,
fetch the SQL it uses directly instead of guessing from the slug:

```bash
metabase question 7751
# or pass the full URL slug — the ID is parsed automatically:
metabase question 7751-daily-log-web-pages-paths
```

Response: `{ id, name, description, sql }` — use `sql` as the starting point for your query.
Adapt it (add filters, change date ranges, narrow columns, etc.) then run with `metabase query`.

Only native SQL questions are supported. MBQL (GUI-built) questions will return an error.

---

### 1. List available schemas

Start here to see what warehouse areas are exposed.

```bash
metabase schemas
```

---

### 2. List tables in a schema

```bash
metabase tables dm_products
```

Use this after identifying the likely domain for the question.

---

### 3. Inspect columns before querying

```bash
metabase columns dm_products fact_feature
```

Use this to confirm names and types before writing SQL.

---

### 4. Run a focused SQL query

Always start small and use schema-qualified names.

```bash
metabase query 'SELECT id, name FROM dm_products.fact_feature LIMIT 20'
```

---

### 5. Iterate toward the final answer

Typical progression:

```bash
metabase schemas
metabase tables dm_growth
metabase columns dm_growth dim_account
metabase query 'SELECT account_id, created_at FROM dm_growth.dim_account ORDER BY created_at DESC LIMIT 20'
```

---

## Execution strategy

1. Identify the business question:
   - Discovery needed → schemas → tables → columns
   - Known table → columns → query
   - Reporting request → small query first, then refine

2. Start small:
   - Use `LIMIT`
   - Select explicit columns instead of `SELECT *`

3. Expand only when needed:
   - Add filters
   - Add joins
   - Increase result size only after the shape is correct

4. Show your work:
   - Include the SQL you ran
   - Summarize the result clearly

---

## Response format

Discovery commands return JSON:

- `schemas` → `string[]`
- `tables` → `{ name, id, description }[]`
- `columns` → `{ name, type, description }[]`

Query responses return:

```json
{
  "columns": ["col_a", "col_b"],
  "rows": [["value_a", "value_b"]],
  "row_count": 1
}
```

Access:

- Column names → `columns[]`
- Result rows → `rows[][]`
- Total returned rows → `row_count`

---

## Constraints

- Read-only usage only
- Discovery commands are limited to allowed schemas
- Always use schema-qualified table names in SQL
- Start with small result sets
- Treat the database role as the real security boundary, not SQL text filtering

---

## Gotchas

- `tables` and `columns` only work for schemas in `METABASE_ALLOWED_SCHEMAS`
- `columns` is a two-step lookup under the hood and depends on the exact table name
- SQL is not keyword-blocked; the read-only DB role is what prevents writes
- Large result sets will be truncated by the agent runtime, so prefer targeted queries
- Query text can contain PII-sensitive predicates; summarize carefully when reporting results
