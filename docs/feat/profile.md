# MCP profiles

MCP profiles are explicit endpoint-bundle selectors passed on the `mcp` command line.

## Contract

- Thor workspace config no longer has a `profiles` block.
- A profile is requested only with `mcp --profile NAME <upstream> ...` or `mcp --profile=NAME <upstream> ...`.
- Thor does not infer MCP profiles from Slack channel, repo, current working directory, or session aliases.
- Profile names are passed through directly into env-suffix lookup, such as `_QA`; Thor does not validate the name up front.
- `mcp <upstream>` with no `--profile` uses only the unsuffixed global env bundle.
- When `--profile NAME` is requested, env resolution is exact: Thor uses only `*_NAME` variables and does not fall back to unsuffixed globals.
- Session ids are still required for MCP audit logging and approval-thread behavior, but they do not choose the profile.
- Tool allow/approve/hidden policy stays global per upstream; profiles only select credentials/endpoints.

## Environment examples

Single-value upstreams use the exact suffixed variable when a profile is requested:

```bash
ATLASSIAN_AUTH_QA="Basic ..." mcp --profile QA atlassian getJiraIssue '{"issueKey":"QA-1"}'
POSTHOG_API_KEY_QA="phc_..." mcp --profile=QA posthog query-run '{...}'
```

Bundle upstreams require the full suffixed bundle for explicit profiles:

```bash
GRAFANA_URL_QA="https://grafana.qa.example"
GRAFANA_SERVICE_ACCOUNT_TOKEN_QA="..."
GRAFANA_ORG_ID_QA="1"

LANGFUSE_BASE_URL_QA="https://cloud.langfuse.com"
LANGFUSE_PUBLIC_KEY_QA="pk_..."
LANGFUSE_SECRET_KEY_QA="sk_..."
```

If any member of a requested profile bundle is present but another is missing, Thor fails hard with the missing variable names. If none of the suffixed variables for that upstream are present, that upstream is unavailable for the requested profile.

## Approvals

When an approve-class tool is called with `mcp --profile NAME`, the pending approval action stores `NAME`. Approval resolution validates the stored session id for audit/thread continuity, then uses the stored profile rather than re-resolving from Slack or repo context.
