---
name: launchdarkly
description: Inspect LaunchDarkly feature flags, environments, segments, and metrics through the read-only ldcli wrapper.
---

## When to use

Use this skill when:

- The user asks whether a feature flag is enabled in a given environment
- Investigating rollout state, segments, or related metrics during debugging
- Cross-referencing application behavior with LaunchDarkly configuration
- You need the current LaunchDarkly source of truth instead of guessing from code

---

## Overview

This skill provides **read-only access** to LaunchDarkly via CLI:

```bash
ldcli <resource> <action> [options]
```

Supported resources:

- `flags`
- `environments`
- `projects`
- `segments`
- `metrics`

Use resource help for command discovery:

```bash
ldcli flags --help
ldcli segments --help
```

Do not use `ldcli resources`; it is blocked by policy.

---

## Auth and output

- Authentication is server-side only
- Never pass `--access-token`
- `--output json` is auto-appended unless you already pass an explicit output flag
- Responses are machine-readable JSON; inspect fields directly instead of relying on plaintext formatting

---

## Core workflows

### 1. List flags in a project

```bash
ldcli flags list --project default --limit 50
```

---

### 2. Get a flag's full state

```bash
ldcli flags get my-flag --project default --environment production
```

Use this to inspect per-environment targeting and rollout state.

---

### 3. List environments in a project

```bash
ldcli environments list --project default
```

---

### 4. List segments for an environment

```bash
ldcli segments list --project default --environment production
```

---

### 5. List metrics in a project

```bash
ldcli metrics list --project default
```

---

## Execution strategy

1. Start with the narrowest resource and project possible.
2. Add `--environment` for flag or segment work when the question is environment-specific.
3. Prefer `get` only when you already know the exact flag key; otherwise start with `list`.
4. Summarize the relevant JSON fields instead of dumping large payloads.

---

## Constraints

- Strictly read-only: `toggle`, `update`, `create`, `delete`, and `replace` are denied
- Scoped API calls for `flags`, `environments`, `segments`, and `metrics` require `--project <key>`
- `metrics` supports `list` only
- `members`, `teams`, `config`, `resources`, `audit-log`, `experiments`, and other admin/discovery resources are blocked

---

## Gotchas

- Omitting `--project` on scoped resources returns a policy error from `remote-cli`, not a LaunchDarkly API error
- `ldcli flags get` exposes environment-specific state under `environments[<env-key>]`
- `ldcli flags --help` is allowed for discovery, but real resource queries still need explicit scope
- If the user needs to change LaunchDarkly state, tell them the current integration is read-only
