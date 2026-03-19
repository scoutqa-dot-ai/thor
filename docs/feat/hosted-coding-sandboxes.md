# Hosted Coding Sandboxes

> Give Thor a safe hosted sandbox feature for parallel coding sessions, isolated execution, and PR-oriented development work.

## Problem

Thor's current coding model relies on a shared runtime plus local worktrees. That is enough for basic coding tasks, but it does not provide a strong execution boundary between concurrent agent sessions.

As Thor takes on more coding work, the current model creates several product-level problems:

- concurrent coding sessions can interfere with each other through shared runtime state
- long-running coding work is hard to preserve cleanly across follow-up events
- test servers, browser automation, and background processes need a stronger isolation boundary
- secret-handling expectations are higher for autonomous coding than for read-only investigation
- branch / PR continuity should map to an isolated working environment, not just a resumed chat session

Thor needs a first-class sandboxing feature that turns a coding task into a dedicated remote execution environment.

## Feature Goal

Thor can create and manage a hosted coding sandbox for a task so that one isolated agent session works on one branch / PR by default, runs code and tests safely, preserves useful working state across follow-up events, and returns code changes and artifacts back into Thor's normal review flow.

## Principles

- **Isolation first** — each coding sandbox is independent from other Thor sessions
- **One sandbox, one coding thread** — the default unit of work is one sandbox per branch / PR, with the option for multiple sandboxes per task when parallel execution is beneficial
- **Secrets stay outside when possible** — hosted sandboxes should not become long-lived secret stores
- **Thor remains the orchestrator** — the sandbox is an execution environment, not a replacement for Thor's control plane
- **PR-oriented workflow** — the feature should support normal branch, review, and follow-up cycles
- **Provider-flexible** — Thor should be able to evaluate and adopt a hosted provider without changing the product contract, mediated by a provider-agnostic sandbox interface
- **Execution-only sandboxes** — sandboxes are tool-free execution environments; MCP tools and broker access remain in Thor's control plane
- **Graceful degradation** — Thor can fall back to local execution when hosted sandbox providers are unavailable

## In Scope

- hosted remote sandboxes for coding tasks
- isolated execution for code edits, tests, servers, and browser-driven validation
- lifecycle states that let Thor create, reuse, pause, resume, and destroy sandbox environments
- mapping sandbox identity to Thor sessions, branches, and PRs
- source movement into and out of sandboxes
- secure access from sandboxes to Thor-managed broker services
- artifacts produced by sandbox runs, such as logs, screenshots, reports, and code changes
- live preview URLs exposed by sandboxes for reviewable running applications
- real-time telemetry streaming from sandbox execution back to Thor's control plane
- multiple sandboxes per task when parallel execution is beneficial (e.g. coding + testing simultaneously)
- provider-agnostic sandbox interface that decouples Thor from any single provider

## Out of Scope

- self-hosted sandbox infrastructure as the default recommendation
- replacing Thor's gateway, runner, or MCP proxy architecture
- final implementation details for any single provider
- generalized human IDE or workstation streaming
- multi-user collaborative sandboxes

## Primary Use Cases

### 1. Parallel bug-fix sessions

Thor works on multiple unrelated engineering tasks at the same time, each in its own isolated sandbox.

### 2. PR follow-up work

Thor resumes a prior coding environment when new review comments, CI failures, or deployment results arrive for the same branch / PR.

### 3. Test and regression execution

Thor runs targeted tests, local servers, and regression checks inside a sandbox without affecting other coding work.

### 4. Browser and GUI-assisted validation

Thor uses a sandbox to run previewable applications, browser automation, or visual validation as part of coding work.

### 5. High-trust code handling with low-trust execution

Thor can let a coding agent operate on source code in a sandbox while keeping external secrets and privileged brokers outside the sandbox boundary.

## User Experience Outcomes

When the feature is working well:

- a coding task feels like it has its own isolated workspace
- Thor can continue work on the same branch / PR without rebuilding context from scratch every time
- code execution, local servers, and browser automation happen in the sandbox rather than in Thor's shared runtime
- follow-up events from GitHub or Slack land back on the correct coding environment
- output from the sandbox can be reviewed and promoted through normal GitHub workflows

## Functional Requirements

### Sandbox identity

- Thor can associate a sandbox with a repo, branch, PR, and Thor session
- Thor can tell whether an event should create a new sandbox or attach to an existing one
- sandbox identity remains stable across follow-up events until cleanup
- sandbox creation must be idempotent — concurrent requests for the same identity key resolve to a single sandbox
- the identity model supports multiple sandboxes per branch / PR when different sessions require parallel execution

### Isolated execution

- each sandbox has its own writable filesystem and process space
- background tasks, local servers, and browser runs in one sandbox do not affect another sandbox
- the sandbox can host coding-agent execution as a long-lived task when needed

### Lifecycle

- Thor can create, start, stop, resume, and destroy hosted sandboxes
- Thor can preserve useful working state between active and inactive periods
- Thor can apply lifecycle policies so idle sandboxes do not live forever

### Source handling

- Thor can place the correct source state into a sandbox at the start of work
- Thor can retrieve code changes and supporting artifacts from a sandbox after work
- the feature supports both clean branch work and work that begins from local uncommitted state

### Secure broker access

- sandboxes are execution-only environments — MCP tools and broker access remain in Thor's control plane
- the product contract assumes external services remain outside the sandbox boundary
- the feature should support short-lived sandbox identity instead of permanent credentials whenever possible

### Coding workflow support

- sandboxes can run code, package installs, tests, and local servers
- sandboxes can support browser-based or preview-based validation where needed
- sandboxes can produce logs, reports, and artifacts that Thor can reference later

### Live preview

- sandboxes can expose HTTP preview URLs for running applications
- preview URLs can be included in PR comments and Slack messages for human review
- preview URLs should require authentication or short expiry to prevent unauthorized access

### Real-time telemetry

- sandboxes can stream structured execution data (test results, build logs, metrics) back to Thor in real time
- Thor can react to telemetry mid-execution — abort failing suites, report progress, adjust approach
- telemetry streaming should be resilient to disconnection and support reconnection

### Provider abstraction

- Thor interacts with sandboxes through a provider-agnostic interface (SandboxProvider)
- the interface covers the full lifecycle: create, start, stop, resume, destroy, exec, stream, preview
- a local provider implementation wraps the existing OpenCode container as a degraded-mode fallback
- the hosted provider implementation is the default for production use

## Non-Functional Requirements

### Security

- sandbox compromise should have limited blast radius
- sandbox-to-service access should be scoped to the sandbox identity
- the feature should minimize long-lived credential presence inside the sandbox

### Reliability

- Thor can detect sandbox state and recover from common interruption cases
- the feature should support both event-driven continuation and explicit reattachment

### Performance

- cold start (new sandbox, no cache): < 120 seconds
- warm resume (paused sandbox): < 15 seconds
- source sync (medium repo, ~500 MB): < 60 seconds
- command execution overhead: < 2 seconds per command
- preview URL availability: < 30 seconds after application start
- the feature should support warm or prebuilt environments to reduce repeated setup time

### Observability

- Thor can inspect sandbox logs, status, and outcomes
- Thor can distinguish provider errors from coding-task errors

## Success Criteria

The feature is successful when:

- Thor can run parallel coding sessions without shared-runtime interference
- one branch / PR can map cleanly to one isolated coding environment by default
- follow-up events can resume the correct coding environment with minimal friction
- the sandbox can support tests, local servers, and browser validation as part of normal coding work
- secret-bearing broker services can remain outside the sandbox boundary
- code changes and artifacts can flow back into Thor's normal GitHub workflow

## Failure Modes

Expected failure modes and their recovery behavior. Implementation must handle each of these explicitly.

### Sandbox creation

| Failure | Recovery |
| --- | --- |
| Provider API timeout | Retry once with backoff, then fall back to local execution |
| Provider quota exceeded | Queue the request, retry with backoff, alert if sustained |
| Invalid sandbox configuration | Fail fast with descriptive error, do not retry |
| Provider outage (sustained) | Fall back to local OpenCode execution for the duration |

### Source sync

| Failure | Recovery |
| --- | --- |
| Authentication failure (bad PAT) | Fail with clear auth error, do not create sandbox |
| Repository not found | Fail with descriptive error, do not create sandbox |
| Clone timeout (large repo) | Retry once, then fail and report estimated repo size |
| Branch does not exist | Clone succeeds but checkout fails — fail with branch-not-found error |

### Sandbox resume

| Failure | Recovery |
| --- | --- |
| Sandbox was garbage-collected | Detect 404, create a new sandbox for the same identity |
| Sandbox state corrupted | Destroy and recreate, log the corruption event |
| Provider lost the snapshot | Same as garbage-collected — create new |

### Command execution

| Failure | Recovery |
| --- | --- |
| Process timeout | Kill the process, report timeout with last output |
| OOM kill inside sandbox | Detect exit code 137, report memory limit exceeded |
| Sandbox crashes mid-execution | Detect connection loss, attempt to retrieve partial results, report crash |

### Telemetry streaming

| Failure | Recovery |
| --- | --- |
| Stream disconnects | Reconnect with backoff, accept gap in telemetry |
| Backpressure (too much data) | Drop oldest unprocessed events, log the gap |
| Malformed stream data | Skip malformed events, log parse errors |

### Preview URLs

| Failure | Recovery |
| --- | --- |
| Port not exposed correctly | Report setup error with port discovery details |
| Sandbox stopped but URL cached | Detect dead link on access, remove from PR comment or mark stale |
| Provider rate limits previews | Report rate limit, suggest retrying later |

### Sandbox destruction

| Failure | Recovery |
| --- | --- |
| Destroy API fails | Retry with backoff, alert on sustained failure (zombie sandbox risk) |
| Work not extracted before destroy | Block destruction until code extraction confirms success |

### Multi-sandbox coordination

| Failure | Recovery |
| --- | --- |
| Duplicate sandbox creation (race condition) | Idempotent creation — resolve to single sandbox per identity key |
| Two sandboxes modify same files | Detect conflict at extraction time, report to Thor for resolution |
| Coordination timeout between sandboxes | Time out the waiting sandbox, continue with available results |

### Cost control

| Failure | Recovery |
| --- | --- |
| Sandbox costs exceed budget threshold | Alert, then auto-pause idle sandboxes starting with oldest |
| Zombie sandbox accruing cost | Periodic sweep detects sandboxes with no activity, destroys after grace period |

## Open Questions

- what level of state preservation is truly required for Thor's day-to-day coding work?
- which provider offers the best balance of isolation, lifecycle, and integration fit?
