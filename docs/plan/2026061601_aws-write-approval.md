# Human approval for write-alike `aws` commands

Gate mutating AWS CLI commands behind the existing Slack-button human-approval path, while keeping read-only commands on the immediate `/exec/aws` passthrough. Builds on the `aws` passthrough added earlier on this branch and reuses the generic CLI-approval framework introduced for `gh issue create` (`docs/plan/2026052501_gh-issue-create-approval.md`).

## Goal

`/exec/aws` should classify each command as read or write. Read-only commands continue to run immediately with the container's IAM credentials. Write-alike commands (`create-*`, `delete-*`, `put-*`, `run-*`, `s3 cp/mv/rm/sync`, and anything unrecognized) create a pending approval in the originating Slack thread, return an `approval_required` payload to the agent, and execute the exact reviewed command only after a human clicks Approve.

## Decisions

| #   | Decision                                                                                                          | Rationale                                                                                                                                                                                                    | Rejected                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1   | Classify read vs write by the **operation token** (2nd positional), fail-closed to "write"                        | AWS operation names are consistent dash-cased verbs; a small read-only verb allowlist (`describe`/`list`/`get`/`scan`/`query`/`head`/…) plus `s3 ls`/`presign` covers reads. Unknown ⇒ approval.             | Maintaining a per-service write allowlist (huge, drifts with every AWS API addition)         |
| 2   | Reuse the `CliApprovalDefinition` framework — add an `awsExec` definition, not a new approval API                 | The framework is explicitly CLI-agnostic; adding a CLI is one definition entry. Same Slack card, status command, gateway re-entry, and fail-closed-without-a-thread behavior as `gh issue create`.           | A bespoke aws approval path; a per-subcommand allowlist enforced inline in `validateAwsArgs` |
| 3   | Store + execute the command **verbatim** (no server-added args), with `AWS_PAGER=""`                              | Unlike `gh issue create`, aws has no footer/attribution to inject; the reviewed command is exactly what runs. The pager env mirrors the immediate path so v2 never blocks on captured output.                | Threading aws-specific env handling into the generic executor differently                    |
| 4   | Skip approval for `help` / `--version` and for a bare service with no operation                                   | These cannot mutate state; gating them is pure friction.                                                                                                                                                     | Gating everything that is not an exact read (would block `aws ec2 help`)                     |
| 5   | Render the approval-card command as a JSON argv array                                                             | AWS write commands often carry JSON, spaces, newlines, and shell metacharacters; an argv array is the only concise display that preserves what will execute without lossy shell reconstruction.              | A space-joined shell string or ad hoc shell quoting in Slack mrkdwn                          |
| 6   | Force approval for credential-looking AWS reads by keyword (`token`, `role`, `credential`, `secret`, `ssm`, etc.) | Some AWS `get-*` operations return temporary credentials, auth tokens, or secret values. A small keyword check keeps the defense-in-depth boundary simple, even if it over-gates harmless IAM/STS/SSM reads. | Maintaining a full per-service sensitive-read registry                                       |

## File-level impact

| Path                                           | Change                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/common/src/approval-events.ts`       | Add `AwsExecApprovalArgsSchema`, `awsExec` to the payload union, disclaimer-injection no-op case |
| `packages/common/src/approval-presentation.ts` | Add the `awsExec` Slack card (short title, directory bullet + code-fenced command)               |
| `packages/common/src/index.ts`                 | Export `AwsExecApprovalArgsSchema`                                                               |
| `packages/remote-cli/src/policy.ts`            | Add `awsCommandRequiresApproval` (positional parser + read-only verb allowlist, fail-closed)     |
| `packages/remote-cli/src/cli-approval.ts`      | Add `awsExec` definition; thread optional `CliCommand.env` through the executor                  |
| `packages/remote-cli/src/index.ts`             | Route write-alike `/exec/aws` through `requestCliApproval`; reads keep the immediate path        |
| `docs/feat/security-model.md`                  | Document the read/write split and approval gating                                                |
| tests                                          | `policy.test.ts` classification cases, `cli-approval.test.ts` aws definition, presentation test  |

## Exit criteria

- `awsCommandRequiresApproval` gates mutating verbs, unknown operations, and credential-looking reads, passes ordinary reads/help/version, and ignores global option values when locating the operation.
- Write-alike `/exec/aws` requests create a pending approval and never reach `execCommand` before approval; the approved command runs once, verbatim, with `AWS_PAGER=""`.
- Read-only `/exec/aws` requests are unchanged.
- `@thor/remote-cli` and `@thor/common` typecheck; targeted suites green.
