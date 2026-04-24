---
name: memory
description: Read and maintain Thor memory files (root, repo, people) with concise durable notes.
---

# Memory skill

Use this skill when you need to read or update Thor memory under `/workspace/memory`.

## Memory layers

1. **Root memory**: `/workspace/memory/README.md`
   - Global, cross-repo Thor context.
   - Examples: org-wide conventions, long-lived corrections, critical incidents.

2. **Repo memory**: `/workspace/memory/<repo>/README.md`
   - Repo-scoped context.
   - Examples: repo-specific gotchas, release notes that affect future work, recurring patterns.

3. **People memory**: `/workspace/memory/people/*.md`
   - Person-scoped context matched by identifiers in frontmatter.
   - Examples: stable preferences, ownership, communication style if useful for future interactions.

## What belongs where

- Put info where its scope is smallest while still reusable.
- Prefer repo docs for information humans should also read.
- Use memory for Thor-only context that improves future sessions.

## What not to store

- Ephemeral task state, temporary plans, one-off debug output.
- Sensitive secrets or credentials.
- Data already captured clearly in repo docs/worklog.

## Read/write workflow

1. Read only the memory layer(s) relevant to the task.
2. Keep updates short (few bullets, small paragraphs).
3. Prefer replacing stale notes instead of appending long history.
4. Preserve meaning; avoid noisy rewrites.

## People memory file format

Each people file is markdown with **top-of-file YAML frontmatter**:

```md
---
slack: U123
github: octocat
---

Prefers concise status updates and links to PRs.
Owns CI config and release automation.
```

Rules:

- Frontmatter must be at the top of the file.
- Use simple `key: value` pairs.
- Supported identifiers today: `slack`, `github`.
- Body is freeform markdown, kept concise.

## People filename conventions

- Preferred: `first-last.md` (lowercase, hyphenated).
- If collision exists, use a stable fallback such as:
  - `first-last-2.md`
  - `first-last-team.md`
- Do not encode secrets or transient data in filenames.

## Keep memory short and durable

- Capture stable facts that will still matter later.
- Remove or rewrite stale entries when context changes.
- Avoid timeline logs; use worklog for detailed session history.
