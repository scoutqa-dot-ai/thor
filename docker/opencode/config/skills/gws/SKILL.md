---
name: gws
description: Inspect Google Workspace Drive, Docs, Sheets data through the read-only gws wrapper.
---

## When to use

Use this skill when the user asks you to inspect Google Workspace resources such as shared Drive files, Docs, Sheets.

## Overview

Use the `gws` command for read-only Google Workspace inspection:

```bash
gws <service> <resource> [sub-resource] <method> [flags]
```

Supported services documented here:

- `drive`
- `docs`
- `sheets`

Discovery commands:

```bash
gws --help
gws drive --help
gws schema drive.files.list
```

## Output and auth

- API calls return JSON; inspect the returned fields directly.
- Do not pass auth or credential flags. If Google access is not configured, the command will fail with an auth/configuration error.
- Keep queries narrow. Prefer IDs, explicit ranges, small page sizes, or bounded filters where available.

## Supported command shapes

Drive:

```bash
gws drive about get
gws drive files get --params '{"fileId":"..."}'
gws drive files list --params "{\"pageSize\":10,\"q\":\"name contains 'spec'\"}"
gws drive files export --params '{"fileId":"...","mimeType":"text/plain"}'
gws drive drives get --params '{"driveId":"..."}'
gws drive drives list
gws drive permissions get --params '{"fileId":"...","permissionId":"..."}'
gws drive permissions list --params '{"fileId":"..."}'
gws drive comments get --params '{"fileId":"...","commentId":"..."}'
gws drive comments list --params '{"fileId":"..."}'
gws drive replies get --params '{"fileId":"...","commentId":"...","replyId":"..."}'
gws drive replies list --params '{"fileId":"...","commentId":"..."}'
gws drive revisions get --params '{"fileId":"...","revisionId":"..."}'
gws drive revisions list --params '{"fileId":"..."}'
```

Docs:

```bash
gws docs documents get --params '{"documentId":"..."}'
```

Sheets:

```bash
gws sheets spreadsheets get --params '{"spreadsheetId":"..."}'
gws sheets spreadsheets values get --params '{"spreadsheetId":"...","range":"Sheet1!A1:D20"}'
gws sheets spreadsheets values batchGet --params '{"spreadsheetId":"...","ranges":["Sheet1!A1:D20"]}'
gws sheets spreadsheets getByDataFilter --json '{"dataFilters":[{"a1Range":"Sheet1!A1:D20"}]}'
gws sheets +read --help

```

## Constraints

- The supported surface is read-only. Mutating commands and unlisted services/resources return a policy denial.
- `gws auth`, uploads, dry-runs, sanitization, and file output flags are not supported here.
- `--page-all` is allowed only with the default page cap or `--page-limit` up to 10.
- Use `--format json` only if you need to set a format explicitly.

## Gotchas

- Gmail visibility depends on what the configured Google identity can actually read.
- Drive searches are often easier with `files list` plus a narrow `q` query, then `files get` on the selected ID.
- If the user needs to change Workspace data, tell them this integration is read-only.
