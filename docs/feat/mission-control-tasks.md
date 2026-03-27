# Mission Control — Task Templates

Task templates for recurring and one-shot jobs. These replace the cron-based Slack triggers with visual, trackable tasks on the Mission Control board.

## Recurring Task Templates

Configure these in Mission Control's scheduler using natural language scheduling.

### Daily Standup Summary

**Schedule:** Every weekday at 9:00 AM UTC
**Priority:** Medium
**Title:** Daily standup summary
**Description:**

```
Generate a standup summary for the team:
1. Check GitHub for PRs opened, merged, and reviewed in the last 24 hours
2. Check Linear for issues moved to Done or In Progress
3. Check Slack #ai-platform for key decisions or blockers discussed
4. Post a concise summary to Slack #ai-platform
```

### Error Spike Monitor

**Schedule:** Every 6 hours
**Priority:** High
**Title:** Error spike check
**Description:**

```
Check PostHog for error spikes in the last 6 hours.
Compare error rates to the previous period.
If spikes detected, investigate the top 3 errors and post findings to Slack #ai-platform.
If no spikes, skip posting.
```

### Weekly Retrospective

**Schedule:** Every Friday at 16:00 UTC
**Priority:** Medium
**Title:** Weekly engineering retrospective
**Description:**

```
Generate a weekly retrospective:
1. Summarize all PRs merged this week across monitored repos
2. List Linear issues completed vs planned
3. Highlight any recurring patterns or blockers
4. Post to Slack #ai-platform
```

### Dependency Audit

**Schedule:** Every Monday at 7:00 UTC
**Priority:** Low
**Title:** Dependency audit
**Description:**

```
For each repo in /workspace/repos/:
1. Check for outdated dependencies (npm outdated / gh dependabot alerts)
2. Flag any critical security advisories
3. Post a summary to Slack #ai-platform only if action is needed
```

## One-Shot Task Examples

These are created manually on the Kanban board when needed.

### Investigate Production Issue

**Priority:** Urgent
**Title:** Investigate [error description]
**Description:**

```
A user reported [issue]. Investigate:
1. Check Grafana/Loki logs for the error pattern
2. Check PostHog for affected user sessions
3. Identify root cause
4. If a code fix is needed, create a PR in a worktree
5. Post findings to Slack #ai-platform thread [thread_ts]
```

### Code Review Assist

**Priority:** Medium
**Title:** Review PR #[number]
**Description:**

```
Review PR #[number] in [repo]:
1. Read the diff and understand the changes
2. Check for security issues, performance concerns, and code quality
3. Post a review comment on the PR with findings
```

### QA Smoke Test

**Priority:** Medium
**Title:** Smoke test [URL]
**Description:**

```
Run exploratory QA on [URL]:
1. Use scoutqa to test the main user flows
2. Check for accessibility issues
3. Verify responsive layout
4. Post results to Slack #ai-platform
```

## Task Metadata Convention

When creating tasks in Mission Control, use these metadata fields for Thor to route correctly:

| Field             | Purpose                | Example             |
| ----------------- | ---------------------- | ------------------- |
| `slack_channel`   | Where to post results  | `C09J7CHT0DS`       |
| `slack_thread_ts` | Thread to reply in     | `1711234567.123456` |
| `repo`            | Target repository      | `katalon-ai/scout`  |
| `pr_number`       | PR to act on           | `1234`              |
| `urgency`         | Override poll priority | `immediate`         |
