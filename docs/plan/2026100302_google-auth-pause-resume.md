# Neo — Google credentials on demand and automatic continuation

## Goal and source of authority

The user confirms the current flow works, but rejects its UX: a Google link/request should lead to a reviewed operation, missing credentials should produce a private OAuth DM, and successful sign-in should automatically continue the task without per-command Google approval. This supersedes the per-command Google approval policy in the earlier Google OAuth and Neo completion plans. Other integration approval policies are unchanged.

Reference implementation inspected read-only: `getsentry/junior` at `11aedb80519d2759622a562196345cb1302eae84`. Its typed credential failures start an authorization pause, persist requester-bound turn state, and OAuth callback authorizes a worker continuation. It resumes an agent turn, not a blindly replayed shell command. Junior's private delivery is ephemeral-first; Neo requires DM-first. Keep Neo's existing encrypted storage, PKCE, same-browser proof and verified Google identity instead of copying Junior's weaker generic OAuth persistence.

## Phases and exit criteria

1. **Broker policy and durable auth handoff.** Allowed Google API commands execute immediately with the trusted active Slack requester's token; no command-approval card is generated. Parsing/credential isolation, optional Google pin and provider identity verification remain. Missing or definitively revoked credentials create a persisted, encrypted auth continuation bound to the invitation/requester/workspace/session/anchor/trigger and exact unexecuted Google argv. Confirm private DM delivery before exposing a usable wait; repeated attempts reuse the same current invitation instead of sending another DM. Callback stores a ready continuation, not a retry instruction. Internal-secret-only list/ack endpoints expose validated ready records for runner recovery. Historic approval/result handlers remain readable, but new Google calls cannot create approvals. Tests exercise real HTTP, DM failures, ownership, immediate reads/writes, typed credential failure, callback and durable ready/ack after service reconstruction. Commit once after validation.
2. **Runner wait and automatic task continuation.** Poll broker's durable ready outbox using existing internal URL/secret settings. Only the exact matching persisted Pi request (same requester, anchor and trigger) may resume. Defer busy conversations; abandon superseded/interrupted requests. Persist continuation admission before acknowledgement; deterministic request identity prevents duplicate admission across polls/restarts and callback races. Continue the agent with original history and exact blocked Google argv; never replay an entire compound shell command or uncertain/completed effect. Agent-facing instructions describe waiting and automatic continuation without approval/retry ceremonies. Tests prove actual embedded Pi→executor→wrapper→broker→OAuth→automatic resumed model operation and result, plus duplicates, busy ordering, different users/new turns, restart and delivery failure. Commit after validation.

## Decision log

| Decision                                                   | Reason                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google-specific approval removal                           | Explicit user policy change; not authorization to remove unrelated approvals. Account consent connects access once.                                               |
| Credential authority remains active Slack actor            | A Google URL, bystander, model argument or browser selector must never choose someone else's grant.                                                               |
| Typed broker state, not stderr matching                    | Command text/output can be untrusted; only the credential owner creates auth readiness.                                                                           |
| Encrypted durable broker outbox plus Pi admission receipts | Callback must survive busy runner, restart and callback-before-turn-finish; no fire-and-forget HTTP wake.                                                         |
| Agent continuation, not shell replay                       | Matches Junior and preserves multi-step task history without repeating earlier compound-command effects. Saved argv identifies only the blocked Google operation. |
| Keep current Google browser/account proofs                 | Removing routine command approval does not require weakening OAuth identity or leaking credentials.                                                               |
| Existing settings and deployment identity                  | No new application env surface, stack, project/volume names, encryption key or private mounted-data rewrite.                                                      |
| Local commits only                                         | Existing commit discipline prohibits push; local fixture acceptance is not live account/provider acceptance.                                                      |

## Safety and completion boundaries

- Continue only commands that did not execute because credentials were missing/revoked. Permissions errors, provider failures and uncertain effects are reported, not automatically retried as OAuth.
- A newer real user request supersedes the blocked request. OAuth may still connect that user's account, but cannot resurrect stale work under another actor's authority.
- At-most-once continuation admission is not exactly-once Google side effects. Do not claim power-loss or distributed exactly-once guarantees.
- Private invitation values, OAuth state/codes/cookies/tokens, command payloads and private output must not enter operational logs or public wait notices.
- No timeout/output transformations duplicating the harness; auth invitation/outbox expiry and broker polling are their own product lifecycle.
- Final checks: full tests/typechecks/builds, isolated Google/Pi container contracts, real Chromium chooser/consent/callback and safe private credential/mount boundaries. Report unperformed live/CI gates explicitly.

## Out of scope

Universal OAuth providers, generic runtime adapters, Junior dependencies, private deployment data, renaming technical namespaces, removing other integration approvals, arbitrary credentialed shell/URL execution, automatically retrying uncertain mutations or replaying compound shell commands.

## Phase 1 isolated verification

Implemented Google direct requester-owned execution, typed missing/revoked credential handling, confirmed-DM-only encrypted waits, matching invitation reuse, verified callback readiness, and secret-gated durable list/ack. Historic approval/result handlers remain accessible only for existing records; new commands do not create approvals. Callback-before-delivery is saved privately but cannot resume until delivery confirms. Original matching-turn dispatch retires readiness before any side effect, including uncertain outcomes.

Parent verification: **39 files / 533 remote-cli/common tests**, all workspace typechecks, real Chromium through shipped Nginx chooser/consent/callback, and rebuilt isolated GWS/Drata container contract pass. No live credentials/deployment data or push was used. Phase 2 runner integration and combined-suite approval-to-continuation coverage remain unfinished.
