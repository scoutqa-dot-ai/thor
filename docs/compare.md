# Thor vs. Other Coding Agent Platforms

Comparison of Thor against five open-source / public-architecture coding agents:
OpenHands, open-swe, background-agents, junior, goose. Per-tool deep dives live
in [`docs/compare/`](./compare/).

## 1. Thor in one paragraph

Thor is an **event-driven, single-tenant, internal-team AI teammate**. A
`gateway` ingests Slack mentions, GitHub webhooks, and cron events; a `runner`
manages OpenCode session continuity and streams progress back to Slack; the
OpenCode agent reaches the outside world through `remote-cli`, which is the
**MCP / CLI policy gateway** (allow / approve / hide). Outbound HTTPS goes
through `mitmproxy` for credential injection. Everything runs as one Docker
Compose stack behind `ingress` + `vouch` for SSO. The whole product is
deliberately small — one shared workspace, one OpenCode runtime, one runner,
no per-user sandbox fleet.

## 2. The other five at a glance

| Tool              | Origin                | Shape                                          | Sandbox                                                  | Trigger surface                              | Distinct trait                                                 |
| ----------------- | --------------------- | ---------------------------------------------- | -------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| OpenHands         | All Hands AI          | Full IDE-style platform + Enterprise SaaS      | Docker / Remote / Local runtime                          | Web GUI, CLI, GitHub/GitLab/Bitbucket, Slack | Most "product-y" — workspaces, RBAC, billing, browser tool     |
| open-swe          | LangChain             | LangGraph + Deep Agents framework              | Pluggable: LangSmith / Daytona / Modal / Runloop         | Slack, Linear, GitHub, webhook              | Composable framework; separate reviewer subgraph; AGENTS.md     |
| background-agents | Open-Inspect (Ramp-style) | Cloudflare control plane + Modal/Daytona data plane | Modal snapshots (fast restore) or Daytona persistent | Web, Slack, GitHub, Linear, webhook, cron   | Async-first multiplayer; per-session Durable Object SQLite      |
| junior            | Sentry                | Slack-native turn-based agent harness (Pi)     | Vercel Sandbox                                            | Slack (DM, @mention, threads, app-home)      | Thinking-level routing; resumable durable turns; OAuth pause/resume |
| goose             | Block → AAIF / Linux Foundation | Rust-native general-purpose agent          | Local process; optional container                        | Desktop GUI, CLI, HTTP API (goosed)          | MCP-first; 15+ LLM providers; recipes; runs on the user's machine |

## 3. Where Thor sits in the design space

Two axes matter most:

```
              hosted / cloud-managed
                      ▲
   background-agents  │   OpenHands Cloud
   open-swe (Cloud)   │
                      │
  ───── self-hosted ──┼──────────────────► hosted ──
                      │
   Thor               │
   OpenHands OSS      │
   open-swe (self)    │   junior (Sentry-internal Vercel)
   goose              │
                      ▼
              local / single-machine
```

- **Thor, OpenHands OSS, goose, open-swe (self-host)** all live in the
  self-hosted quadrant.
- **background-agents** is the only one explicitly built around "fire async,
  come back later, multiplayer reconnect."
- **junior, open-swe, background-agents, OpenHands** all assume **a fleet of
  ephemeral sandboxes per session**. Thor is the only one that uses **one
  shared OpenCode runtime + worktrees** for session isolation.

## 4. Feature matrix

Legend: ✅ first-class · 🟡 partial / lightweight · ❌ not present

| Capability                                  | Thor | OpenHands | open-swe | bg-agents | junior | goose |
| ------------------------------------------- | :--: | :-------: | :------: | :-------: | :----: | :---: |
| Slack ingress                               | ✅   | 🟡        | ✅       | ✅        | ✅     | ❌    |
| GitHub webhook ingress                      | ✅   | ✅        | ✅       | ✅        | 🟡     | ❌    |
| Linear / Jira ingress                       | 🟡 (Jira via MCP) | 🟡 | ✅ (Linear) | ✅ (Linear) | 🟡 (via plugins) | ❌ |
| Cron / scheduled prompts                    | ✅   | ❌        | ❌       | ✅        | ❌     | 🟡 (recipes) |
| Web UI for sessions                         | ❌   | ✅        | ✅       | ✅        | ❌     | ✅ (desktop) |
| CLI / IDE                                   | ❌   | ✅        | 🟡       | ❌        | ❌     | ✅    |
| MCP tool support                            | ✅   | ✅        | ✅       | 🟡        | ✅     | ✅ (core) |
| **MCP policy gateway** (allow/approve/hide) | ✅   | ❌        | ❌       | ❌        | 🟡 (allowlists) | ❌ |
| Human approval workflow                     | ✅   | 🟡        | 🟡 (PR review) | 🟡 | 🟡 (OAuth pause) | ❌ |
| Per-session sandbox                         | ❌   | ✅        | ✅       | ✅        | ✅     | 🟡    |
| Worktree-based edits in shared workspace    | ✅   | ❌        | ❌       | ❌        | ❌     | ❌    |
| Session continuity / resume                 | ✅   | ✅        | ✅       | ✅ (Durable Objects) | ✅ (turn-resume) | ✅ |
| Multi-user multiplayer in one session       | ❌   | 🟡        | ❌       | ✅        | ❌     | ❌    |
| Multi-LLM provider                          | 🟡 (via OpenCode) | ✅ | ✅ | ✅ | ✅ | ✅ (15+) |
| Outbound HTTPS credential injection         | ✅ (mitmproxy) | ❌ | ❌ | ❌ | ✅ (egress proxy) | ❌ |
| Audit log of tool calls                     | ✅   | 🟡        | 🟡 (LangSmith) | 🟡 | ✅ | 🟡 |
| Plugin / extension ecosystem                | 🟡 (MCP upstreams) | ✅ | ✅ | 🟡 | ✅ (plugins) | ✅ (70+ extensions) |
| Browser / web-use tool                      | 🟡 (via MCP) | ✅ | 🟡 | ✅ | ✅ | ✅ |
| Multi-agent / subagent spawning             | ❌   | 🟡        | ✅ (`task` tool, reviewer subgraph) | ✅ (sub-tasks) | ❌ | 🟡 |
| Snapshot / fast cold-start                  | n/a  | ❌        | 🟡       | ✅ (Modal) | ❌    | n/a   |

## 5. Per-tool comparison

### 5.1 OpenHands

**Where OpenHands is doing better than Thor**

1. **Web GUI.** Full conversation list, chat, settings, RBAC, OAuth. Thor has
   nothing of the sort — everything happens in Slack threads. If Thor users
   ever need to browse history, replay a session, or grant scoped access to
   non-engineers, OpenHands' surface is the proven shape.
2. **First-class CLI.** OpenHands ships a headless CLI mode. Thor only exposes
   `remote-cli` HTTP, which is service-to-service.
3. **Per-conversation sandboxing.** Docker-per-session means cross-task blast
   radius is contained. Thor has one shared OpenCode workspace; an agent
   misbehavior touches everyone's worktrees.
4. **Enterprise plumbing.** SQLAlchemy async, RBAC, workspace management,
   pluggable file storage. Thor punts all of this.

**Where Thor is doing better than OpenHands**

1. **Server-side MCP policy.** Allow / approve / hide on tools is a Thor
   invariant in `remote-cli`. OpenHands' MCP router is a pass-through.
2. **Slack-native triggers + cron.** OpenHands' Slack is a webhook plugin;
   Thor's whole event model assumes Slack is the primary surface.
3. **Outbound credential injection via mitmproxy.** Lets agents call any HTTP
   API without ever holding the secret. OpenHands gives the agent the API key.
4. **Operational simplicity.** One Docker Compose file. OpenHands stack is
   substantial (FastAPI + Redux SPA + Postgres + sandbox controller).

**Should we adopt anything?**

- ✅ **A minimal session/replay UI.** Even a read-only NDJSON viewer keyed on
  Slack thread ID would close the biggest UX gap.
- ✅ **Per-conversation worktree isolation.** Already partially there — make
  the worktree-per-thread invariant explicit and enforced in `runner`.
- ❌ Don't adopt their full SaaS shape. Not the product Thor is.

### 5.2 open-swe

**Where open-swe is doing better than Thor**

1. **Reviewer subgraph.** A separate LangGraph reviewer that critiques the
   agent's findings before posting. Thor has no equivalent — the OpenCode
   session writes directly.
2. **Subagent spawning via a `task` tool.** Lets the agent fan out work
   (read this file / search this repo / draft this comment) into bounded
   subtasks. Thor's agent is monolithic.
3. **AGENTS.md injection convention.** open-swe systematically injects
   `AGENTS.md` from the target repo. Thor's `AGENTS.md` is for human
   contributors; the agent doesn't read it.
4. **Thread-deterministic routing.** A stable `thread_id` derived from
   (repo, issue, channel) means re-entry "just works." Thor has its own
   correlation-key batching but the rules are less explicit.
5. **Pluggable sandbox backends.** LangSmith / Daytona / Modal / Runloop
   behind one interface. Thor is OpenCode-only.
6. **Built-in LangSmith tracing.** Per-turn traces, replays, eval datasets.

**Where Thor is doing better than open-swe**

1. **MCP policy gateway.** open-swe binds tools at agent construction; there's
   no allow/approve/hide enforcement boundary.
2. **mitmproxy credential injection.** open-swe gives agents real tokens.
3. **Cron triggers.** open-swe is webhook-driven only.
4. **Simpler stack.** open-swe presumes LangGraph + LangSmith + FastAPI +
   React dashboard + sandbox provider account. Thor is one host.

**Should we adopt anything?**

- ✅ **Reviewer pattern.** A second pass that critiques the draft before the
  agent posts to Slack would catch a lot of the "Thor said something weird"
  failure mode. Cheap to bolt on as a final OpenCode prompt.
- ✅ **Read `AGENTS.md` from the target repo into the system prompt.** Already
  a community convention; Thor should respect it.
- ✅ **Make `thread_id` derivation explicit and documented.** Move the
  correlation-key rules out of `runner` internals into the protocol doc.
- 🟡 **Subagent spawning.** Tempting, but OpenCode already supports it
  natively — expose it as an allowed tool rather than building a new layer.

### 5.3 background-agents

**Where background-agents is doing better than Thor**

1. **Async multiplayer.** Multiple Slack users in the same thread, plus the
   web client, watching the same stream. Cloudflare Durable Objects own the
   session state. Thor streams to one Slack thread only.
2. **Snapshot / fast restart.** Modal snapshots restore a hot sandbox in
   seconds. Thor has no cold-start because the workspace is always warm —
   but it's the same workspace for everyone.
3. **Automation engine.** JSONPath-conditioned webhook automations with
   idempotency keys. Thor has cron + raw webhooks; no condition layer.
4. **Commit attribution per prompt.** Each prompt's effect is a separate
   commit on the same branch, attributed to the requesting user. Thor's
   worktree commits aren't attributed.
5. **Multi-provider LLM, per-session reasoning-effort knob.** Thor inherits
   whatever OpenCode is configured with.

**Where Thor is doing better than background-agents**

1. **MCP policy.** Same story — bg-agents lets the agent talk to whatever
   tools are bound.
2. **Single-host self-host.** bg-agents requires Cloudflare + Modal **and**
   Daytona accounts and Terraform IaC. Thor is `docker compose up`.
3. **Cron-native.** bg-agents has scheduled automations but cron-as-a-trigger
   is a Thor first-class feature.
4. **Cost / footprint.** Cloudflare Workers + Durable Objects + Modal
   sandboxes is real money at idle. Thor is one VM.

**Should we adopt anything?**

- ✅ **Per-prompt commit attribution.** Easy win: tag each worktree commit
  with the requesting Slack user. Useful for audit and PR review.
- ✅ **Webhook automations with conditions.** A small condition DSL (or
  even just allow-list of `event.type` + `path` regex) layered on the
  gateway would let users wire "PR labeled X → run prompt Y" without code.
- 🟡 **Multiplayer streams.** Slack already broadcasts to the thread, so
  the value is lower for Thor. Skip unless we add a web UI.
- ❌ **Sandbox snapshots.** Thor's shared-workspace model makes this moot.

### 5.4 junior

**Where junior is doing better than Thor**

1. **Thinking-level routing.** A small classifier model picks none/low/med/high
   reasoning per turn, hitting a faster/cheaper model on simple turns. Thor
   uses whatever OpenCode picks every turn.
2. **Resumable durable turns.** A turn that hits a 720s ceiling checkpoints
   and resumes from Redis. Thor restarts the OpenCode session, losing partial
   work mid-tool-call.
3. **OAuth pause/resume.** When a tool needs auth, the bot DMs a link, pauses
   the turn, and resumes after the OAuth callback. Thor's approval flow is
   close but covers a different need (per-tool-call gating, not initial auth).
4. **Plugin model.** Skills + capabilities + credentials bundled per plugin
   (Sentry, GitHub, Linear, Notion, Datadog, Hex, browser). Thor's upstream
   registry is a flat config; there's no notion of a "plugin."
5. **Spec-driven contracts.** `specs/*.md` are canonical and read-first.
   Thor has `docs/feat/` but the discipline is looser.
6. **Sandbox egress proxy with short-lived host-authenticated tokens.** Same
   spirit as Thor's mitmproxy but with explicit per-host scoping.

**Where Thor is doing better than junior**

1. **MCP policy as a service.** junior's allowlists are per-plugin config;
   Thor's `remote-cli` enforces the boundary centrally and uniformly.
2. **Cron triggers.** junior is request-driven only.
3. **GitHub webhook ingress.** First-class in Thor, less so in junior.
4. **Self-host friendliness.** junior is tightly coupled to Vercel Functions
   + Redis + nitro. Thor runs anywhere Docker runs.

**Should we adopt anything?**

- ✅ **Thinking-level routing.** Hugely worth investigating — most Thor turns
  are "ack this Slack message" or "summarize this PR" and don't need the
  full model. Even routing 30% of turns to a smaller model is a real win.
- ✅ **Resumable turns.** Today, if the OpenCode session dies mid-tool-call
  the user sees nothing. A small "turn checkpoint" in `runner` keyed on
  `(thread_id, turn_n)` would let us resume.
- ✅ **Plugin bundling.** Today, adding a new upstream means editing
  `proxies.ts`, mitmproxy config, MCP policy, and possibly Slack permissions.
  A "Thor plugin" abstraction that bundles all four would scale better.
- 🟡 **OAuth pause/resume.** Useful, but mitmproxy already handles most cases
  by holding tokens server-side. Revisit if we add per-user OAuth flows.

### 5.5 goose

**Where goose is doing better than Thor**

1. **15+ LLM providers** behind one provider trait. Thor inherits OpenCode's
   provider list and can't swap mid-session.
2. **70+ MCP extensions** as a community ecosystem. Thor's MCP upstreams are
   a manually curated list.
3. **Context-window optimization.** Token budgeting and pruning are
   first-class. Thor relies on OpenCode defaults.
4. **Recipes (YAML/JSON).** Reusable workflow definitions you can share and
   version. Thor has no equivalent — every cron prompt is duplicated.
5. **Rust performance.** Negligible at Thor's scale, but goose is materially
   faster per turn.
6. **Local-first / privacy.** Runs entirely on the user's machine if desired.
   Thor is server-side by design.

**Where Thor is doing better than goose**

1. **Slack/GitHub/cron ingress.** goose is desktop+CLI+API; it doesn't
   listen for events. Thor is event-driven by design.
2. **MCP policy enforcement.** goose trusts the user; tools are whatever
   the user installed. Thor enforces server-side policy.
3. **Approval workflow.** goose has none.
4. **Audit logs.** goose has session history; Thor has audited tool calls.
5. **Multi-user.** goose is single-user-per-process by design.

**Should we adopt anything?**

- ✅ **Recipes.** A small "Thor recipe" format (YAML: prompt + allowed tools
  + cron schedule + Slack target) would let non-engineers add scheduled
  prompts without code changes. This is probably the single highest-leverage
  idea in this whole document.
- 🟡 **Context-window optimization knobs.** Worth surfacing OpenCode's
  existing controls; not worth re-implementing.
- ❌ Don't adopt the multi-provider abstraction; OpenCode already owns this.

## 6. Cross-cutting takeaways

### Patterns Thor uniquely has and should keep

1. **Server-side MCP policy boundary in `remote-cli`.** None of the five
   competitors enforce allow/approve/hide outside the agent. This is the
   single best architectural decision in Thor.
2. **mitmproxy outbound credential injection.** Lets the agent talk to any
   HTTP API without ever holding the secret. Only junior has a comparable
   pattern, and theirs is per-plugin rather than universal.
3. **Single-Docker-Compose deployment.** Real operational advantage vs.
   open-swe (LangGraph Cloud), bg-agents (Cloudflare + Modal + Terraform),
   junior (Vercel + Redis), OpenHands Cloud (full SaaS).

### Common patterns Thor is missing

These appear in 3+ competitors and Thor should likely adopt at least the
simpler ones:

1. **Per-session sandbox isolation** (OpenHands, open-swe, bg-agents, junior).
   At minimum, enforce one worktree per thread and document the invariant.
2. **A reviewer / second-pass critique** (open-swe explicitly; OpenHands and
   junior via prompt patterns).
3. **Per-prompt / per-user commit attribution** (bg-agents).
4. **Thinking-level / model-tier routing** (junior; bg-agents partially).
5. **A web UI for session replay** (OpenHands, open-swe, bg-agents) — even
   read-only.
6. **Recipes / reusable prompt templates** (goose).

### Things Thor should explicitly *not* adopt

- **Multi-tenant / RBAC machinery.** Thor is single-tenant by design.
  Adopting OpenHands' enterprise plumbing would 5× the codebase for zero
  product gain.
- **A custom agent loop.** Stay on OpenCode. open-swe (LangGraph) and
  background-agents (their own) both pay ongoing complexity tax that we
  don't need.
- **Sandbox-per-session snapshots.** Thor's shared-workspace model removes
  the cold-start problem entirely; don't bring it back.

## 7. Recommended next moves, in priority order

1. **Recipes** (goose-style YAML) for cron prompts. High leverage, low cost.
2. **Reviewer second pass** (open-swe-style) before posting to Slack.
3. **Thinking-level routing** (junior-style) to cut LLM cost.
4. **Per-prompt commit attribution** (bg-agents-style) in `runner` worktree
   commits.
5. **AGENTS.md injection** from the target repo into the agent's system
   prompt.
6. **Minimal read-only session replay UI** (OpenHands-style) for non-Slack
   users and post-hoc audit.
7. **Plugin bundling abstraction** (junior-style) once we have ≥10 upstreams.

Items 1–4 are each a few days of work and don't touch the architectural
invariants. Items 5–7 are larger and worth their own plan docs in
`docs/plan/`.
