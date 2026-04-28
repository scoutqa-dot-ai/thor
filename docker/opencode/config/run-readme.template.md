Run-ID: <YYYYMMDD-HHMMSS>-<slug>[-<thread-ts>]
Repo: <repo-name>
Branch: <branch-name>
Worktree: /workspace/worktrees/<repo>/<branch>
Lifecycle: open
Verdict:

## Goal

One paragraph describing the task outcome, constraints, and any durable in-repo plan path when repo conventions require one.

## Artifacts

| Path | Description |
|---|---|

## Log

Append entries only. Format: `YYYY-MM-DD HH:MM <agent>: <one-line summary>`.

## Schema Notes

- Required top fields, in order: `Run-ID:`, `Repo:`, `Branch:`, `Worktree:`, `Lifecycle:`, `Verdict:`.
- `Lifecycle:` values: `open`, `merged`, `abandoned`.
- `Verdict:` values after review: `BLOCK`, `SUBSTANTIVE`, `NIT`, `MERGED`. It is empty before the first review.
- `BLOCK` means review found a defect that must be fixed.
- `SUBSTANTIVE` means review found non-trivial improvements and the coder should iterate.
- `NIT` means only nitpicks remain and the change can ship.
- `MERGED` means the PR landed and the run is terminal.
- Insert artifact rows into the table without rewriting existing rows.
- Append log entries; do not rewrite or reorder the Log section.
