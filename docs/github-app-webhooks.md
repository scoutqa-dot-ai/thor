# GitHub App Webhooks Operator Runbook

This runbook covers the minimum setup for GitHub App webhook intake in Thor (`POST /github/webhook`) and common failure modes seen in gateway logs.

## 1) Environment variables

Set these in `.env` (or your deployment secret store):

| Variable                      | Required | Used by                 | What it is                                          | Where to find it in GitHub UI                                                                                 |
| ----------------------------- | -------- | ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`               | Yes      | `remote-cli`            | Numeric GitHub App ID (JWT `iss`)                   | GitHub App settings page (`App ID`)                                                                           |
| `GITHUB_APP_SLUG`             | Yes      | `remote-cli`, `gateway` | App slug; used for bot identity + mention detection | GitHub App settings page (`App slug`)                                                                         |
| `GITHUB_APP_BOT_ID`           | Yes      | `remote-cli`            | Numeric bot user ID for commit email derivation     | Run `gh api /users/<slug>[bot] --jq .id` or open `https://api.github.com/users/<slug>%5Bbot%5D` and read `id` |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Yes      | `remote-cli`            | Filesystem path to App private key PEM              | GitHub App settings (`Private keys`)                                                                          |
| `GITHUB_WEBHOOK_SECRET`       | Yes      | `gateway`               | HMAC secret used to verify `X-Hub-Signature-256`    | GitHub App webhook settings (`Secret`)                                                                        |

Notes:

- Gateway requires only `GITHUB_APP_SLUG` + `GITHUB_WEBHOOK_SECRET`.
- Remote-cli requires `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_BOT_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`.
- Example bot-id lookup for slug `thor`: `gh api /users/thor[bot] --jq .id`

## 2) Workspace config: installation IDs

Thor resolves installation IDs from `orgs.<name>.github_app_installation_id` in `/workspace/config.json`:

```json
{
  "orgs": {
    "scoutqa-dot-ai": {
      "github_app_installation_id": 126669985
    }
  }
}
```

How to find installation ID:

1. Open your org's installation settings page.
2. Read the ID from the URL:
   `https://github.com/organizations/<org>/settings/installations/<id>`
3. Copy `<id>` into `orgs.<org>.github_app_installation_id`.

## 3) Required app permissions

Thor's GitHub App is used for both webhook intake and agent-driven GitHub actions (`git push`, `gh pr create`, issue/PR comments). Configure permissions accordingly:

| Permission    | Access       |
| ------------- | ------------ |
| Issues        | Read & write |
| Pull requests | Read & write |
| Contents      | Read & write |
| Metadata      | Read-only    |

## 4) Required event subscriptions

Subscribe to:

- Issue comment
- Pull request review
- Pull request review comment

## 5) Webhook URL and payload format

- URL: `https://<gateway-host>/github/webhook`
- Content type: **`application/json` only**

`application/x-www-form-urlencoded` delivery is not supported.

## 6) Basename must match local repo directory

Routing is basename-based:

- GitHub payload repo: `owner/thor`
- Expected local clone: `/workspace/repos/thor`

If the basename does not exist locally, gateway drops the event with `reason: "repo_not_mapped"`.

Notes:

- Routing currently uses the repo basename as delivered; Thor does not normalize mixed-case repo names during webhook intake.
- We do not expect that to matter anytime soon for current repos because local clone names are already lowercase and aligned with the webhook payloads we use today.
- If mixed-case repo naming becomes an operational problem later, we can add normalization then.

## 7) Secret rotation

1. Generate a new high-entropy secret.
2. Update the GitHub App webhook secret.
3. Update Thor deployment `GITHUB_WEBHOOK_SECRET` immediately after.
4. Trigger a test delivery from GitHub App settings.
5. Confirm acceptance (`github_event_accepted`) and no `signature_invalid` logs.

Use a short maintenance window so old signed retries do not overlap for long.

## 8) Local dev with smee.io

1. Create a channel at `https://smee.io`.
2. Set GitHub App webhook URL to the smee channel URL.
3. Run forwarder:

```bash
npx smee-client --url https://smee.io/<channel-id> --path /github/webhook --port 3002
```

4. Run gateway locally on `3002` with required GitHub env vars.
5. Send a test delivery and verify gateway logs.

## 9) Troubleshooting (`github_event_ignored`)

| Reason                           | What it means                                        | How to fix                                                                         |
| -------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `signature_invalid`              | HMAC verification failed or signature header missing | Verify `GITHUB_WEBHOOK_SECRET`; ensure JSON payload is unmodified in transit       |
| `event_unsupported`              | Event/action is outside Thor allowlist               | Ensure subscription list is correct and action is expected (`created`/`submitted`) |
| `repo_not_mapped`                | Repo basename has no matching local clone            | Clone under `/workspace/repos/<basename>`; keep basename aligned                   |
| `pure_issue_comment_unsupported` | `issue_comment` came from an issue, not a PR         | Comment on a PR thread                                                             |
| `fork_pr_unsupported`            | PR head repo differs from base repo                  | Use same-repo branch PRs                                                           |
| `bot_sender`                     | Sender is a bot (or Thor app identity)               | Trigger from a human account                                                       |
| `empty_review_body`              | Submitted review body was blank                      | Include text in the review body                                                    |

## 10) Trust boundary for `remote-cli`

The `remote-cli` service owns the GitHub App private key and mints installation tokens on demand (`/github/pr-head` for the webhook branch-resolution path; the `git` / `gh` wrappers for agent commands). Its endpoints have no per-request auth header — they rely on the docker network being the trust boundary:

- The host port mapping is `127.0.0.1:3004:3004`, so it is not reachable from outside the host.
- Inside the docker network, every compose service listed in the `depends_on` graph can call it directly.

Operators adding new services to the compose network must treat them as equally trusted with gateway and runner. If that ever becomes too permissive, introduce a shared-secret header (mirroring the `RESOLVE_SECRET` / `x-thor-resolve-secret` pattern already used for MCP approvals) before adding the service.
