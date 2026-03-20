# Hosted Coding Sandboxes

> Give Thor a safe hosted sandbox feature for isolated coding work, durable follow-up handling, and PR-oriented execution.

## Problem

Thor's current coding model relies on a shared runtime plus local worktrees. That is enough for small edits and investigation, but it is not a strong execution boundary for concurrent coding work.

As Thor takes on more coding tasks, the current model creates product problems:

- concurrent coding sessions can interfere with each other through shared runtime state
- long-running work is hard to continue cleanly across follow-up events
- test servers, browser automation, and background processes need stronger isolation
- autonomous coding raises higher expectations around credential handling and blast radius
- branch and PR continuity should attach to an isolated environment, not only to a resumed chat session

Thor needs a first-class hosted sandbox feature that turns a coding task into an isolated remote execution environment.

## Feature Goal

Thor can attach a hosted sandbox to a worktree so coding work runs in isolation, useful state can be reused across follow-up events, and code changes plus artifacts flow back into Thor's normal review workflow.

## Principles

- **Isolation first** - each coding sandbox is independent from other Thor sessions
- **One sandbox per worktree in v1** - the default unit of work is one active sandbox per worktree
- **Control plane owns identity and policy** - Thor remains the source of truth for sandbox lookup, credentials, policy, and auditability
- **Worktree identity must survive restarts** - sandbox lookup cannot live only in transient process memory
- **Git-native when possible** - Thor should preserve branch and PR semantics instead of treating source as an opaque file tree
- **Secrets stay outside when possible** - sandboxes should not become long-lived secret stores
- **Network access is explicit** - bootstrap access and steady-state access are separate concerns
- **Provider-flexible** - the product contract should not depend on one provider or one file-transfer mechanism
- **Graceful degradation** - Thor can fall back to local execution when hosted sandboxes are unavailable

## V1 Model

V1 is intentionally narrow:

- one active sandbox per worktree
- the worktree is the user-facing unit of work
- Thor keeps the authoritative worktree-to-sandbox mapping
- Thor may recreate a sandbox from the latest known workspace state if the original sandbox disappears
- coordinated multi-sandbox workflows are deferred

## In Scope

- hosted remote sandboxes for coding tasks
- isolated execution for code edits, tests, local servers, and browser-driven validation
- sandbox lifecycle management: create, attach, stop, resume or restore, destroy
- mapping sandboxes to worktrees, sessions, branches, and PRs
- workspace materialization into and out of sandboxes
- short-lived credential brokering and sandbox network policy
- authenticated or expiring preview URLs for running applications
- logs, screenshots, reports, preview metadata, and code changes produced by sandbox runs
- real-time execution telemetry back to Thor's control plane
- provider abstraction that decouples Thor from any single vendor

## Out of Scope

- self-hosted sandbox infrastructure as the default recommendation
- replacing Thor's gateway, runner, or MCP proxy architecture
- multi-user collaborative IDE sessions
- coordinated multi-sandbox workflows in v1
- provider-specific implementation details such as one mandated sync protocol

## Primary Use Cases

### 1. Parallel coding sessions

Thor works on unrelated engineering tasks at the same time, each in its own isolated sandbox.

### 2. PR follow-up work

Thor resumes the sandbox attached to a worktree when review comments, CI failures, or deployment results arrive for the same branch or PR.

### 3. Test and regression execution

Thor runs targeted tests, local servers, and regression checks inside a sandbox without affecting other coding work.

### 4. Browser and GUI-assisted validation

Thor uses a sandbox to run previewable applications, browser automation, or visual validation as part of coding work.

### 5. High-trust code handling with lower-trust execution

Thor can operate on source code in a sandbox while keeping privileged brokers and long-lived secrets outside the sandbox boundary.

## User Experience Outcomes

When the feature is working well:

- a coding task feels like it has its own isolated workspace
- one worktree maps cleanly to one sandbox by default
- follow-up events land back on the correct sandbox with minimal manual recovery
- code execution, local servers, and browser validation happen in the sandbox rather than in Thor's shared runtime
- changes and artifacts come back into Thor's normal git and review flow

## Functional Requirements

### Worktree identity

- Thor can associate a sandbox with a repo, worktree, branch or PR, and Thor session
- Thor can determine whether an event should create a new sandbox or attach to an existing one
- sandbox creation is idempotent for a given worktree identity
- sandbox lookup survives service restarts while the worktree still exists
- v1 supports one active sandbox per worktree

### Lifecycle

- Thor can create, attach to, stop, resume or restore, and destroy sandboxes
- idle sandboxes auto-stop after a configurable interval to control cost
- Thor can preserve useful working state through reuse, pause/resume, or snapshot/restore depending on provider support
- Thor can reconcile provider state after restarts and recreate a sandbox from the latest materialized workspace state if the original sandbox is gone
- Thor can apply cleanup policies so idle sandboxes do not live forever

### Workspace materialization

- Thor can materialize repo state into a sandbox from a clean branch or PR context
- the feature supports work that begins from local uncommitted state
- Thor should preserve git semantics where practical, using clone/fetch, bundle plus patch, or provider-native strategies
- Thor can export code changes and artifacts back as synchronized files, a patch, or another provider-supported representation
- the materialization strategy must support additions, edits, deletions, and conflict reporting

### Execution

- each sandbox has its own writable filesystem, process space, and network boundary
- background tasks, local servers, and browser runs in one sandbox do not affect another sandbox
- Thor can run commands in the sandbox and may optionally attach a delegated coding agent
- sandboxes can run package installs, tests, local servers, and browser-based validation

### Security and access

- Thor remains the broker for MCP tools and privileged integrations
- sandboxes receive only the short-lived credentials needed for repo access, bootstrap, or preview publication
- the feature supports tightening or disabling egress after bootstrap when the provider allows it
- preview URLs require authentication, short expiry, or both
- long-lived refresh tokens should not be stored in sandboxes unless there is no viable alternative

### Observability and artifacts

- sandboxes stream lifecycle events, logs, test results, and preview metadata back to Thor in real time
- telemetry supports reconnection after transient disconnects
- Thor can distinguish provider failures from coding-task failures
- Thor can collect logs, screenshots, reports, and similar artifacts for later review

### Provider abstraction

- Thor interacts with sandboxes through a provider-agnostic interface
- the interface covers lifecycle, lookup, execution, workspace materialization, preview lookup, and event streaming
- provider selection is an implementation decision documented in a plan, not in this feature spec

## Non-Functional Requirements

### Security

- sandbox compromise should have limited blast radius
- sandbox-to-service access should be scoped to the sandbox identity
- the feature should minimize long-lived credential presence inside the sandbox
- the feature should support outbound network restriction after bootstrap when the provider allows it

### Reliability

- Thor can detect sandbox state and recover from common interruption cases
- sandbox lookup and recovery survive process restarts
- the feature supports both event-driven continuation and explicit reattachment

### Performance

- cold start (new sandbox, no cache): < 120 seconds
- warm attach or resume: < 30 seconds
- workspace materialization (medium repo, about 500 MB): < 60 seconds
- command execution overhead: < 2 seconds per command
- preview URL availability: < 30 seconds after application start

### Observability

- Thor can inspect sandbox logs, status, and outcomes
- Thor can distinguish provider errors from task errors

## Success Criteria

The feature is successful when:

- Thor can run parallel coding sessions without shared-runtime interference
- one worktree maps cleanly to one isolated coding environment by default
- follow-up events can resume the correct environment with minimal friction
- the sandbox can support tests, local servers, and browser validation as part of normal coding work
- privileged broker access remains outside the sandbox boundary
- code changes and artifacts flow back into Thor's normal GitHub workflow

## Failure Modes

Implementation must explicitly handle the following classes of failure.

### Sandbox provisioning

| Failure                   | Recovery                                                   |
| ------------------------- | ---------------------------------------------------------- |
| Provider API timeout      | Retry once with backoff, then fall back to local execution |
| Provider quota exceeded   | Queue the request, retry with backoff, alert if sustained  |
| Invalid sandbox config    | Fail fast with a descriptive error, do not retry           |
| Sustained provider outage | Fall back to local execution for the duration              |

### Workspace materialization

| Failure                            | Recovery                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------ |
| Bootstrap credential failure       | Fail with clear auth error, do not create or reuse the sandbox           |
| Repo materialization timeout       | Retry once, then fail with repo size or transfer context                 |
| Bundle or patch apply failure      | Fail with a descriptive workspace-state error and keep sandbox for debug |
| Export conflicts with worktree     | Report conflict and require Thor to reconcile before overwrite           |
| Provider file transfer interrupted | Retry once if safe, otherwise fail with enough context for recovery      |

### Sandbox recovery

| Failure                       | Recovery                                               |
| ----------------------------- | ------------------------------------------------------ |
| Sandbox was garbage-collected | Detect 404, create a new sandbox for the same worktree |
| Sandbox state corrupted       | Destroy and recreate from latest materialized state    |
| Provider lost the snapshot    | Recreate from the latest known state                   |

### Command execution

| Failure                 | Recovery                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| Process timeout         | Kill the process, report timeout with last output                        |
| OOM kill inside sandbox | Detect exit code 137, report memory limit exceeded                       |
| Sandbox crash mid-run   | Detect connection loss, attempt to recover partial results, report crash |

### Telemetry and preview

| Failure                         | Recovery                                                  |
| ------------------------------- | --------------------------------------------------------- |
| Stream disconnect               | Reconnect with backoff and accept a gap in telemetry      |
| Backpressure on event stream    | Drop oldest unprocessed events and log the gap            |
| Preview port not exposed        | Report setup error with port discovery details            |
| Preview auth misconfigured      | Withhold the URL and report the auth failure              |
| Cached preview for dead sandbox | Mark the URL stale and remove it from later notifications |

### Destruction and cost control

| Failure                          | Recovery                                                      |
| -------------------------------- | ------------------------------------------------------------- |
| Destroy API fails                | Retry with backoff, alert on sustained failure                |
| Work not exported before destroy | Block destruction until extraction confirms success           |
| Sandbox exceeds budget threshold | Alert, then auto-stop idle sandboxes starting with the oldest |
| Zombie sandbox accrues cost      | Sweep periodically and destroy after a grace period           |

## Open Questions

- should v1 support only direct remote execution, or also a delegated coding agent in the sandbox?
- should private repo bootstrap use short-lived clone credentials, `git bundle` upload, or both?
- which provider best satisfies Thor's worktree identity, network policy, and continuity requirements in a real spike?
