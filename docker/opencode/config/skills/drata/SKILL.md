---
name: drata
description: Query Drata through the read-only OAuth-backed API wrapper.
---

# Drata

Use `drata` for approved read-only Drata API requests. Credentials and OAuth tokens are handled server-side.

## Commands

```bash
drata api GET /public/v2/<path>
drata --help
```

Only `GET` requests under `/public/v2/` are supported by the wrapper. Other methods or absolute URLs are blocked by server-side policy.

Examples:

```bash
drata api GET /public/v2/<endpoint>
```

Use Drata API documentation or existing team notes to choose the exact endpoint path.
