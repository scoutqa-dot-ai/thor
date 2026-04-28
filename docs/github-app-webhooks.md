# GitHub App Webhooks Operator Runbook

This runbook covers the minimum setup for GitHub App webhook intake in Thor (`POST /github/webhook`) and common failure modes seen in gateway logs.

## 1) Environment variables

Set these in `.env` (or your deployment secret store):

| Variable                      | Required | Used by                 | What it is                                           | Where to find it in GitHub UI                                                                                 |
| ----------------------------- | -------- | ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`               | Yes      | `remote-cli`            | Numeric GitHub App ID (JWT `iss`)                    | GitHub App settings page (`App ID`)                                                                           |
| `GITHUB_APP_SLUG`             | Yes      | `remote-cli`, `gateway` | App slug; used for bot identity + mention detection  | GitHub App settings page (`App slug`)                                                                         |
| `GITHUB_APP_BOT_ID`           | Yes      | `remote-cli`, `gateway` | Numeric bot user ID — commit email + self-loop guard | Run `gh api /users/<slug>[bot] --jq .id` or open `https://api.github.com/users/<slug>%5Bbot%5D` and read `id` |
| `GITHUB_APP_PRIVATE_KEY_FILE` | Yes      | `remote-cli`            | Filesystem path to App private key PEM               | GitHub App settings (`Private keys`)                                                                          |
| `GITHUB_WEBHOOK_SECRET`       | Yes      | `gateway`               | HMAC secret used to verify `X-Hub-Signature-256`     | GitHub App webhook settings (`Secret`)                                                                        |

Notes:

- Gateway requires `GITHUB_APP_SLUG`, `GITHUB_APP_BOT_ID`, `GITHUB_WEBHOOK_SECRET`.
- Remote-cli requires `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_BOT_ID`, `GITHUB_APP_PRIVATE_KEY_FILE`.
- Example bot-id lookup for slug `thor`: `gh api /users/thor[bot] --jq .id`

## 2) Workspace config: installation IDs

Thor resolves installation IDs from `owners.<name>.github_app_installation_id` in `/workspace/config.json`:

```json
{
  "owners": {
    "scoutqa-dot-ai": {
      "github_app_installation_id": 126669985
    }
  }
}
```

How to find installation ID:

1. Open the owner's installation settings page.
2. Read the ID from the URL:
   `https://github.com/organizations/<owner>/settings/installations/<id>`
3. Copy `<id>` into `owners.<owner>.github_app_installation_id`.

## 3) Required app permissions

Thor's GitHub App is used for both webhook intake and agent-driven GitHub actions (`git push`, `gh pr create`, issue/PR comments). Configure permissions accordingly:

| Permission    | Access       |
| ------------- | ------------ |
| Issues        | Read & write |
| Pull requests | Read & write |
| Contents      | Read & write |
| Checks        | Read-only    |
| Metadata      | Read-only    |

## 4) Required event subscriptions

Subscribe to:

- Issue comment
- Pull request review
- Pull request review comment
- Check suite

`check_suite.completed` wakes Thor when CI reaches a terminal result for an existing Thor-authored branch session. GitHub reports check suites per commit per checks app, so repos with multiple CI providers may produce more than one terminal suite.

## 4a) Bot commit identity and CI wake gate

Thor derives the Git author identity from the existing GitHub App variables:

- `user.name = ${GITHUB_APP_SLUG}[bot]`
- `user.email = ${GITHUB_APP_BOT_ID}+${GITHUB_APP_SLUG}[bot]@users.noreply.github.com`

There is no separate author-email environment variable. Remote-cli uses the derived identity for commits, and gateway derives the same email when checking `check_suite.head_sha` before waking Thor. A CI wake is accepted only when the branch maps to an existing notes-backed session, the commit exists in the local repo, and `git log -1 --format=%ae <head_sha>` matches the derived bot email.

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

| Reason                           | What it means                                                                                  | How to fix                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `signature_invalid`              | HMAC verification failed or signature header missing                                           | Verify `GITHUB_WEBHOOK_SECRET`; ensure JSON payload is unmodified in transit       |
| `event_unsupported`              | Event/action is outside Thor allowlist                                                         | Ensure subscription list is correct and action is expected (`created`/`submitted`) |
| `repo_not_mapped`                | Repo basename has no matching local clone                                                      | Clone under `/workspace/repos/<basename>`; keep basename aligned                   |
| `pure_issue_comment_unsupported` | `issue_comment` came from an issue, not a PR                                                   | Comment on a PR thread                                                             |
| `fork_pr_unsupported`            | PR head repo differs from base repo                                                            | Use same-repo branch PRs                                                           |
| `self_sender`                    | Sender's numeric user ID matches `GITHUB_APP_BOT_ID`                                           | Self-loop guard — expected when Thor comments/reviews                              |
| `empty_review_body`              | Submitted review body was blank                                                                | Include text in the review body                                                    |
| `non_mention_comment`            | Comment/review does not mention the app, and (for review events) the PR was not opened by Thor | Mention `@${GITHUB_APP_SLUG}` to act, or open the PR from Thor                     |
| `check_suite_branch_missing`     | GitHub did not include `check_suite.head_branch`                                               | Expected for fork/detached/tag cases; no action unless same-repo PRs are affected  |
| `correlation_key_unresolved`     | `check_suite.head_branch` has no existing Thor notes-backed branch session                     | Confirm Thor previously worked that branch; otherwise the CI event is ignored      |
| `check_suite_gate_failed`        | The git SHA/authorship gate failed before queueing a CI wake                                   | See `metadata.gateReason` in `github-webhook-ignored` worklog                      |

`check_suite_gate_failed` includes `metadata.gateReason`:

- `sha_missing`: local repo does not know `check_suite.head_sha`; fetch/update the clone, then redeliver if appropriate.
- `author_mismatch`: commit author email is not the derived GitHub App bot email; expected for human-authored commits.
- `exec_failed`: gateway could not complete the internal git check through remote-cli; check remote-cli health and `THOR_INTERNAL_SECRET`.

### Dead-letter reasons (`github_trigger_dropped`)

Queue-handler-side terminal rejections happen after the event passed intake. These show up as `github_trigger_dropped` with a `reason` field:

| Reason                 | What it means                                                              | How to fix                                                                      |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `installation_gone`    | Remote-cli returned 401/403 minting an installation token                  | Reinstall the GitHub App on the affected owner; verify private key + app ID env |
| `branch_not_found`     | Remote-cli `/github/pr-head` returned 404 (PR/branch missing on GitHub)    | Confirm the PR still exists; replay the delivery if it was a transient race     |
| `branch_lookup_failed` | `/github/pr-head` 5xx, timeout, or network error after retries (transport) | Check remote-cli health and connectivity; replay the delivery once recovered    |
| `fork_pr_unsupported`  | PR head repo differs from base repo (caught after branch resolve)          | Use same-repo branch PRs                                                        |

`branch_not_found` is permanent (the branch is gone, replay won't help). `branch_lookup_failed` is operationally transient — the failure was infra, the underlying PR may still be valid; redeliver after fixing the transport.

## 10) Trust boundary for `remote-cli`

The `remote-cli` service owns the GitHub App private key and mints installation tokens on demand (`/github/pr-head` for the webhook branch-resolution path; the `git` / `gh` wrappers for agent commands). Its endpoints have no per-request auth header — they rely on the docker network being the trust boundary:

- The host port mapping is `127.0.0.1:3004:3004`, so it is not reachable from outside the host.
- Inside the docker network, every compose service listed in the `depends_on` graph can call it directly.

Operators adding new services to the compose network must treat them as equally trusted with gateway and runner. Gateway↔remote-cli internal routes are additionally protected by `THOR_INTERNAL_SECRET` / `x-thor-internal-secret`, including approval resolution, PR head lookup, and internal exec. Treat that secret as authorizing policy-bypass internal operations, not just approvals.
