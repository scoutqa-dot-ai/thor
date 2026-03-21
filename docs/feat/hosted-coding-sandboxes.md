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

Thor can delegate coding on a worktree to one hosted `coder` command so the work runs in isolation, useful state can be reused across follow-up events, and code changes plus artifacts flow back into Thor's normal review workflow.

## Principles

- **Isolation first** - each coding sandbox is independent from other Thor sessions
- **One sandbox per worktree in v1** - the default unit of work is one active sandbox per worktree
- **One coder command for the main agent** - the main OpenCode agent should delegate isolated coding through one command, not through sandbox lifecycle primitives
- **Control plane owns identity and policy** - Thor remains the source of truth for sandbox lookup, credentials, policy, and auditability
- **Sandbox lifecycle stays internal** - create, attach, stop, resume, destroy, and provider choice are Thor implementation details, not agent-facing concepts
- **Worktree identity must survive restarts** - sandbox lookup cannot live only in transient process memory
- **Git-native when possible** - Thor should preserve branch and PR semantics instead of treating source as an opaque file tree
- **Secrets stay outside when possible** - sandboxes should not become long-lived secret stores
- **Network access is explicit** - bootstrap access and steady-state access are separate concerns
- **Provider-flexible** - the product contract should not depend on one provider or one file-transfer mechanism
- **Graceful degradation** - Thor can fall back to local execution when hosted sandboxes are unavailable

## V1 Model

V1 is intentionally narrow:

- one active sandbox per worktree
- the main agent uses one `coder` command as the user-facing interface
- low-level sandbox lifecycle is internal to Thor
- Thor resolves the authoritative worktree-to-sandbox mapping from provider data on demand
- Thor may recreate a sandbox from the latest known workspace state if the original sandbox disappears
- coordinated multi-sandbox workflows are deferred

## In Scope

- one hosted `coder` command for isolated coding tasks on a worktree
- internal sandbox lifecycle management behind that command
- a dedicated `sandboxd` service that owns hosted coder orchestration
- isolated execution for code edits, tests, local servers, and browser-driven validation
- mapping sandboxes and delegated coder sessions to worktrees, sessions, branches, and PRs
- workspace materialization into and out of sandboxes
- short-lived credential brokering and sandbox network policy
- authenticated or expiring preview URLs for running applications when the delegated coder starts them
- logs, screenshots, reports, preview metadata, and code changes produced by sandbox runs
- real-time execution telemetry back to Thor's control plane and back to the calling agent in summarized form
- provider abstraction that decouples Thor from any single vendor

## Out of Scope

- self-hosted sandbox infrastructure as the default recommendation
- replacing Thor's gateway, runner, or MCP proxy architecture
- exposing sandbox create, attach, stop, resume, destroy, or provider selection directly to the main agent
- raw `bash-in-sandbox` style execution as the primary agent-facing abstraction
- multi-user collaborative IDE sessions
- coordinated multi-sandbox workflows in v1
- provider-specific implementation details such as one mandated sync protocol

## Primary Use Cases

### 1. Parallel delegated coding sessions

Thor works on unrelated engineering tasks at the same time by delegating each worktree to its own isolated hosted coder.

### 2. PR follow-up work

Thor resumes the hosted coder attached to a worktree when review comments, CI failures, or deployment results arrive for the same branch or PR.

### 3. Isolated coding with integrated validation

Thor delegates a coding prompt to the hosted coder, which can edit code, run tests, start local servers, and perform regression checks without affecting other work.

### 4. Browser and GUI-assisted validation

Thor delegates coding tasks that require previewable applications, browser automation, or visual validation to the hosted coder.

### 5. High-trust orchestration with lower-trust execution

Thor can keep privileged brokers and long-lived secrets outside the sandbox boundary while still delegating deeper coding work to an isolated hosted coder.

## User Experience Outcomes

When the feature is working well:

- a coding task feels like it has its own isolated coding helper
- one worktree maps cleanly to one sandbox by default
- the main agent delegates isolated coding through one `coder` command instead of managing sandbox lifecycle
- follow-up events land back on the correct sandbox with minimal manual recovery
- code execution, local servers, and browser validation happen inside the hosted coder environment rather than in Thor's shared runtime
- changes and artifacts come back into Thor's normal git and review flow

## Functional Requirements

### Command surface

- the main agent gets one `coder` command for isolated coding on a worktree
- the command resolves the current worktree from `cwd`
- the command accepts a coding prompt via `--prompt` or stdin
- the command returns machine-readable progress and final results
- the command does not expose sandbox ids, provider names, or sandbox lifecycle commands
- the main agent does not choose between local and hosted execution primitives directly

### Worktree identity

- Thor can associate a sandbox and hosted coder execution with a repo, worktree, branch or PR, and Thor session
- Thor can determine whether a coding request should create a new sandbox or attach to an existing one
- sandbox creation is idempotent for a given worktree identity
- sandbox lookup survives service restarts while the worktree still exists
- v1 supports one active sandbox per worktree

### Lifecycle

- Thor can internally create, attach to, stop, resume or restore, and destroy sandboxes
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
- the hosted coder can run commands in the sandbox on Thor's behalf
- the hosted coder can run package installs, tests, local servers, and browser-based validation
- the main agent should delegate deeper isolated coding through the `coder` command instead of directly driving sandbox primitives

### Security and access

- Thor remains the broker for MCP tools and privileged integrations
- sandboxes receive only the short-lived credentials needed for repo access, bootstrap, or preview publication
- the feature supports tightening or disabling egress after bootstrap when the provider allows it
- preview URLs require authentication, short expiry, or both
- long-lived refresh tokens should not be stored in sandboxes unless there is no viable alternative

### Observability and artifacts

- sandboxes stream lifecycle events, logs, test results, and preview metadata back to Thor in real time
- Thor returns machine-readable progress and outcomes from the hosted coder back to the calling agent
- telemetry supports reconnection after transient disconnects
- Thor can distinguish provider failures from coding-task failures
- Thor can collect logs, screenshots, reports, and similar artifacts for later review

### Provider abstraction

- Thor interacts with sandboxes through a provider-agnostic internal interface
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

- Thor can run parallel delegated coding sessions without shared-runtime interference
- one worktree maps cleanly to one isolated coding environment by default
- the main agent can delegate isolated coding through one `coder` command without managing sandbox lifecycle
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

- how much progress, preview, and artifact detail should the hosted coder return directly to the calling agent?
- should private repo bootstrap use short-lived clone credentials, `git bundle` upload, or both?
- which provider best satisfies Thor's worktree identity, network policy, and continuity requirements in a real spike?
