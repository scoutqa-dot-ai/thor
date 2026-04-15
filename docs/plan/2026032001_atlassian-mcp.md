# Plan: Atlassian MCP Integration

**Date**: 2026-03-20
**Goal**: Add Atlassian MCP (Jira, Confluence, JSM) to Thor via the existing proxy, same pattern as PostHog.

## Context

Atlassian provides a hosted MCP server at `https://mcp.atlassian.com/v1/mcp` with Streamable HTTP transport. Auth is via Basic auth using a **scoped API token** (not a legacy token). This is identical to the PostHog pattern — no new container or custom server needed.

## Phases

### Phase 1 — Proxy config + docker-compose wiring ✅

- Create `proxy.jira.json` with upstream URL, Basic auth, and tool policy
- Add port 3014 to proxy service in docker-compose.yml
- Add `ATLASSIAN_BASIC_AUTH` env var to proxy service
- Add `jira` MCP entry to `docker/opencode/opencode.json`
- Update proxy healthcheck to include port 3014
- Update Dockerfile EXPOSE for proxy target
- Add `ATLASSIAN_BASIC_AUTH` to `.env.example`

### Phase 2 — Verify connectivity + tune tool list ✅

- Legacy API token (ATATT prefix, no scopes): returns only 2 Teamwork Graph tools, blocks with "requires modern API token with scopes"
- **Scoped API token**: returns all 37 tools (Jira, Confluence, JSM, Teamwork Graph, search, fetch)
- `getVisibleJiraProjects` returns 98 projects from `acme.atlassian.net`
- Auth: `Basic base64(email:scoped_token)`
- Tool list split into allow (26 read-only) and approve (11 write operations)

## Tool Access Policy

### Allowed (read-only, no approval needed) — 26 tools

| Tool                               | Purpose                             |
| ---------------------------------- | ----------------------------------- |
| `atlassianUserInfo`                | Current user info                   |
| `getAccessibleAtlassianResources`  | List accessible cloud sites         |
| `getJiraIssue`                     | Read issue details                  |
| `searchJiraIssuesUsingJql`         | Search issues via JQL               |
| `getVisibleJiraProjects`           | List accessible projects            |
| `getJiraProjectIssueTypesMetadata` | Issue type metadata                 |
| `getJiraIssueTypeMetaWithFields`   | Field metadata for creation         |
| `getTransitionsForJiraIssue`       | Available status transitions        |
| `getJiraIssueRemoteIssueLinks`     | External links on issues            |
| `getIssueLinkTypes`                | Link type definitions               |
| `lookupJiraAccountId`              | Resolve user account IDs            |
| `getTeamworkGraphContext`          | Linked PRs, builds, deployments     |
| `getTeamworkGraphObject`           | Hydrate objects from Teamwork Graph |
| `getConfluencePage`                | Read a Confluence page              |
| `searchConfluenceUsingCql`         | Search Confluence via CQL           |
| `getConfluenceSpaces`              | List Confluence spaces              |
| `getPagesInConfluenceSpace`        | List pages in a space               |
| `getConfluencePageFooterComments`  | Read footer comments                |
| `getConfluencePageInlineComments`  | Read inline comments                |
| `getConfluenceCommentChildren`     | Read comment replies                |
| `getConfluencePageDescendants`     | Read page tree                      |
| `getJsmOpsAlerts`                  | JSM OpsGenie alerts                 |
| `getJsmOpsScheduleInfo`            | JSM on-call schedules               |
| `getJsmOpsTeamInfo`                | JSM team info                       |
| `search`                           | Cross-product search                |
| `fetch`                            | Fetch Atlassian resource by URL     |

### Approved (write operations, require human approval) — 11 tools

| Tool                            | Purpose                |
| ------------------------------- | ---------------------- |
| `editJiraIssue`                 | Update issue fields    |
| `createJiraIssue`               | Create new issues      |
| `addCommentToJiraIssue`         | Add comments           |
| `transitionJiraIssue`           | Change issue status    |
| `addWorklogToJiraIssue`         | Log work time          |
| `createIssueLink`               | Link issues together   |
| `createConfluencePage`          | Create new pages       |
| `updateConfluencePage`          | Edit existing pages    |
| `createConfluenceFooterComment` | Add footer comments    |
| `createConfluenceInlineComment` | Add inline comments    |
| `updateJsmOpsAlert`             | Update OpsGenie alerts |

## Decision Log

| #   | Decision                                            | Rationale                                                                   |
| --- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Use Atlassian hosted MCP (`mcp.atlassian.com`)      | Zero maintenance, same pattern as PostHog, official Streamable HTTP support |
| 2   | Scoped API token with Basic auth                    | Legacy tokens only get 2 tools; scoped tokens unlock all 37 tools           |
| 3   | Jira + Confluence + JSM in one proxy                | Single upstream exposes all products; no need for separate instances        |
| 4   | 26 allow / 11 approve split                         | Read tools auto-forwarded; write tools require human approval for safety    |
| 5   | Port 3014 for proxy instance                        | Next available port after 3013 (grafana)                                    |
| 6   | `ATLASSIAN_BASIC_AUTH` env var (pre-encoded base64) | Avoids runtime base64 encoding; `echo -n "email:token" \| base64` in setup  |

## Out of Scope

- Jira webhook triggers (would need gateway changes — separate plan)
- Custom Jira workflows or automation rules
