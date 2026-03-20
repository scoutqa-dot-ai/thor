# Plan — 2026032003_hosted-coding-sandboxes-v1

> Deliver hosted coding sandboxes for Thor with one sandbox per worktree in v1.

## Decision Log

| #   | Decision                                                                              | Rationale                                                                                  |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| D1  | Use one active sandbox per worktree in v1                                             | This matches the desired UX and keeps identity, locking, and recovery simple.              |
| D2  | Keep the feature doc provider-neutral                                                 | Product behavior should remain stable even if provider choice changes.                     |
| D3  | Choose a provider by thin spike, not by doc-only scoring                              | Real create/attach/materialize/exec behavior matters more than scorecards.                 |
| D4  | Resolve worktree-to-sandbox mapping from provider data on demand                      | A local mirror is optional in v1 if provider lookup by worktree metadata is reliable.      |
| D5  | Treat workspace materialization as an abstraction                                     | Thor should not commit to one sync protocol such as `rsync` in advance.                    |
| D6  | Ship the execution plane before any nested coding agent                               | Sandbox lifecycle, materialization, and security must work on their own first.             |
| D7  | Make short-lived credentials and post-bootstrap egress controls baseline requirements | "Safe hosted sandbox" is primarily a blast-radius problem.                                 |
| D8  | Keep local execution as the fallback path                                             | Thor still needs a degraded mode when provider APIs fail or quotas are exhausted.          |
| D9  | Run the Phase 2 spike as a standalone harness with official provider SDKs             | The spike should validate real provider behavior without prematurely shaping app code.     |
| D10 | Materialize worktrees for the spike by direct archive upload                          | Upload-based materialization lets the spike lock down sandbox egress from the start.       |
| D11 | Treat live egress enforcement as a provider gate, not a doc-level assumption          | The live E2B spike passed lifecycle and preview auth but did not enforce egress lock.      |
| D12 | Put the first Daytona control-plane flow in `@thor/common` before runner wiring       | The app should integrate against one tested `ensure` or `destroy` flow, not raw SDK calls. |

## Problem

Thor needs isolated execution for coding work, but the current shared runtime model does not provide:

- reliable isolation between concurrent coding sessions
- durable attachment of follow-up events to the correct environment
- a safe place to run tests, servers, and browser automation
- a clean security boundary for autonomous execution

The implementation plan for this feature should therefore start with sandbox identity, lifecycle, materialization, and security, not with a provider-specific transport or a nested coding workflow.

## Phase 1 — Sandbox Contract and State Model

**Goal**: Define the control-plane contract Thor must own before provider code is written.

Steps:

1. Define the worktree-scoped sandbox identity model.
2. Define the worktree metadata and lifecycle state model the provider must expose.
3. Define the provider interface for:
   - lookup
   - create
   - attach
   - stop or resume or restore
   - destroy
   - exec and event streaming
   - workspace materialization and export
   - preview lookup
4. Define the failure contract between Thor and the provider layer.
5. Define the fallback path to local execution.

**Exit criteria**:

- one sandbox per worktree is the explicit v1 rule
- worktree-to-sandbox lookup works after service restart via provider data
- provider responsibilities are separated from Thor responsibilities
- no provider-specific sync protocol is embedded in the contract
- failure states are explicit enough to implement retries and fallback

## Phase 2 — Provider Spike

**Goal**: Validate the hardest requirements against real provider behavior with the thinnest possible implementation.

Spike candidates:

- Daytona
- E2B
- optionally Vercel Sandbox if network controls become the deciding factor

Steps:

1. Create a sandbox with metadata that can be mapped back to a worktree.
2. Reattach to that sandbox from a fresh process.
3. Materialize repo state into the sandbox.
4. Run commands and stream stdout and stderr back.
5. Expose one authenticated or expiring preview URL.
6. Restrict outbound network access after bootstrap.
7. Stop, resume, or restore the sandbox and record exactly what state survives.

**Exit criteria**:

- Thor can prove create -> attach -> exec -> reattach for Daytona and one challenger
- preview auth behavior is demonstrated from real runs
- post-bootstrap network controls are demonstrated from real runs
- the surviving state model is documented: filesystem only, memory plus processes, or snapshot recreation
- a default provider is chosen for implementation

## Phase 3 — Hosted Sandbox V1

**Goal**: Ship the hosted execution plane with one sandbox per worktree.

Steps:

1. Implement worktree lookup against the chosen provider.
2. Implement one provider adapter behind the shared interface.
3. Implement workspace materialization and export for the chosen provider.
4. Implement command execution and event streaming.
5. Implement cleanup, idle timeout, and fallback-to-local behavior.
6. Integrate sandbox attach and destroy behavior with Thor's worktree lifecycle.

**Exit criteria**:

- Thor can create or reattach the correct sandbox for a worktree
- Thor can run tests and local servers in the sandbox without shared-runtime interference
- code changes and artifacts come back into the normal local git flow
- provider failures are distinguishable from task failures
- idle sandboxes are cleaned up automatically

## Phase 4 — Delegated Coding and Richer Validation

**Goal**: Add higher-level sandbox workflows only after the base execution plane is stable.

Steps:

1. Decide whether Thor should support a delegated coding agent inside the sandbox.
2. If so, keep delegated-agent continuity separate from sandbox continuity.
3. Add browser-heavy validation and richer artifact capture.
4. Add preview URLs to downstream review surfaces where useful.

**Exit criteria**:

- delegated coding is optional and not required for basic sandbox lifecycle
- richer validation builds on the same worktree-scoped sandbox lookup model
- preview and artifact handling reuse the base provider interface

## Out of Scope

- multiple coordinated sandboxes per worktree in v1
- self-hosted sandbox infrastructure as the default recommendation
- multi-user collaborative IDE sessions
- locking Thor into one sync protocol or one provider-specific lifecycle
- implementing provider selection through static scorecards alone
