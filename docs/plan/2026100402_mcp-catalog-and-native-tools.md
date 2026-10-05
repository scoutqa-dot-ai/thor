# Neo — Configurable MCP catalog and native Durable tools

**Status:** MCP Phases 1–4 implemented (`dfaa3ad`, including required corrections); Phase 5's feasible **local acceptance** completed after Slack local acceptance `e9139c0`. Phase 5 is **not fully accepted**: CI and live provider/Slack/OAuth/Ubuntu deployment gates remain unrun and require separate authorization. Two stable native tools are installed; default OpenCode, Durable 1.0.0, deployment and rollback remain unchanged.
**Reviewed:** 2026-10-04, Neo `33ada49`; released Pi Durable/MCP `v1.0.2` (`cd32f7725fdbddbaecdff5b1e68491563394e0ca`).
**Companion:** [Pi Durable Slack simplification](2026100401_pi-durable-slack-simplification.md). This plan adds operator MCP onboarding and agent discovery; it does not change the single-owner admission/security architecture.

## Goal

Make adding a compatible MCP server a configuration operation, and calling its tools a native agent operation:

- Operator: configure URL, credential reference and explicit tool policy; validate; restart broker. No source edit, rebuild or per-server environment wiring for the supported HTTP/header-auth case.
- Agent: discover allowed tools and input schemas, then call with a JSON object. No shell command, quoted JSON or separate CLI `--help` roundtrip for normal Pi work.
- Broker: remain the sole owner of upstream connections, credentials, policy, approval, attribution and uncertain-effect handling.

No new conversation server, plugin framework, downstream MCP server, general outbox, second scheduler or automatic adoption of CLI extensions. Existing server names, wrappers, unrelated integrations and private deployment data survive.

## Current seams and problems

- `packages/common/src/proxies.ts` fixes six aliases in `PROXY_NAMES`/`PROXY_REGISTRY`. `WorkspaceConfigSchema` has no configurable MCP catalog. Adding an HTTP server currently requires code and rebuilds.
- A global assertion compares configured approve names with `APPROVAL_TOOL_NAMES`; `mcp-handler.ts::callTool` also requires the built-in discriminated approval schema. Arbitrary `approve` entries cannot be enabled safely by removing just the assertion.
- `tool-instructions.ts::buildToolInstructions` enumerates static tools and teaches `mcp <upstream> <tool> '<JSON>'`. The CLI calls `/exec/mcp`, which is an ExecResult endpoint, **not** an MCP-protocol listener.
- `McpService` already owns transport/cache/policy/approval and integration-specific preparation. Reuse it rather than create another MCP client in runner.
- Generic JSON arguments are not currently validated against every upstream input schema; name matching can be fuzzy, production inventory drift warns, and reconnect needs deliberate revalidation. Upstream `isError` also needs explicit native translation rather than HTTP-success inference.
- Existing approval state has special single-use browser handling, but generic dispatch needs a durable uncertainty boundary. Bare tool-name hooks must not accidentally affect a same-named tool from another server.

These are source findings, not newly executed failures. Prior test results are not validation of this proposal.

## Target ownership

```text
Operator catalog + broker-only credential files
                         |
                         v
remote-cli: validated catalog / MCP clients / policy / approvals
                         ^
                         |
Runner Neo extension: mcp_search + mcp_call
                         |
                         v
Pi Durable: native tool tasks / history / recovery

Legacy mcp CLI -----------------> the same broker service
```

Durable does not read CLI `mcp.json` or provide `pi.registerMcpServer()`. Use native `defineTool`/`defineExtension`; CLI MCP/codemode/tool-search APIs are different. Existing Durable 1.0.0 supports this core design, so upgrading is independent.

## 1. Operator catalog: small, deny-default and broker-owned

### Version 1 configuration (Phase 2)

The following Neo operator format is supported by Phase 2. See [operator instructions](../mcp-catalog.md) for strict parsing, private file modes, HTTP exception and activation:

```json
{
  "version": 1,
  "servers": {
    "mydocs": {
      "transport": "streamable-http",
      "url": "https://mcp.docs.example/mcp",
      "description": "Search team documentation",
      "auth": { "type": "bearer", "secretFile": "mydocs-token" },
      "policy": {
        "allow": ["search_docs", "fetch_doc"],
        "approve": []
      }
    }
  },
  "disabled": []
}
```

`allow` means immediate permitted execution, **not** proof the operation is read-only. `approve` means a separate human authorization flow; unlisted tools are hidden. Do not infer either from MCP annotation hints. No wildcard/allow-all in the first version.

### Defaults and precedence

- Retain the six built-in definitions as bundled defaults; preserve their exact policies, credentials and managed adapters.
- `servers` adds complete definitions for new HTTP aliases. It cannot shadow a built-in alias or select its credentials/managed implementation. Changes to a custom alias replace its whole definition, not a field-by-field credential merge.
- `disabled` explicitly disables known built-in/custom aliases. Omission does not disable a built-in. Removing a custom definition removes that server on the next activation. Reject unknown disable names/alias collisions rather than silently accepting typos.
- Missing default catalog uses bundled defaults for existing/plain Compose installations. Present malformed/unreadable/unsupported configuration fails startup before listen; never fall back to more permissive defaults or a partial catalog.
- Deleting the entire optional catalog restores bundled defaults on restart, including formerly disabled built-ins. Document this distinctly from removing one custom entry; use an explicit valid disable list for revocation.
- During the staged implementation, custom `approve` entries fail startup until the generic approval phase is available. Existing built-in approvals continue through their current typed handlers.

### Files and credential custody

Implemented fixed, optional **directory** mounts, broker only:

| Host directory                | Broker mount               | Purpose                |
| ----------------------------- | -------------------------- | ---------------------- |
| `docker-volumes/mcp-catalog/` | `/etc/thor/mcp-catalog:ro` | `catalog.json`         |
| `docker-volumes/mcp-secrets/` | `/run/secrets/thor-mcp:ro` | Referenced token files |

Keep these outside `/workspace`, repos and shared tmp. Mount neither into runner, executor, OpenCode, gateway, admin, mitmproxy or managed browser children. Directory mounts permit atomic host file replacement; a single-file bind can retain an old inode. Audit broker child/file/proc surfaces too: a broker-only mount alone is not proof every subprocess is isolated.

No new path env vars are needed initially. Optional empty directories must not break plain `docker compose up -d`; provision private host ownership/modes before adding tokens. No required missing `secrets.file` entry. Preserve all current project names, volumes, encryption keys and paths. Never commit mounted catalog/token files.

New servers support no auth or a bearer token file; optional static nonsecret headers/custom secret-header types can be added only with their own typed contract later. Existing built-in env-header resolution stays internal. Generic catalog entries cannot name arbitrary process env values, run `!commands`, interpolate URLs, or inherit broad runtime secrets. This avoids per-server Compose/env rewrites after the initial feature deploy.

`secretFile` is a bounded basename, not a path: reject traversal, symlinks, non-regular/empty files and token CR/LF; document any terminal-newline handling. Require private broker-readable permissions. Missing referenced credentials fail enabled-server startup, never downgrade to unauthenticated access. Load a fixed credential snapshot at startup; unwrap only at upstream I/O. Do not return credential values/references in agent metadata, approval cards, diagnostics or errors.

### URL and metadata boundary

Strict versioned parser; reject unknown fields, duplicate JSON keys, duplicate/overlapping tool policy, reserved/prototype/path/CLI-verb aliases and invalid transports. Descriptions are data, not system instructions. Generate any operator JSON Schema from the owning parser.

New remote servers use absolute HTTPS. Preserve explicitly managed unauthenticated internal HTTP endpoints (Grafana/Falcon) and permit operator-reviewed internal HTTP aliases/fixtures only; bearer credentials over HTTP are unsupported. Reject userinfo, fragments, queries, control characters and URL templates in v1. Model/client requests cannot supply URLs, headers, executable paths or credential references.

Refuse redirect-based endpoint changes during initialization, calls, streams and session teardown; do not send credentials to a redirected/server-selected origin. Verify SDK behavior through local fixtures. No resource-URI fetcher, OAuth discovery or generic SSRF proxy is created. Existing direct network reachability of unauthenticated internal services is not solved by this catalog.

### Activation and operator journey

Initially **restart-only activation**, not hot reload:

1. Obtain actual tool names and review the server's credential/business-argument contract.
2. Place the token in the private broker secrets directory, if needed.
3. Add the catalog definition; run the proposed broker catalog-validation command. It parses local configuration and checks credential availability without connecting or printing values; a separate explicit connection check lists only permitted inventory.
4. Atomically replace the catalog. Drain broker-dependent work, then restart/recreate `remote-cli`.
5. Inspect safe server status and permitted tool discovery. No runner rebuild/restart is required for subsequent supported additions once the two stable native tools are deployed.

Remove/disable and validate before restarting; verify stale references/approvals deny, then remove unused token files. Rotate token files and restart; do not treat interrupted calls as safe retries. Emergency credential revocation may also require revocation upstream.

Startup validates local configuration; a valid configured server being offline marks that server unavailable, not the entire broker unusable. Schema/inventory drift fails that server closed on connect/reconnect without exposing hidden names. Diagnostics contain aliases, bounded failure tags and presence/status booleans, not headers, URLs with sensitive data or raw vendor error bodies.

No model catalog writer, admin CRUD or reload watcher in the first cut. A later reload needs candidate-versus-active snapshots, no partial activation, pinned in-flight connections, and removal/revocation checks for new calls/approval dispatch; it is not implemented merely by watching a file.

## 2. Agent flow: two native tools, not hundreds of declarations

Install proposed tools in the existing Neo Durable extension before scheduling/recovery:

- **`mcp_search`**: query/optional advertised alias; returns a small matching set of broker-visible tool names/descriptions, **complete** selected input schemas, policy and opaque `toolRef`. An empty query returns a bounded server summary. Exact lookup and a continuation mechanism let the agent discover beyond the first page; no hidden names/counts or truncated schemas masquerading as complete.
- **`mcp_call`**: `{toolRef, arguments: {...}}`; broker resolves the exact reference and validates structured arguments before any dispatch or approval effect. No fuzzy invocation, shell quoting, `--help` subprocess, actor/directory/URL/header/credential fields in model arguments.

A reference binds server alias + exact tool + schema/policy/catalog identity. It is **not authorization**; the broker rechecks visibility/current revision/context at every call. Removed/replaced/stale references return a typed stale/denied outcome without effect. A rediscovery handle never permits bypassing policy.

Discovery projects complete supported schema assertions/local definitions and approved descriptive fields, excluding private `_meta` and unreviewed annotation payloads. Do not erase an assertion to make a schema acceptable; unsupported semantics fail closed. Metadata remains untrusted data, not an instruction to bypass the broker.

Use typed private search/call HTTP routes over existing runner-to-broker configuration/internal-secret wiring. Host derives admitted requester, repository, anchor/trigger and native task/call correlation from validated request ownership, not model fields. Broker verifies current request/session/repository authority against its existing trusted context; correlation IDs alone do not authorize calls, and CLI headers cannot upgrade to native scope. Preserve restore-before-submit/wait/abort/resume and serialized active-request/model boundaries from the companion plan.

Extend one `McpService` list/describe/call operation owner. CLI parses once and translates to ExecResult; the native HTTP edge uses structured objects and typed outcomes, **not** a stringify-to-argv-to-stdout loop. `/exec/mcp` remains compatible and does not become an MCP listener. Runner does not connect directly to upstream servers or acquire their credentials. Reuse the installed MCP SDK; adding Pi's separate MCP client would duplicate an existing owner.

### Schemas, results and replay

Choose/test an actual JSON Schema validator/dialect contract at implementation: TypeBox's outer native envelope is not validation of arbitrary upstream schemas, and an SDK type claiming 2020-12 is not proof its validator handles that dialect. Support reviewed draft-07/2020-12 schemas and local definitions/references where the chosen validator proves them; reject unresolved/remote references and unsupported assertion semantics. Cache by revision, not `$id`; no remote schema download, coercion, silent field stripping or applied defaults. Validated outbound argument changes for existing built-ins remain explicit broker preparation.

Native output uses Durable `content`, `isError` and small secret-free correlation details; it has no automatic `structuredContent` field. Translate structured-only MCP results into model-visible JSON text; preserve the CLI's existing non-text JSON fallback. Preserve MCP `isError` even on HTTP 200. Do not put full result copies in native details or ordinary audit logs. Transport errors after dispatch mean uncertainty, not permission to retry.

Keep Harness text/output ownership rather than add another generic truncator. Discovery needs a documented count/descriptor budget because it exposes complete schemas; over-budget schemas are explicitly unsupported, not clipped. Inline MCP images must reuse Neo's existing bounded raster/image-model contract (10 MiB / 16 million pixels, valid supported still image); no SVG/HTML/animation or automatic URI download. Unsupported audio/binary/resources receive an explicit safe representation or unsupported outcome, not base64 prose or invented native support.

`mcp_search` can be replay-safe observational work. **Generic `mcp_call` starts replay-unsafe**, including tools claiming read-only/idempotent annotations. Native task/memo identity does not close the remote effect/result crash window. Only a separately demonstrated provider contract can relax replay policy.

Replace the Pi-only exhaustive MCP inventory/quoted-JSON instructions with discovery guidance. Keep legacy CLI/OpenCode and special Jira attachment, browser/Kali and Slack artifact instructions where their actual workflow needs them. No codemode/QuickJS/tool-search port or dynamic registry mutation is needed for the first version; selected direct aliases can be an optional later optimization.

## 3. Generic approvals without a new hardcoded tool type per server

Configurable allow-only servers are straightforward; arbitrary approval tools require a real contract, not deleting an enum assertion.

Introduce a versioned **generic MCP approval operation** distinguished from built-in operations. Its identity is server + exact tool, never bare tool name. Preserve historical built-in schemas/readers and their specialized handlers (Jira disclaimer/attribution, credential-browser plan/single-use rules, historical Google approvals). Do not route custom same-named tools through those handlers. Google routine operations remain approval-free requester-owned OAuth.

Store **new generic** records and stable fence files in a new broker-only named volume, `mcp-approval-state`, mounted at `/var/lib/remote-cli/mcp-approvals`; use private directory/file modes (0700/0600). Reuse `ApprovalStore` with this explicit root rather than create another store implementation. Do not call the current `/workspace/data/approvals` root private: it is shared through workspace mounts and existing writes do not establish private modes. Keep historical built-in records/lookup in their existing location; no data move or claim that old records became private. Update Compose/fixtures and prove runner/executor/gateway/admin/managed children cannot read the new record volume.

Hold an exclusive kernel owner fence on this generic-state volume for the broker lifetime, separately from runner's Pi SQLite lock. Persist a fresh activation ID atomically before accepting generic work. Failure to obtain ownership fails startup; another broker must not silently invalidate the active owner's state. This is a small state-owner boundary, not a distributed lease or replacement scheduler.

New generic approval records freeze:

- Exact JSON arguments validated without silent rewriting; server/endpoint identity, schema/policy revision and preparation version.
- Trusted original requester/workspace/repository/source request, permitted private review/result destination, expiry and effective outbound arguments.
- Approval/publication/dispatch disposition in the **existing approval record**, not another generic tool ledger.

Use schema/config fingerprints that exclude credential bytes/private payloads. Include the broker activation ID in generic discovery references and pending approvals. **Every activation invalidates previous generic tool references and pending approvals**, even when URL, alias, schema and secret filename are identical. Rediscovery and fresh approval are required after restart/removal/re-addition/token rotation; confirmed or consumed/uncertain records remain readable, never redispatched. Credential files are immutable snapshots within an activation; editing one does not change the active connection. A same-file replacement of account/scope therefore takes effect only through an activation that invalidates prior authority. Do not label same filename or refreshed token bytes proof of unchanged principal. Reconnect inventory/schema changes also invalidate affected references/approvals within an activation. Provider-internal behavior cannot be proven from schema fingerprints; operators must restart/reapprove incompatible deployments.

For **new generic** approvals, initial reviewers are the trusted requesting Slack user, with confirmed private DM delivery. GitHub/cron requests lacking that review context cannot create generic approvals in v1; existing built-in reviewer rules remain unchanged. Model arguments and button hints cannot choose reviewer/destination. Support business arguments only, never credentials in tool payloads; such tools need a dedicated broker adapter. Do not claim heuristic field-name redaction establishes this boundary.

Show the complete reviewed effect/arguments privately, within the platform's review budget. If an informed review cannot fit, return `review_not_supported` rather than approve a truncated fragment; a private authenticated detail UI is a separately scoped enhancement. No generic raw-argument/result/vendor-error fragments in public cards, worklog previews or continuation summaries. Private modes/mounts do not imply encryption or erasure of data already present in native history.

Protect **all generic status/list/result reads and continuation projections**, not only resolve: authenticate the reader through a trusted runner/gateway/operator boundary and check stored requester/team/repository/source authority. Action/session IDs and forgeable CLI attribution are not authorization. Legacy CLI readers may return only a secret-free disposition or explicit denial for generic records; they must never fall through to the current raw ordinary-action `status`/`list` rendering. Native pending results and the authenticated gateway continuation carry only audience-permitted projections. Historical removed-server records retain these same read checks. No new general approval UI or polling agent tool is required in v1.

Persist pending intent before sending a card and retain notification disposition; send-before-receipt uncertainty cannot cause automatic duplicate cards. On approval, recheck requester/source/repository/privacy, expiry, current tool/schema/policy/server/activation identity, then atomically and durably claim dispatch **before** upstream I/O. Implement the claim in `ApprovalStore` with a separate stable per-action lock inode guarding read/claim/write through the dispatch/result window, atomic record replacement and the required file/directory flushes; do not replace the lock inode with the JSON record or rely only on an in-memory map. Validate process-crash/storage/deployment support rather than claim universal power-loss/exactly-once guarantees. Durable itself supplies neither this lock nor a remote effect transaction.

A consumed record without a confirmed result after crash/timeout is uncertain, never pending/retryable again. Pre-dispatch rejection differs from a dispatched MCP tool error. Revocation/supersession prevents later dispatch but cannot undo an already issued effect. Calls pin the validated connection/config snapshot through dispatch; changed config requires fresh approval even if the new policy would allow immediate execution.

Keep historical status/result lookup independent of the active catalog, so removed-server actions remain inspectable but non-executable. Parse legacy records explicitly. Pending v1 records lacking frozen proof are either handled by a bounded legacy resolver while unchanged or invalidated/re-requested where proof is insufficient; never manufacture historical revision/authority. Malformed new records cannot fall back to legacy parsing.

The broker performs the approved dispatch under this claim; the existing gateway continuation conveys an authorized result projection to the agent. A native pending-approval outcome is not successful execution and does not instruct the agent to call the same mutation again. Use that continuation path, not a new task waiter or invented native signal API. Replay-unsafe recovery prevents automatic harness re-execution, not every possible newly issued model/user call; document uncertain-effect guidance without claiming provider exactly-once or adding a universal invocation ledger.

## Phases and exit criteria

All phases require isolated behavioral validation and one commit before the next. Extend existing meaningful broker/native/SDK/container cases; no arbitrary count target, schema echoes or new universal mocked framework.

### Phase 1 — Shared typed broker seam, no new server surface

**Implemented:** shared typed service and private HTTP seam; isolated acceptance evidence below. No custom catalog, generic approvals or native tool registrations are enabled by this phase.

Add typed filtered list/describe/call service operations, authenticated private HTTP edges, exact references/revisions, nested argument validation and structured error/result handling. Adapt CLI to the same owner without changing its command/ExecResult contract. Keep the installed upstream client/managed adapters and current built-in policies.

**Exit:** real local MCP fixtures prove hidden/stale/unknown/schema-invalid calls have no effects, native authority cannot be forged through CLI/body fields, HTTP-200 `isError` remains an error, structured/non-text outputs remain usable, and built-in attribution/disclaimer/browser/Jira behavior remains compatible. Same bare names across servers cannot select a special hook. No new runtime dependency unless a validator need is documented/tested.

### Phase 2 — Operator HTTP catalog and private credential references

**Implemented:** restart-only allow-only catalog, private credential snapshots, exact dynamic lookup, SDK transport and broker child/file boundaries. Acceptance and trade-offs below. No Phase 3 generic approval/state/fencing or Phase 4 native registrations.

Add the strict versioned parser/default-overlay semantics, broker-only optional directory mounts, local validation/safe diagnostics and restart activation. Dynamic lookup replaces the closed server enum for supported custom allow-only definitions; retain explicit built-in handler coverage. Reject unsupported custom approvals until phase 3.

**Exit:** a fixture HTTP server can be added/removed without source changes; empty/missing optional directories boot plain Compose; invalid configured authority/secret paths/duplicates/overlap fail safely. Token/header/URL redirect/error paths, reconnect inventory/schema drift and server outage isolation pass. Directory replacement is observed on restart; catalog/secrets are inaccessible to runner tools/executor/browser children. Unlisted tools never become exposed. Custom `approve` cannot silently become allow.

Update Compose base/Pi/test fixtures, `.env.example` explanatory deployment surfaces, README Deployment Configuration, security/operator docs and applicable workflow setup/env blocks together. No private `.env` or mounted-data edits in implementation. If a new env variable is later necessary, update every required surface in that same phase.

### Phase 3 — Versioned generic approvals and safe dispatch

**Implemented:** private versioned generic operation, requester DM review, lifetime owner/activation fence, action dispatch claims and authenticated minimal result/continuation projections. Isolated evidence below; no Phase 4 registration or live cutover.

Add generic operation schemas and private requester review, immutable approval preparation/revision checks, safe notification/dispatch claim and status/error dispositions. Keep legacy readers and specialized built-in execution. Remove the global static-approve equality assumption only after both paths are covered; replace it with complete runtime policy/handler/schema validation.

**Exit:** custom approved tools require no code-defined tool enum. Broker-only record/fence permissions and second-owner refusal, concurrent/restarted/late clicks, source supersession, identical removal/re-addition, same-secret-file account replacement, token rotation, schema/policy drift, malformed records, failed private delivery and dispatch-before-result crashes preserve authority and cannot automatically redispatch consumed/uncertain approvals. Cross-requester status/list/result reads and raw CLI fallback are denied; full review is possible or explicitly denied. Removed actions remain readable only to authorized readers. Legacy behavior and Google no-command-approval policy remain intact.

### Phase 4 — Native Durable extension and lean discovery experience

**Implemented:** stable native registration, host proof, complete live discovery, structured results/images, private approval hold/continuation and unsafe-call recovery; isolated evidence below.

Install `mcp_search`/`mcp_call` before scheduling; wire authenticated context from the active admitted request; replace Pi MCP prompt/skill obligations while keeping legacy wrappers. Native tools consume live broker discovery, so ordinary subsequent catalog changes need broker restart only, not runner registry rebuild.

**Exit:** real Durable/SQLite → broker → local MCP server demonstrates search→object call, useful schema rejection, isolated requester/repository authority, changed catalog references, approval outcomes and structured/image/error translation. Interrupt/restart/cancellation and dispatch-result crash windows never automatically repeat mutations. Existing Google wait/model/source-reaction behavior and explicit rich Slack actions pass. No upstream credential, caller-selectable identity or hidden tool metadata reaches the model.

### Phase 5 — Integration and deployment acceptance

Run required Unit/Core/Pi Runtime and affected sandbox/GWS/browser checks; ensure the relevant container fixture exercises a **real broker**, not only the existing remote-cli replacement fixture. Push/dispatch only with authorization; PR after required green checks. Accept add/remove/rotation and discovery on the existing Ubuntu Compose project without a second Slack consumer or data resets.

**Exit:** operators add a compatible HTTP/header-auth server through config/secret files plus restart, and Neo discovers/calls it without shell plumbing. Report live provider/Slack/security acceptance separately from isolated fixtures. No runtime-default change, Pi upgrade or rollback retirement rides along with MCP deployment.

## Decisions (proposed)

| Decision                                                            | Reason                                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Broker-only catalog + private secret-file references                | No agent-controlled endpoints/credentials; supported additions do not require code or per-server env rewrites.         |
| Built-in defaults plus explicit additions/disable list              | Existing deployments boot unchanged; no accidental built-in credential inheritance or silent policy merge.             |
| Restart-only initial activation                                     | Avoid a new hot-reload control plane; revisions/drain make change boundaries explicit.                                 |
| Two stable native tools                                             | Small loadout and complete on-demand schemas; avoid hundreds of declarations or a CLI extension/codemode port.         |
| Extend existing `McpService`/`ApprovalStore`                        | One policy/effect owner shared by CLI and native HTTP, not another client or operation ledger.                         |
| Server-qualified generic approvals coexist with built-ins           | No tool enum edit for new servers, without erasing specialized security/attribution or old records.                    |
| Requester-private review for new generic approvals                  | Explicit initial reviewer/destination boundary; no inferred approval from arbitrary thread participants.               |
| Generic invocation replay-unsafe                                    | MCP hints and native receipts do not establish provider idempotency.                                                   |
| Fresh activation identity invalidates generic pending authority     | Alias/URL/secret filename cannot establish unchanged account or prevent identical re-adds from resurrecting approvals. |
| Broker-private generic records with explicit owner/dispatch fencing | Current workspace approval files are not private storage, and in-memory dedup is not a durable dispatch claim.         |
| Keep upstream SDK unless proven insufficient                        | Pi's standalone MCP client is useful but not needed to duplicate an existing transport owner.                          |

## Non-goals and later options

- No arbitrary `npx`/stdio commands, custom process env, unreviewed plugins, generic per-user MCP OAuth, loopback CLI OAuth reuse, admin CRUD, dynamic hot reload or MCP Apps rendering in v1.
- Stdio-only servers require a managed broker adapter or separately provisioned approved HTTP service; catalog entries cannot install software or launch commands.
- Bearer-file credentials are operator/service-scoped, **not** automatically the current Slack user's account. Per-user MCP OAuth needs its own provider/account/private-consent/grant-binding plan; existing Google behavior is not generalized implicitly.
- Optional later: selected direct-tool aliases, supported custom secret-header auth, operator hot reload with immutable snapshots, and private detailed approval UI. No promise that an arbitrary MCP server/schema/auth mode works unchanged.
- Preserve `THOR_*`, `@thor/*`, existing names/paths/aliases, approval/Google data, Compose identity and network/isolation boundaries. No rate limiter, guessed model IDs, policy broadening or uncertain-effect replay.

## Planning evidence (historical)

Three independent read-only source reviews covered catalog/credentials, policy/approval migration and Durable experience. A subsequent critique required explicit broker-private generic approval storage, activation identity and authorized result readers; follow-up verification passed those amendments. This is planning verification, not implementation acceptance. No runtime/code/dependency/config changes or new test execution occurred for this plan.

Source owners: `packages/common/src/{proxies,workspace-config,approval-events,approval-presentation}.ts`; `packages/remote-cli/src/{mcp-handler,upstream,policy-mcp,approval-store,unwrap-result,index}.ts`; `packages/runner/src/{pi-runner,pi-runner-tools,tool-instructions,pi-read-image}.ts`; gateway approval resolution; Compose base/Pi mounts. Native capability authority: [released Durable README](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md), `harness/types.ts::ToolExecutionResult/ToolExecutionApi` and `harness/tool.ts::ToolTask`; [standalone Pi MCP client](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/mcp/README.md) is reference, not a new required dependency.

## Phase 1 implementation decisions and evidence — 2026-10-04

Resumed the interrupted uncommitted broker work rather than reverting it. Completed its missing CLI/shared-call adaptation and private routes, and tightened the trusted context and schema-reference boundaries before acceptance.

| Implemented decision                                                        | Reason / boundary                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extend `McpService`, retaining the SDK and managed browser/Kali adapters    | CLI and private HTTP share one validated inventory and exact call owner. Native results never roundtrip through argv/stdout. No second client, new server catalog or generic approval implementation.                                                                                                                                                                                                                 |
| Direct pinned `ajv` 8.20.0 and `ajv-formats` 3.0.1 dependencies             | Already present in the locked SDK dependency graph; no package versions upgraded. Zod handles Neo envelopes, not arbitrary upstream assertions. Explicit draft-07/2020-12 compilers also replace the SDK's default dialect-dependent output validator.                                                                                                                                                                |
| Reviewed schema-position allowlist and local JSON Pointer references only   | Preserve complete assertions/definitions, including escaped pointer tokens; reject unsupported dialects/keywords, remote/unresolved refs, nested IDs, dynamic anchors/refs and refs into annotation/business data. Draft-07 ignores `$ref` sibling assertions; 2020-12 applies them. No network schema loading, coercion, defaults or stripping. Same `$id` never shares compiled validators between tools/revisions. |
| Revision-pinned immutable inventory, fail-closed drift in every environment | Fresh connection revisions invalidate old references/cursors. Disconnect/list-change notification discards the snapshot; reconnect is lazy and revalidates the entire permitted inventory. No in-place client swap or tool-call retry. Missing policy entries, duplicate names and unsupported permitted schemas make that server unavailable without exposing hidden names.                                          |
| 32 KiB complete descriptor, 20 descriptors / 256 KiB page                   | Discovery paginates without clipping schemas; oversized descriptors are explicitly unsupported via server unavailability. Counts include only visible tools. Empty unscoped search is a bounded server summary, exact lookup is available independently of pagination.                                                                                                                                                |
| Private transport authentication plus current host projection               | `/internal/mcp/search` and `/internal/mcp/call` require the existing internal secret. Broker separately checks requester, team, repo directory, source correlation, request/session/anchor/trigger and host-projected task/call lifetime; IDs and CLI headers/body fields alone are not authority. The worklog is read-only in executor/OpenCode mounts.                                                              |
| Host-projected native call lifetime uses existing `tool_call` records       | `McpNativeCallProjectionSchema` records started/ended task/call proof, separate from admission projection on `trigger_start`. Phase 4 must emit these from the active host request before native I/O and end them afterwards; this phase deliberately installs no model-callable tools. Missing/legacy/ended/superseded proof denies.                                                                                 |
| Typed results and conservative uncertainty                                  | MCP HTTP-200 `isError` remains an error (CLI exit 1); structured results become native JSON text even alongside text. Non-text native blocks have explicit unsupported representations without base64/URI fetching; CLI retains its non-text JSON fallback. Inline image decoding remains Phase 4. Post-dispatch transport/SDK-validation failure is uncertain and never automatically retried.                       |
| Server-qualified built-in preparation                                       | Only Atlassian gets Jira attribution/disclaimers; PostHog gets its feature-flag disclaimer; only the managed browser alias gets login preflight/private session injection/single-use handling. Same bare names on another server cannot select those hooks. Existing built-in approval persistence/readers remain legacy; generic freezing/fencing is Phase 3.                                                        |
| Separate inventory/schema/result/HTTP modules, not another service          | Removing these cohesive owners would mix arbitrary-schema compilation and transport projections back into the already-large `mcp-handler.ts` or duplicate them at CLI/native edges. Expected vendor failures expose bounded tags/messages, never raw errors, resolved credentials or ordinary audit result/argument copies.                                                                                           |

**SDK pagination correction:** a real fixture exposed the installed SDK clearing its output-validator cache on each `listTools` page. The broker therefore retains output validators for the complete permitted revision inventory without accessing private SDK caches. First-page invalid structured output now returns uncertainty after exactly one dispatch. Unsupported hidden output schemas remain hidden without preventing an otherwise supported inventory; required upstream experimental task tools fail inventory validation rather than entering ordinary dispatch.

**Returned built-in dispatch uncertainty:** built-in approvals now retain a returned dispatched error/uncertain result as an approved, consumed record, so another resolve returns that failed result instead of redispatching. Browser's existing pre-dispatch consumption is retained. This does not claim crash-safe pre-dispatch fencing for other legacy records; the versioned generic claim/fence and its crash tests remain Phase 3.

### Isolated verification

- `packages/remote-cli/src/mcp-broker.integration.test.ts`: real installed SDK client/server over local sessionful HTTP, including paginated inventory and real list-change notifications. Records actual dispatched arguments/effects and approval cards. Covers forged context/transport authentication, ended/superseded admissions, hidden/unknown/stale/schema-invalid zero effects, nested draft-07/2020-12 assertions/local-ref semantics, reference-to-annotation rejection, identical schema IDs, drift/duplicate names, complete byte-budget pagination, private metadata exclusion, `isError`, structured/output-schema/non-text translation, one-dispatch uncertainty, Jira attribution/disclaimer and browser single-use compatibility, plus cross-server bare-name isolation.
- `packages/remote-cli/src/mcp-handler.test.ts`: actual app route wiring and existing command/ExecResult, approval/Slack/Jira/browser integration contracts. Fixtures now advertise the complete configured inventory rather than depending on the removed production drift warning; fixture schemas describe the business arguments those tests actually send.
- Finite dialect/keyword/revision/context cases use independent table-driven corruption inputs through the real broker edge rather than echoing schema declarations or adding another property-testing dependency. Existing suite exercises Google continuations, Pi SQLite/runtime, image contracts and Kali managed API behavior.
- Final local commands and results recorded below before the phase commit. No live provider/Slack acceptance, container deployment, GitHub push/CI or mounted private-data access was performed. Those remain later integration/deployment gates, not claims of Phase 1 acceptance.

**Original Phase 1 acceptance (superseded by independent verification below):** targeted broker tests passed (55 tests); `pnpm test` passed (71 files, 1,108 tests); workspace typecheck/build and changed-source formatting/diff checks passed. Independent verification subsequently found four required defects despite those green checks; the original acceptance was insufficient.

## Phase 1 independent-verification corrections — 2026-10-05

Corrected the four required findings in the same Phase 1 commit before starting any later phase. No dependency, environment, built-in policy, catalog, native tool registration, deployment or private mounted-data changes.

| Correction / decision                                          | Boundary and behavioral evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate full admitted cwd from canonical repository authority | `directory` keeps the existing runner/executor cwd, including subdirectories and normalized path spellings. Required `repositoryDirectory` is the lexical canonical `/workspace/repos/<repo>` root derived through the existing workspace admission rules, not a new single-name regex restricting runner work. Shared schemas validate containment/root identity; broker compares both against current host admission. No claim of host filesystem/symlink validation for an executor-owned namespace. |
| Require operation-bound host tool proof                        | Every discovery/describe check requires a started `mcp_search` record; preparation/dispatch requires started `mcp_call`. Latest same-call proof must match the endpoint as well as all task/request/context fields. A transport secret and search task cannot grant mutation or approval effects.                                                                                                                                                                                                       |
| Persist confirmed browser MCP errors                           | A completed HTTP-200 `isError` result replaces the pre-dispatch unknown placeholder durably, just like success. Transport/validation uncertainty retains the existing consumed unknown disposition. Neither path redispatches on repeated resolve or approval-store reconstruction. No new generic crash-safety claim.                                                                                                                                                                                  |
| Bound inventory acquisition and cancel startup on shutdown     | Maximum 128 pages / 2,000 tools per SDK connection, including empty unique pages. Exact search reuses its attempted inventory instead of silently reconnecting after failure. Broker shutdown aborts pending SDK initialization/listing and closes its transport; listeners are removed on success/failure. This is an endpoint-specific inventory/resource bound, not a rate limiter or a general Harness timeout/output wrapper.                                                                      |

### Permanent regression and differential evidence

- `packages/runner/src/pi-runner.test.ts`: real local Responses/executor HTTP and SQLite prove root, `/packages`, nested subdirectory and normalized cwd spellings retain HTTP 200, the correct file/tool cwd, actor and task model. Reopening SQLite and redelivering the same request schedules no extra model/tool effect. A separate test checks the full-cwd/canonical-root admission projection.
- The same four caller-visible cwd tests passed against runner `cc6c2b9`; original Phase 1 `ec9ac978` plus its original projection schema passed the root case but failed all three subdirectory cases with HTTP 503. Corrected source passes all four. Differential copies were obtained from Git into temporary files, not substituted into the working tree or used as the permanent tests.
- `packages/remote-cli/src/mcp-broker.integration.test.ts`: installed SDK client/server over HTTP prove search-only proof cannot dispatch the real allowed `createIssueLink` operation or create an approval; swapped endpoints and unrelated tool names deny with zero upstream effects/cards, while correctly bound search/call succeed. Corrupted repo/root/full-cwd contexts deny before effect; a valid admitted subdirectory calls successfully.
- Browser HTTP-200 provider rejection remains the same confirmed error on later resolve, status read and approval-store reconstruction, with exactly one browser dispatch. The corresponding transport-failure case stays consumed/unknown with no reconnect or redispatch.
- Real SDK fixtures reject both 2,050 empty pages followed by a valid page and indefinitely generated unique empty pages after exactly 128 inventory requests. They expose no hidden names/counts, create no tool/approval effects or usable connection, close SSE streams and let shutdown settle. A complete final inventory at page 128 succeeds; a held inventory SSE response is aborted and closed during shutdown.
- Deliberate regression copies fail these permanent tests: accepting either MCP proof dispatches `createIssueLink` using the search call ID; the old browser exit-code guard loses the confirmed provider rejection; the original unlimited-page upstream accepts the late inventory. These red probes are evidence of the tests' sensitivity, not failures of corrected source.

**Corrected Phase 1 acceptance:** `pnpm test` passes (71 files, 1,121 tests); `pnpm typecheck` and `pnpm build` pass across the workspace. Targeted broker/legacy HTTP tests and changed-source formatting / `git diff --check` pass. Commands use the already installed Node 24.11.1 and host dependencies with only local/dummy fixtures, as authorized; sandbox preflight found the approved base runtime but no prepared repository image, and no sandbox installation/preparation was performed. Phases 2–5, native image decoding/registration, private generic approval fencing, real-container/GitHub verification and live deployment/provider acceptance remain explicitly unimplemented/unverified. No push or next-phase work.

## Phase 2 implementation decisions and evidence — 2026-10-05

Implemented only MCP Phase 2 after `fa72c0e`. The six bundled definitions/policies,
their existing credentials/managed adapters, legacy CLI wrappers, runtime default,
deployment identities and static built-in approval coverage remain unchanged.
No new runtime dependency/version, environment family, downstream client/server,
reload watcher, plugin, outbox or approval operation was introduced.

| Implemented decision                                                                            | Reason / boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict Zod version 1 parser plus bounded decoded-key JSON scan                                  | `JSON.parse` loses duplicate keys; Zod records skip `__proto__`. Validate original decoded keys before the owning schema. Unknown fields, prototype/reserved/CLI/path aliases, collisions, unknown disables, duplicate/overlapping/wildcard tool policy and custom approvals fail closed. The generated operator structural JSON Schema does not replace semantic/filesystem validation.                                                                                                                                  |
| Complete defaults/additions snapshot; no custom credential overlay                              | `getProxyConfig` accepts an authoritative active policy map. Broker discovery/CLI/dispatch/warm-up/health use its exact aliases; built-in typed handlers remain server-qualified. Omission retains defaults, removal removes custom entries, and deleting the whole optional catalog restores bundled defaults. Present invalid/unreadable input fails before listen, never partially activates.                                                                                                                          |
| Private enabled bearer basenames, pinned directory/file descriptors and immutable startup bytes | Require broker ownership, private readable modes, one regular link, no symlinks/traversal/special bits, bounded nonempty RFC6750 token bytes. Strip exactly one terminal LF; CR/CRLF and embedded LF/whitespace fail. Disabled credentials are not read. Wrap secret bytes through I/O and never expose references/values in diagnostics; file replacement does not mutate active clients.                                                                                                                                |
| Explicit internal unauthenticated HTTP contract                                                 | New remote servers use HTTPS. Only `auth:none` plus `http:{type:internal-unauthenticated,operatorReviewed:true}` permits single-label internal DNS, localhost, private/loopback IPv4 or IPv6 loopback. This operator review is not a DNS/firewall guarantee. Bearer HTTP and public HTTP fail parsing; existing Grafana/Falcon defaults stay unchanged. No arbitrary headers, executables, environment selection/interpolation or OAuth/resource discovery.                                                               |
| One SDK endpoint-pinned fetch for every HTTP method                                             | Installed SDK POST, GET/SSE/resume and DELETE all use the same fetch, including header injection at I/O. Refuse all redirects/endpoint changes and discard HTTP error headers/bodies before SDK exception construction. SDK automatic SSE resume is disabled; the broker owns reconnect/inventory revalidation. Teardown is bounded and never follows a redirected origin.                                                                                                                                                |
| Credential reflection boundary                                                                  | Generic bearer `isError` is a confirmed error with bounded text, not raw vendor fragments. Exact known-token reflection in inventory fails that server closed; reflected successful output is unsupported/uncertain after dispatch, without exposing bytes or retrying. This is not heuristic business-field redaction or proof a malicious provider cannot exfiltrate its own credential.                                                                                                                                |
| Activation inventory baseline plus fresh connection revisions                                   | Reconnect does not silently adopt changed permitted schemas/output schemas/metadata. Revalidate the entire permitted inventory against the activation baseline; unsupported/duplicate/missing/drifted inventory isolates that server. Fresh connections invalidate old refs/cursors even when unchanged. Restart explicitly adopts reviewed drift and credential replacements.                                                                                                                                            |
| Catalog aliases cannot adopt shared legacy approval records                                     | Custom `approve` fails startup even when disabled. Legacy approval lookup/list remains restricted to bundled handlers and existing dedicated GWS hooks, not the dynamic HTTP catalog. A planted custom legacy record cannot dispatch hidden tools or fall through to raw status/list. Disabled built-ins retain historical lookup but cannot dispatch while disabled. Private generic records/fencing/read authorization remain Phase 3.                                                                                  |
| Fixed integration command sandbox, reduced env and fresh child procfs                           | Broker command children grant only fixed binaries/integration env and explicit mounts. Catalog/MCP tokens/private OAuth state/parent procfs are absent; legacy GitHub wrappers keep only their dedicated key/cache, GWS only its execution directory/requester token. Internal exec is typed git/gh workspace repair, not arbitrary binaries/shells. No request/env selects an unsandboxed fallback. Production composition enables the launcher before listening; component exec fixtures do not claim kernel isolation. |
| Broker-only Docker `systempaths=unconfined`, capabilities dropped, no-new-privileges            | A real container rejected fresh rootless procfs with Docker's masked parent procfs. The former bind of broker `/proc` was not isolated merely by `--unshare-pid`. Remove system-path masking only for broker so a fresh child procfs can be mounted; retain custom seccomp/AppArmor, UID1001 and drop all capabilities. This is not privileged or seccomp-unconfined. Local fixture verifies the no-AppArmor platform case; live Ubuntu profile/deployment remains a later gate.                                          |
| Pinned shared files through SDK upload completion                                               | Auditing direct broker file surfaces found Slack block-file TOCTOU and cloud artifact/bundle upload path reopening. Verify opened regular inodes within allowed roots, retain descriptors through SDK streaming, reject symlinks/private/proc escapes, and preserve binary contents/names and existing size budgets. No generic output cap or new artifact memory-buffering layer.                                                                                                                                        |
| Bundle the already pinned AJV/dialect implementation with broker artifacts                      | Keeps reviewed schema validators aligned with the current broker, including cached runtime images lacking Phase 1's new direct package aliases. No dependency upgrade/install. MCP transport still uses the installed SDK, not a substitute client.                                                                                                                                                                                                                                                                       |
| Separate cohesive parser/files/HTTP/command/shared-file/diagnostic owners                       | Deleting them would spread duplicate-key/credential custody, all-method HTTP policy, launch grants or descriptor lifetime logic across CLI/native/SDK/file consumers. Extracted managed-browser launcher retains its existing adapter; these are boundaries around the existing service, not a universal mocked framework or another operation owner.                                                                                                                                                                     |

### Isolated behavioral acceptance

- `mcp-catalog-files.test.ts`: real local files/directories prove exact six-default
  preservation; missing/empty directories; malformed/unreadable/symlinked input;
  decoded duplicate keys; strict version/fields/aliases/authority; policy overlap,
  wildcard/duplicate/collision/unknown-disable denial; disabled credential behavior;
  terminal LF handling; CRLF/empty/bad token denial; private modes, special bits,
  nonregular/FIFO/hardlink/symlink denial; and immutable snapshots/atomic replacement.
- `mcp-catalog.integration.test.ts`: real installed SDK client/server, local TLS
  trusted test CA, real sessions/SSE/DELETE and actual dispatched arguments/effects.
  Adds/removes/re-adds by atomic config without source edits; rotates same filename
  without altering the old client; denies stale refs, hidden/fuzzy calls and planted
  custom legacy approvals; preserves disabled built-in historical status; proves
  offline isolation, reconnect schema/inventory fail-closed behavior, same bare Jira
  name isolation, 301/302/303/307/308 initialization and list/call/GET/DELETE redirect
  refusal, server-selected SSE/OAuth origin refusal/ignore, zero requests/credentials
  to redirect targets, safe transport/vendor/MCP token errors and metadata/result
  reflection denial. Existing Phase 1 private authority/native/schema/legacy gates
  also pass; no native tools were registered.
- `sandbox-file-boundary.test.ts`: real git/files and a faithful external cloud
  boundary prove ordinary binary/text names/content, mixed safe/private zero reads,
  proc/parent-symlink denial and post-validation path replacement still uploading the
  original pinned inode. Existing legacy sandbox suite already mocks git/file
  production and now explicitly substitutes that file boundary; it is not the
  security proof.
- `test-mcp-catalog-compose.sh`: real broker with current compiled artifact and
  cached broker/runner/executor images; unique private named volumes, dummy values,
  internal network, no host ports, downloads/install/build or deployment data.
  Local validation makes zero connections; explicit check lists only permitted
  inventory; actual HTTP allow/hidden calls have exactly one effect. Real kernel
  probes through production managed-browser/command launch args cannot read catalog,
  MCP tokens, workspace symlink aliases or broker proc/env canaries. Runner/executor
  image probes cannot read mounts. Remove/restart observes the directory replacement;
  deleting the optional file boots six defaults. Malformed catalog and foreign-owned
  enabled token fail both local validation/startup before listen. Cleanup removes all
  fixture containers/network/volumes, leaving existing images/deployment untouched.
  Runner/executor probes are measurement processes, not a live Pi conversation.
- Base, Pi, CI and no-AppArmor Compose graphs rendered with dummy-only env and
  `--env-file /dev/null --no-env-resolution`: both fixed mounts are read-only and
  present only on remote-cli; broker namespace settings remain coherent. No private
  `.env` or actual mounted catalogs/tokens were read/edited.
- Updated `.env.example`, README Deployment/security, operator/browser docs, Compose
  base/Pi/platform/CI/test fixtures and workflow setup together. A separate MCP Catalog
  E2E workflow prepares images explicitly before offline validation; existing Pi/Core
  remain distinct. No workflow was pushed/dispatched in this phase.

Final exact commands/results are recorded below before the single Phase 2 commit.
Sandbox preflight found the approved Node base runtime but no prepared repository
image/dependencies; no preparation/download was attempted. Explicitly requested
host Node 24.21.0/local fixtures and already available Docker images supplied these
implementation checks. Live provider/Slack, loaded Ubuntu AppArmor, full Pi native
conversation, generic approval fencing, GitHub integration and deployment acceptance
remain Phase 3–5 / operator gates, not claims of this isolated Phase 2 acceptance.

**Final local gates (Node 24.21.0, existing dependencies/images only):**

- Targeted command: `pnpm exec vitest run packages/remote-cli/src/{mcp-catalog-files.test,mcp-catalog.integration.test,mcp-broker.integration.test,mcp-handler.test,sandbox-file-boundary.test,sandbox.test,slack-post-message.test,upstream.test}.ts` — **8 files / 179 tests pass**.
- `pnpm test` — **74 files / 1,209 tests pass**.
- `pnpm typecheck` and `pnpm build` — **all workspace packages pass**.
- `MCP_TEST_BROKER_IMAGE=thor-gws-remote-cli:e2e MCP_TEST_RUNNER_IMAGE=thor-pi-e2e-1000-3364098-runner:latest MCP_TEST_EXECUTOR_IMAGE=thor-pi-e2e-1000-3364098-pi-executor:latest ./scripts/test-mcp-catalog-compose.sh` — **pass**, including zero-connect local validation, private mount/proc/env probes, real effect policy, removal, defaults restoration and both before-listen failures. All fixture resources cleaned; no dependency installation/image build/download.
- Dummy-only Compose base/Pi/CI/no-AppArmor graph checks, changed-file Prettier, `bash -n scripts/test-mcp-catalog-compose.sh` and `git diff --check` — **pass**.

**CI coherence correction:** all broker command children now require rootless mounts,
not only the credential browser. Docker's default AppArmor profile denies these;
the explicitly test-only Core override uses AppArmor-unconfined with the custom
seccomp, capability drop, no-new-privileges and child namespace/mount/env policy.
Production retains `thor-remote-cli`; no claim the CI relaxation is its equivalent.
The separate offline catalog fixture already exercises these same test-only flags.

One Phase 2 commit only; no push, dispatch, PR, next-phase implementation or live
deployment/provider/private-data changes. Follow-up Phase 3 must supply the private
versioned generic approval contract before changing this phase's startup/read/resolve
denials or static built-in approval coverage.

## Phase 3 implementation decisions and evidence — 2026-10-05

Implemented only MCP Phase 3 after `3ba5b80`. No native tool registrations,
Durable/OpenCode/dependency upgrades, new runtime environment variables, deployment,
push, workflow dispatch, PR, private mounted-data access or historical record move.

| Decision / owner                                                                      | Boundary / reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict version 1 `genericMcp` representation in `mcp-approval.ts`                     | Server-qualified operation, branded action/activation IDs and immutable validated/effective JSON, preparation version, schema/connection reference, endpoint/catalog/policy fingerprint, activation, original requester/team/repo/source/request/session, private destination and expiry. Generic preparation v1 does not rewrite arguments. New malformed/hybrid representations never fall back to legacy parsing.                                                                                                                                                                           |
| Reuse `ApprovalStore` at the explicit new private root                                | New 0700/0600 broker-owned records/fences in `mcp-approval-state` at `/var/lib/remote-cli/mcp-approvals`. Existing `/workspace/data/approvals` writes/modes/paths remain historical and shared, not retroactively private. Atomic JSON replacement flushes file and containing directory; new date entries flush their root. Stable action lock inodes guard read/claim/I/O/result windows. The store's established synchronous storage exceptions are contained at the startup/private broker boundaries and become bounded denial/uncertainty values, never raw parser/filesystem fragments. |
| `McpApprovalOwner` owns Linux filesystem mechanics, not a second store                | Private constructor capability is minted only after util-linux `flock` acquisition on an inherited open description retained by the broker. Second startup fails before activation replacement/listen. Fresh activation is atomically durable every startup. Deleting this module would duplicate FD ownership, private mode checks and file/directory flushing across startup/store; records remain owned by the existing store. No PID recovery, lease, scheduler or distributed/power-loss guarantee.                                                                                       |
| `GenericMcpApprovals` coordinates policy/effects inside `McpService`                  | Deleting it would mix private Slack confirmation, publication ordering, frozen proof, readers and consumption into the legacy handler. No second MCP client or invocation ledger: notification and dispatch dispositions are fields in the approval record. Same host call cannot automatically resend a card after receipt loss/reconstruction. A distinct newly issued call is not provider deduplication.                                                                                                                                                                                   |
| Confirmed requester DM and full plain-text JSON review                                | Only admitted Slack requesters; bot workspace and `conversations.info` prove the stored DM user/privacy. Complete review (including heading/repo) fits a conservative 2800 UTF-16-code-unit section budget or returns `review_not_supported`. Intent is flushed before posting. Unconfirmed/failed receipt is uncertain, with no automatic duplicate card. GitHub/system/cron and CLI attribution cannot select reviewers/destinations. Business-argument-only tools are an operator contract, not heuristic credential field redaction.                                                       |
| Latest original admission, not a permanently started native tool                      | Original tool/request may have finished while waiting, but supersession/malformed projection/expiry prevents dispatch. Click compares signed gateway user/team/actual card channel/timestamp to stored delivery, then rechecks private audience, complete frozen authority, current approved inventory/schema/policy/reference/preparation and live pinned connection immediately before the consumed claim and dispatch. Reconnect revokes the affected revision even if inventory is identical.                                                                                              |
| Consumed claim before any upstream I/O                                                | Missing confirmed result after transport loss/process death stays consumed/uncertain forever. Concurrent, contradictory and late clicks cannot redispatch. A completed MCP `isError` is a confirmed tool-error disposition, not pre-dispatch denial or pending. Revocation after dispatch cannot undo effects.                                                                                                                                                                                                                                                                                 |
| Minimal authorized result projection                                                  | Persist/return completed, tool-error, rejected or uncertain disposition, not raw vendor output. This v1 result projection intentionally does not retain provider text/business result bodies or introduce a detailed result UI/capability. All private status/list/result reads check stored requester/team/canonical repo/original source/request/session, even after server removal. CLI status/result/resolve deny generic records and list excludes them; no raw ordinary-action fallback.                                                                                                 |
| Existing gateway continuation, with stored private host reply admission               | Signed interactivity supplies evidence over the internal-secret edge; button hints cannot choose authority. Generic resolution is not retried through legacy `/exec/mcp`. Queued projections are reauthorized before prompts; cross-reader, mixed/public audience and workspace mismatches deny. Frozen repo/private DM thread and stored requester determine continuation and host-owned reply admission. Prompts report disposition and prohibit mutation replay, without raw argument/result/vendor fragments or unsupported polling instructions. No waiter/outbox/native signal API.      |
| Qualified runtime handler coverage replaces global bare-name equality                 | Bundled approve policies must have explicit server-qualified specialized handlers; legacy pending records also require current approved inventory plus the historical typed schema. Custom approve requires owned private state and the complete generic path. Operator inventory-only checks can inspect policy without owner/activation changes but cannot execute/resolve tools. Jira attribution/disclaimers, credential browser consumption and GWS requester OAuth/routine approval-free execution remain separate.                                                                      |
| Finite independent corruption/transition cases rather than a new generator dependency | The relevant authority/disposition discriminants and named failure gates have bounded table-driven cases through real edges. Arbitrary-schema validation/pagination remains covered by earlier real SDK suites. No schema-echo/helper-only count target or module mock added.                                                                                                                                                                                                                                                                                                                  |

### Permanent isolated regression gates

`packages/remote-cli/src/mcp-generic-approval.integration.test.ts` uses the installed
SDK client/server with local trusted TLS/bearer auth, real session/list-change HTTP,
real Slack HTTP, actual worklog/approval files and kernel flock helpers:

- Complete private business review and exact dispatch of a custom same-bare Jira
  name without attribution/disclaimer hooks; ended original tool/trigger can await
  review, while supersession/expiry/reconnect schema drift deny with zero effects.
- Full review budget/private audience failure; GitHub and CLI reviewer denial;
  wrong user/team/channel/card and unauthenticated clicks/readers; concurrent
  preparation, failed publication and receipt loss create no duplicate cards.
- Stable action inode across JSON replacements; concurrent/contradictory/late clicks,
  owner refusal without activation modification, identical restart/removal/re-add,
  policy approve-to-allow changes and same-secret-file account replacement/token
  rotation. Actual upstream authorization stays pinned until restart; fresh review
  uses the replacement snapshot, never the old pending authority.
- Real broker child **SIGKILL** after upstream dispatch before result, and after Slack
  card publication before receipt; ownership recovery leaves consumed/uncertain or
  unconfirmed state, with no second upstream effect/card. These are real process
  crashes, not just reconstructing an in-memory service.
- All stored reader scope dimensions deny cross-reader status/list/result access;
  removed-server confirmed actions remain inspectable by authorized readers. CLI
  attribution/capability/raw fallback denies. Malformed versioned files stay intact
  and cannot dispatch or leak parsing fragments.
- Real signed gateway HTTP rejects forged signatures/readers/public card hints;
  real queue → authenticated broker reread → local runner HTTP carries only safe
  private disposition, stored repo/requester and host-owned private reply admission.
  Tampering queued reader scope denies before any runner continuation.
- Supersession after dispatch does not claim to undo the effect; MCP tool errors
  and dispatched transport failure retain confirmed-error/uncertain state across
  restart rather than returning to pending.

Existing broker/legacy/browser/Jira/GWS, requester isolation, arbitrary-schema,
Durable/SQLite/image and gateway suites remain part of the full test gate.

The real-broker `scripts/test-mcp-catalog-compose.sh` now exercises custom approve
discovery, trusted fixture admission, full private Slack card, approved upstream
effect, durable confirmed record, authorized result and raw CLI denial on current
compiled broker artifacts in cached images. It also checks second **container**
startup cannot change activation, private owner/action/record modes and absent
mounts for runner/executor/gateway/admin and production managed browser/command
child namespaces/procfs. Existing local-only validation, add/remove/default boot,
hidden effect, malformed/foreign-token startup and cleanup gates remain. Fixture
authority code is compiled separately with `pnpm build:mcp-fixture` before offline
validation (not installed/rebuilt inside the audit script). No production data,
host ports, external gateway, download or image/dependency installation/build.

**Verification environment:** sandbox preflight found approved `node:24-bookworm`
base runtime but no prepared repository image/dependencies. As explicitly delegated,
checks used installed host Node 24.21.0/dependencies and already cached Docker
images, with dummy/local fixtures only. Runtime/image/dependency availability are
not conflated. Initial fixture packaging probes failed on TS `.js` resolution and
external dependency placement; the final separately bundled fixture, mounted at
its common dependency owner, passes without any installation.

Final commands/counts and cleanup evidence are recorded below before the one
Phase 3 commit. Live Slack/provider behavior, Ubuntu loaded AppArmor/power-loss
storage guarantees, GitHub integration checks and full native Durable discovery/
approval conversation remain explicitly **unverified** Phase 4–5/operator gates,
not claims of this isolated Phase 3 acceptance.

**Encoding correction:** private v1 records must match the owning canonical writer;
duplicate dispatch fields cannot downgrade consumed proof, and JSON keys the Zod
envelope would silently strip are rejected before review/effects (including nested
`__proto__`). Private record reads are bounded to 128 KiB; full review and minimal
result records fit this storage contract. Independent malformed/duplicate-key
regressions leave source bytes intact and prove no repeated dispatch. This is not
heuristic credential redaction. Slack notification credentials stay wrapped/private
until the final HTTP boundary.

### Original Phase 3 gates (superseded by correction below)

- `pnpm test` — **75 files / 1,241 tests pass**, including **32** new real
  HTTP/SDK/Slack/process approval regressions and unchanged legacy/browser/Jira/GWS
  and Pi runtime coverage.
- `pnpm typecheck`, `pnpm build`, `pnpm build:mcp-fixture` — **pass** using existing
  pinned dependencies (no installation/upgrade).
- `MCP_TEST_BROKER_IMAGE=thor-gws-remote-cli:e2e MCP_TEST_RUNNER_IMAGE=thor-pi-e2e-1000-3364098-runner:latest MCP_TEST_EXECUTOR_IMAGE=thor-pi-e2e-1000-3364098-pi-executor:latest MCP_TEST_GATEWAY_IMAGE=thor-pi-e2e-1000-3364098-gateway:latest MCP_TEST_ADMIN_IMAGE=thor-pi-e2e-1000-3364098-admin:latest ./scripts/test-mcp-catalog-compose.sh`
  — **exit 0**, current compiled broker, including actual custom approve/private
  Slack review/claim/result, CLI/reader gates, second container refusal with unchanged
  active activation, private record/fence modes and all four consumer/managed-child
  mount/proc isolation probes. Post-close Docker container/volume/network queries
  show **no fixture resources left**; existing images/deployment remain untouched.
- Dummy-only `docker compose --env-file /dev/null ... config --no-env-resolution
--format json` for base/Pi/CI/no-AppArmor — **pass**; exactly one
  `mcp-approval-state` mount, on remote-cli only. Required values were dummy-only;
  optional unset values remained blank, no private env-file resolution.
- Changed-source Prettier, `bash -n scripts/test-mcp-catalog-compose.sh` and
  `git diff --check` — **pass**.

The original implementation passed these suites, but independent verification found
the required incomplete-authority-evidence defect below; that acceptance was
insufficient. Live provider/Slack, loaded production AppArmor, GitHub workflows and
Phase 4 native conversation gates remain unverified. One Phase 3 commit only;
no push/deploy/cutover/retirement or `.pi`/private data staged.

## Phase 3 P1 correction — complete authority evidence — 2026-10-05

Corrected before Phase 4 and amended into the original Phase 3 commit `f9026fd`.
An admitted pending approval followed by an unterminated
`{"type":"trigger_start","triggerId":"` session tail previously completed on an
authenticated click. The streaming trigger scan skipped the fragment; the cached
slice discarded it without counting malformed evidence. Malformed/incomplete alias
records could similarly hide rebinding. Permanent real MCP SDK/TLS/Slack HTTP tests
reproduced `completed` instead of `rejected` against the original source; the initial
focused regression run had 22 failures and 3 passes before the fix.

| Decision / owner                                                           | Reason / boundary                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event-log.ts` retains byte completeness alongside tolerant parsed history | Authority requires readable UTF-8 and a terminal LF for every nonempty log. Valid JSON without LF, whitespace-only unterminated tails, partial UTF-8 and invalid UTF-8 inside otherwise parseable JSON are not committed evidence. Validate the whole byte buffer, not individual read chunks. No dependency, writer format or public viewer contract changes.                           |
| All three MCP admission/approval/call-proof readers use complete evidence  | Require both the session and global alias log to be complete, with no skipped malformed/schema-invalid records. An ambiguous alias record cannot safely be classified as unrelated to the active binding. Restrict denial to MCP authority readers; historical viewer/routing readers keep their valid records and existing tolerant behavior. No fallback to an older admitted trigger. |
| Reuse cached session records and one trigger-record scan                   | Authority scans the same complete parsed evidence instead of the tolerant streaming path. The shared private guard avoids three divergent byte/alias checks; the existing scanner serves both strict authority and tolerant historical consumers. No second log store, public abstraction or approval ledger.                                                                            |

### Corrected isolated evidence

- `event-log-authority.test.ts`: 18 real-file cases cover session/alias corruption,
  valid JSON without LF, whitespace, malformed complete/schema-invalid records,
  split/invalid UTF-8, cache invalidation and authority restoration only on valid
  newline commit. Every nonempty prefix of a superseding record denies all three
  authority readers, including a valid final JSON object lacking LF. Committed
  Unicode across a 64 KiB streaming boundary preserves native call/search proof;
  ended original admission still permits approval. Historical slices/actors/aliases
  remain readable and rejected bytes remain intact.
- `mcp-generic-approval.integration.test.ts`: 11 added real authenticated broker
  regressions. Pending private review plus incomplete/malformed/invalid-UTF-8 or
  newline-less session/alias evidence yields durable rejection, no upstream
  mutation, no extra private card and denied native search/call. Complete tails
  still create review and dispatch exactly once. Existing 32 approval/process/
  gateway tests and legacy compatibility remain covered.
- Focused new regression command: `pnpm exec vitest run
packages/common/src/event-log-authority.test.ts
packages/remote-cli/src/mcp-generic-approval.integration.test.ts -t
'complete append evidence|fail closed on incomplete|valid final JSON'` —
  **29 pass / 32 intentionally unselected**.
- `pnpm test` — **76 files / 1,270 tests pass**. `pnpm typecheck`, `pnpm build`
  and `pnpm build:mcp-fixture` — **pass**, installed Node 24.21.0/dependencies only.
- Same cached-image command listed in the original Phase 3 gates,
  `./scripts/test-mcp-catalog-compose.sh` — **exit 0**. Current compiled real
  broker plus local MCP/Slack now also prove six incomplete/malformed/newline-less
  session/alias cases reject authenticated clicks/calls with zero added upstream
  effects, while the healthy approved path and private mount/owner gates pass.
  Post-cleanup Docker queries found **no fixture containers, volumes or networks**.
- Dummy-only base/Pi/CI/no-AppArmor Compose renders with `--env-file /dev/null
--no-env-resolution --format json` — **pass**: exactly one broker-private approval
  mount and both catalog/token mounts broker-only/read-only. Changed-source
  Prettier, `bash -n scripts/test-mcp-catalog-compose.sh` and `git diff --check` pass.

Sandbox preflight confirmed an approved Node base runtime but no prepared repository
image/dependencies; delegated local checks used existing host dependencies/cached
Docker images, not installation, download or audit preparation. No private mounted
data or `.env` files were read. No Phase 4 work, push, deployment, workflow or live
Slack/provider acceptance; those gates remain explicitly pending.

## Phase 4 implementation decisions and evidence — 2026-10-05

Implemented only Phase 4 after `9f086c6`. No Pi/dependency upgrade, new production
environment variable, dynamic tool registry, direct upstream client, provider retry,
waiter/outbox/invocation ledger, policy broadening, deployment, push or private-data
access. Existing legacy MCP wrappers, bundled specialized handlers and Google
authorization/model routing remain separate owners.

| Decision / owner                                                            | Boundary / reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PiMcpBrokerClient` is the concrete Durable/private HTTP adapter            | The existing `McpService` remains policy/effect owner. Deleting this adapter would spread native proof lifetime, structured parsing, cancellation/uncertainty and content translation into runner composition/tools. Google continuation/status clients do not own MCP semantics; no generic HTTP framework or second SDK client was added. Transport credentials remain privately wrapped until I/O; failures expose safe tags/messages.                                                                                                   |
| Register two tools in `thor-pi` before `Harness.open` and all scheduling    | Native task IDs are numbers in installed 1.0.0; stringify that trusted ID for the existing broker seam. Derive requester/team/full cwd/canonical root/source/request/anchor/trigger from parsed active/latest admission and native task/call API. Emit operation-bound started/ended proof around private I/O; no model-selectable identity or observer-inferred authority.                                                                                                                                                                 |
| Complete live discovery uses shared broker page budget and Harness settings | Search is replay safe; complete schema pages can exceed the default 50 KiB text budget. Keep the existing 256 KiB descriptor-page contract in common and allow that page plus its bounded envelope through Harness output limits, rather than another truncator. Real large-page tests prove complete JSON/assertions reach the model. Hidden tools, annotations, `_meta`, upstream config and credentials never enter discovery. Descriptions remain untrusted tool-result data, not system prompt instructions.                           |
| Every native call remains replay unsafe                                     | No annotation can change the generic replay contract. Object arguments go directly to typed broker HTTP; invalid nested arguments fail before upstream/approval effects. Native details contain only disposition and small task/call/action IDs, never full result copies. HTTP-200 `isError` stays an error; structured-only output is JSON text; unsupported audio/resource content is explicit, with no fetching/base64 prose.                                                                                                           |
| Reuse the single `pi-read-image.ts` raster decoder                          | Its existing byte/pixel/signature/envelope/full-decode/still/model rules now also accept untrusted inline MCP image bytes. No second decoder or URL owner. Canonical base64, MIME/contents equality, cancellation, 10 MiB and 16M pixels precede model images. Existing local-file/executor tests remain required.                                                                                                                                                                                                                          |
| Authenticated minimal approval wait observation in the existing broker      | Match original current complete admission and reader scope before observing generic or server-qualified legacy pending records. Return only pending/clear/unavailable, not names/counts/arguments/results. Native pending outcome records hold provenance on the existing receipt; failed reads and disappearing holds cannot publish a paused answer or claim success. No polling agent tool or native signal API.                                                                                                                         |
| Existing signed gateway continuation plus runner reread                     | Gateway forwards the minimal scoped projection; runner independently rereads it against the original stored requester/team/repository/source/request/session. Reject mismatched/public input audiences, supersession, pending/forged results and unavailable reads. Inherit original final model/escalation evidence, full cwd and host/tool ownership. Host resumes preserve the exact original confirmed requester-DM target and human source, not the review card thread. Tool-owned originals never acquire automatic host publication. |
| Preserve target rather than invent public result authority                  | A frozen host-owned public/different-DM target cannot satisfy both original-target inheritance and Phase 3's requester-private result contract. Deny that continuation explicitly rather than silently changing ownership/destination or publishing private projections publicly. This is a fail-closed audience limitation, not a new permission policy or an excuse to replay the mutation. Operator reconciliation/private follow-up is required for that combination.                                                                   |
| Lean Pi instructions, retained legacy/special workflows                     | Pi uses live discovery/object calls; only the legacy path enumerates bundled CLI inventory/quoted JSON. Browser/Kali skills select native discovery when available and retain their legacy command and special plan/session/security workflows. Jira attachment uploads and Slack artifacts/tool-owned ordinary replies remain unchanged.                                                                                                                                                                                                   |
| Extend the real Pi container fixture, not only standalone broker probes     | Add the real production broker with its private catalog/owner volume and installed SDK fixture. Retain faithful model/Slack/SSO/legacy-wrapper boundaries. Cached-image validation uses current separately compiled artifacts, an internal-only network, dummy OAuth setup for authoritative empty waits, no ports/downloads/install/build and unique disposable volumes. Broad catalog/child/private-state probes remain the separate existing fixture.                                                                                    |

### Permanent isolated gates

- `pi-runner.test.ts` now has **41** real native/SQLite → broker → SDK HTTP
  regressions: paginated complete discovery (including pages beyond 50 KiB), exact
  object dispatch and nested schema errors; requester/repo/cwd/task/call/operation
  tampering with zero effects/cards; HTTP-200 tool errors, dispatched uncertainty,
  structured-only JSON, unsupported resources/audio, valid still PNG/JPEG/WebP/GIF
  and malformed/SVG/MIME/byte/pixel/animation/text-model rejection; catalog
  restart/removal/re-add with stable runner registrations and stale-ref denial.
- Approval cases prove approved/rejected/tool-error/uncertain minimal results,
  static suspended holds with no source check or paused host answer, private read
  reauthorization/corruption denials, original host target/model/human-source
  inheritance, old tool-owned policy preservation and redelivery without effects.
  Unavailable wait observation stays unconfirmed. Native viewer distinguishes MCP
  holds/continuations from Google authorization.
- Real unsafe dispatch tests hold the upstream after the effect, then use graceful
  close, authorized interruption and a **SIGKILL child runner** on actual SQLite.
  The reopened Harness supplies potentially-partial error content, never repeats
  the effect even with `readOnlyHint`. Safe search recovery repeats only discovery
  under the same native proof, then performs exactly one object call. These are
  native execution/checkpoint tests, not module mocks or schema echoes.
- Existing real broker/Jira approval test also proves scope-checked native legacy
  hold observation and its transition to clear, with cross-requester unavailability.
  Existing private generic crash/fence/reader/gateway, Google wait/routing/source,
  rich Slack artifact, local image and legacy wrapper suites remain full gates.
- Pi container acceptance includes real search/object call, structured/image/error
  translation, and native hold → **signed gateway click** → broker claim/SDK effect
  → authenticated disk queue/result reread → actual native continuation and original
  host target/model, without a mutation re-call. Existing signed Slack intake,
  source reactions, rich/tool-owned wrapper, remote tools/images, SSO/viewers and
  SIGKILL recovery remain. Standalone catalog/private-mount/owner gates are also rerun.

Finite boundary/transition/corruption cases were chosen over another generator
dependency; they exercise the independent wire/storage inputs and observed effects,
not library schema declarations. Existing v1/v2 metadata migrations explicitly
exclude the new source field; current v3 adds only parsed optional result authority
and hold evidence, without switching historical delivery ownership.

### Final verification

Final commands/results are recorded below before the single Phase 4 commit.
Sandbox preflight found an approved Node base runtime, but no prepared repository
image/dependencies. Explicitly delegated checks therefore use installed host Node
24.21.0/dependencies and cached Docker images with local/dummy fixtures only.
No installation, download, sandbox preparation, private `.env`/mounted data or `.pi`
changes are included. Live provider/Slack rendering, production Ubuntu AppArmor,
GitHub workflow/push/PR and deployment/cutover remain **unverified Phase 5/operator
gates**, not claims of Phase 4 isolated acceptance.

**Container-discovered correction:** the first signed native approval round exposed
the gateway's frozen-payload parser discarding the new structured source field. A
direct native admission test and an unfrozen sender alone did not establish that
contract. Added the field to the existing disk-manifest parser, retaining old absent
fields as authoritative, and strengthened the real signed gateway process test to
assert original reader/result scope survives freezing. The final real-container
round now exercises that exact chain successfully. No new queue/store was added.

**Original Phase 4 local gates (superseded by required corrections below):**

- `pnpm exec vitest run --no-file-parallelism` — **76 files / 1,311 tests pass**,
  including **41** real native MCP cases and unchanged Google/model/source/rich
  Slack/browser/Jira/catalog/private-state/legacy suites. Final log:
  `/tmp/mcp4-final-tests.log`.
- `pnpm typecheck`, `pnpm build`, `pnpm build:mcp-fixture` — **pass**, all workspace
  packages. Logs: `/tmp/mcp4-types.log`, `/tmp/mcp4-build.log`,
  `/tmp/mcp4-fixture-build.log`.
- `PI_TEST_USE_CACHED_IMAGES=1 MCP_TEST_BROKER_IMAGE=thor-gws-remote-cli:e2e
PI_TEST_RUNNER_IMAGE=thor-pi-e2e-1000-3364098-runner:latest
PI_TEST_EXECUTOR_IMAGE=thor-pi-e2e-1000-3364098-pi-executor:latest
PI_TEST_GATEWAY_IMAGE=thor-pi-e2e-1000-3364098-gateway:latest
PI_TEST_ADMIN_IMAGE=thor-pi-e2e-1000-3364098-admin:latest
PI_TEST_INGRESS_IMAGE=thor-pi-e2e-1000-3364098-ingress:latest
./scripts/test-pi-e2e.sh` — **exit 0**, current compiled artifacts and real broker,
  including the signed native approval/continuation chain. Log:
  `/tmp/mcp4-final-pi-e2e.log`.
- Same cached broker/runner/executor/gateway/admin selectors under
  `MCP_TEST_{BROKER,RUNNER,EXECUTOR,GATEWAY,ADMIN}_IMAGE`,
  `./scripts/test-mcp-catalog-compose.sh` — **exit 0**, including real generic
  approval/private state, owner refusal, credential/child/proc isolation, complete
  authority evidence and restart-only catalog behavior. Log:
  `/tmp/mcp4-final-catalog-e2e.log`.
- Dummy-only Compose graph, changed-file Prettier, `bash -n` and
  `git diff --check` — **pass**. Post-cleanup Docker queries show no owned fixture
  containers, networks or volumes. No images/deployment resources were rebuilt,
  downloaded or removed by cached validation.

**Remaining gates / limits:** Phase 5 CI push/workflow/PR, live provider/Slack
rendering/OAuth and production Ubuntu AppArmor/storage/power-loss/deployment
acceptance remain unrun and require separate authorization. No exactly-once provider
claim or automatic uncertainty replay. A host-owned public/different-DM original
target must be denied before generic approval intent/card/mutation; both frozen
target inheritance and requester-private projection must hold. One Phase 4 commit;
no push, next-phase implementation or `.pi`/private deployment data staged.

**Complete-schema decoder correction:** final inspection found recursive Zod JSON
records would strip `__proto__` business-map keys inside an otherwise supported
schema's enum/default/property data. The native wire edge now checks the root
object without transforming the JSON tree already validated by the broker. The
real SDK/native regression verifies exact enum assertions and a valid object call;
the old decoder fails it. This does not relax argument/approval proto-key rejection
or broker schema semantics.

**Tool-owned private context preservation:** when the original tool-owned source is
the same broker-confirmed requester DM, reuse its native conversation/history,
original reply thread and human message timestamp, while discarding the incoming
host publication proof. The outcome matrix verifies original history/session,
source completion reaction and no automatic host answer for both ownership modes.
Other tool-owned results remain in the private review conversation; no public
result projection or delivery-ownership upgrade is inferred.

## Phase 4 required corrections — pre-effect audience and sibling review — 2026-10-05

Corrected P1/P2 before final acceptance and amended into the Phase 4 commit originally
`89d3ae0`. The original green suites were insufficient: public/different-DM host
requests could mutate and then permanently fail continuation, and distinct calls
could create sibling cards/effects whose second continuation was stranded by the first.
No optional private-continuation enhancement, ledger, scheduler, new policy, dependency,
production environment variable, push, deployment or final acceptance is included.

| Decision / owner                                                       | Reason / limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Freeze reply ownership in the existing host `trigger_start` projection | Runner emits the parsed receipt's host/tool ownership and exact target. The broker independently reads complete committed evidence; model/HTTP hints cannot supply delivery authority. Old logs remain parseable, but missing delivery proof cannot create generic review and requires a fresh admitted private-DM request. Explicit legacy tool-owned receipts retain their supported private review/result flow. No OpenCode event/viewer representation changes.                                                                                                         |
| Reject unsupported audiences before private intent/card/effect         | After confirming the requester DM/workspace, generic preparation checks the frozen host target against it before any record or card. Public/different-DM targets return actionable `review_not_supported` without silently rerouting. The same gate participates in original-authority checks before dispatch; runner's continuation denial remains defense in depth.                                                                                                                                                                                                       |
| One generic review operation per originating session/request           | The existing owner and creation lock guard the existing approval-record scan and first intent write. All dispositions count, including completed-before-continuation, rejected, consumed/uncertain and old activations. Same task/call may retain its pending action; a distinct task/call cannot create another review. This is deliberately stricter than one outstanding review; no sibling descendant authorization or new store is introduced. Additional work needs a fresh admitted request/authorized continuation, never automatic replay of dispatched mutations. |
| Conditional native guidance                                            | Pending is not execution. A result continuation may report disposition while original authorization remains current; human supersession still revokes it. Unsupported review and one-operation denials carry actionable instructions. No unconditional promise to deliver a result or retry mutation.                                                                                                                                                                                                                                                                       |

### Permanent behavior evidence

- Real native Durable/SQLite → broker → installed SDK tests reject public channel,
  group/private-channel and different-DM frozen host audiences with **zero private
  intents, approval cards and upstream effects**, plus actionable private-DM guidance.
- Two distinct real native calls in successive rounds and in one model tool batch
  create only one review operation; resolving the first before the second call and
  before continuation still produces no second card/intent/effect. The first authorized
  result resumes successfully without repeating the mutation.
- Pi retains sequential native tool execution. To prove the broker's concurrent
  boundary as well, the model-batch case holds the first real native Slack card receipt
  and sends a separately host-proved sibling HTTP call under that same SQLite admission.
  It denies while the creation lock is held; after release, the second actual native
  task also denies against durable intent. This is not a claim that Pi executes tools
  in parallel or that the synthetic sibling was a second native task.
- A real newer human request supersedes the native original: authenticated resolve
  rejects with no mutation and its stale continuation returns 403, without new cards.
- Real broker/SDK/Slack/file tests deny missing ownership and ignore caller-selected
  delivery hints; same task/call retains the pending action while distinct task/call
  identities deny both before/after resolution and after broker reconstruction.
  Fresh admitted work can request a new review. Token rotation tests now explicitly
  admit fresh requests rather than relying on previously unsupported sibling reviews.
- Finite audience/state/ordering cases cover these invariants without a new generator
  dependency. No new exported abstraction; the private audience predicate is reused
  only at preparation and original-authority recheck. Existing specialized built-in
  approvals, Google, tool-owned reply ownership and unsafe recovery remain full gates.

### Corrected gates

Final commands use installed Node **24.21.0** and existing pnpm **9.14.4**, selected
explicitly via PATH; no package-manager/dependency installation or pin change.

- `pnpm exec vitest run --no-file-parallelism` — **76 files / 1,321 tests pass**.
  Log: `/tmp/mcp4-fix-full-tests.log` (final run, 143.20 seconds).
- Focused required regressions — **2 files / 11 pass / 217 intentionally unselected**.
  Log: `/tmp/mcp4-fix-regressions.log`. Exact command:

  ```bash
  pnpm exec vitest run packages/runner/src/pi-runner.test.ts packages/remote-cli/src/mcp-generic-approval.integration.test.ts -t 'unsupported frozen host|one native review|newer human request|unsupported/missing frozen|same task/call'
  ```

- `pnpm typecheck`, `pnpm build`, `pnpm build:mcp-fixture` — **all pass**.
  Logs: `/tmp/mcp4-fix-types.log`, `/tmp/mcp4-fix-build.log`,
  `/tmp/mcp4-fix-fixture-build.log`.
- Final cached real-broker Pi E2E — **exit 0**, including native discovery/calls,
  signed gateway approval/queue/native continuation with original target/model,
  Google readiness setup, source ownership, isolation and SIGKILL recovery.
  Log: `/tmp/mcp4-fix-pi-e2e.log`. Exact selectors/command:

  ```bash
  PI_TEST_USE_CACHED_IMAGES=1 MCP_TEST_BROKER_IMAGE=thor-gws-remote-cli:e2e \
  PI_TEST_RUNNER_IMAGE=thor-pi-e2e-1000-3364098-runner:latest \
  PI_TEST_EXECUTOR_IMAGE=thor-pi-e2e-1000-3364098-pi-executor:latest \
  PI_TEST_GATEWAY_IMAGE=thor-pi-e2e-1000-3364098-gateway:latest \
  PI_TEST_ADMIN_IMAGE=thor-pi-e2e-1000-3364098-admin:latest \
  PI_TEST_INGRESS_IMAGE=thor-pi-e2e-1000-3364098-ingress:latest \
  ./scripts/test-pi-e2e.sh
  ```

- Final cached MCP catalog/private-state dummy E2E — **exit 0**, current compiled
  artifact and enriched trusted fixture delivery proof, with private review/effect/
  result, complete authority evidence, catalog activation and owner/child/mount gates.
  Log: `/tmp/mcp4-fix-catalog-e2e.log`. Exact selectors/command:

  ```bash
  MCP_TEST_BROKER_IMAGE=thor-gws-remote-cli:e2e \
  MCP_TEST_RUNNER_IMAGE=thor-pi-e2e-1000-3364098-runner:latest \
  MCP_TEST_EXECUTOR_IMAGE=thor-pi-e2e-1000-3364098-pi-executor:latest \
  MCP_TEST_GATEWAY_IMAGE=thor-pi-e2e-1000-3364098-gateway:latest \
  MCP_TEST_ADMIN_IMAGE=thor-pi-e2e-1000-3364098-admin:latest \
  ./scripts/test-mcp-catalog-compose.sh
  ```

- Post-script container, volume and network queries filtered by project labels
  `thor-pi-e2e-1000-112668` and `neo-mcp-catalog-test-1000-112669` return **no resources**.
  Earlier successful runs (`86526`/`86527`) likewise cleaned completely.
- Dummy-only, empty inherited environment Compose renders:
  `docker compose --env-file /dev/null -f docker-compose.yml [-f
docker-compose.{pi,ci,no-apparmor}.yml] config --no-env-resolution --format json`
  — **all four pass**, exactly one broker-only approval-state mount and broker-only
  read-only catalog/token mounts. JSON: `/tmp/mcp4-fix-compose-{base,pi,ci,no-apparmor}.json`.
- Changed-file Prettier, `bash -n scripts/test-pi-e2e.sh
scripts/test-mcp-catalog-compose.sh` and `git diff --check` — **pass**.

Initial correction probes exposed scanner omission of the new frozen delivery field,
reused model fixture call IDs and the already sequential native execution setting;
these were repaired/represented explicitly before the final passing suite, not hidden
by weakening the audience/operation guards. An initial typecheck failed on an
unexported test schema import; the test now uses the existing public projection type
and destination parser, with no new export. Initial pnpm shim/PATH and Compose dummy
variable shell-quoting setup failures were resolved using existing binaries and a
clean explicit dummy environment; no installation or live configuration fallback.

Sandbox preflight confirmed `sbx v0.46.0` and an approved Node base image but **no
prepared repository/dependency image**. Explicitly delegated checks therefore use
installed host Node 24.21.0/dependencies and cached Docker images, dummy/local fixtures
only; no installation, download or preparation. Phase 5 CI/push/PR, live accounts/Slack,
production AppArmor/storage/power-loss and deployment/final acceptance remain **unrun**.

## Phase 5 — feasible local integration acceptance — 2026-10-05

Completed local acceptance after `dfaa3ad` and companion Slack local acceptance
`e9139c0`, without push/PR/deploy/live accounts or private mounted-data changes.
This is the **local portion**, not acceptance of live deployment or the full phase.
Core implementation remains complete; no optional 1.0.2 alignment, typed Google
redesign, default cutover or rollback retirement was included.

### Integration repairs and decisions

| Decision / repair                                                          | Actual boundary and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extend the existing real-broker Pi Compose, not the legacy wrapper fixture | A dummy TLS bearer alias is added/disabled/removed/re-added/rotated by atomic config/token replacement and broker-only activation. The actual running Harness performs discovery/object calls; container ID **and process start time** stay identical through all seven rounds. Every provider round offers exactly the stable `mcp_search`/`mcp_call`, not per-alias registrations. No new client/service/registry.                                                                                      |
| Generate TLS only on disposable fixture volumes                            | Existing prepared broker image supplies openssl; init creates a one-day local test certificate/key. Only the fixture gets its private key, broker gets the test CA and broker-only token mount. TLS verification stays enabled; no credential-over-HTTP or production mount/env change.                                                                                                                                                                                                                   |
| Record safe principal labels, not headers                                  | Installed SDK TLS dispatch proves first versus replacement account snapshots. Atomic token replacement without restart still uses first principal and same ref; rotation of the unchanged enabled alias uses replacement principal and invalidates old ref. Stale calls after disable/remove/re-add/rotation produce no effects.                                                                                                                                                                          |
| Exercise audience/one-review policy in the actual Compose chain            | Public and different-DM host requests get actionable denial before cards/effects. Two distinct native review calls in one request create only one card; the second denies. The first remains a static hold with no paused final answer or source check, then signed gateway click → broker claim/SDK effect → disk queue/reread → private original host target/model/human-source completion, without mutation replay. Broader audience/race/outcome matrices remain in real native/broker unit fixtures. |
| SIGKILL in the actual native MCP effect/result window                      | The fixture records a readOnlyHint call's effect then withholds the result. Killing/reopening only runner restores original Slack actor and strong/high model before generation; Harness reports potentially-partial tool error, never a repeated call. Host final text/metadata remains on the original private target. Recovery uses `--no-deps` so init cannot reset catalog/config/TLS underneath the test.                                                                                           |
| Repair the UTC-midnight expiry fixture, not production expiry policy       | The first serial run exposed backdating `createdAt/dateSegment` into yesterday while leaving today's still-live action file. The test wrote a second identity path, so lookup correctly found the newer copy. Fixture relocation now removes the old path and asserts one canonical record plus the exact expired timestamp. A permanent previous-day case makes this boundary deterministic. No production approval/store behavior changed, no timeout/assertion relaxed.                                |
| Build host artifacts before Pi workflow's broker mount                     | Image build alone does not create host `dist`, which the fixture mounts read-only. Pi Runtime workflow now runs `pnpm build` before the container check and triggers on the new lifecycle fixture/package changes. Local YAML/filter/order checks pass; GitHub execution remains unrun.                                                                                                                                                                                                                   |
| Fail acceptance on incomplete cleanup                                      | Both existing Compose scripts now check project-label containers, volumes and networks after teardown and return failure if any remain. Only uniquely owned fixture resources are removed; no deployment/image cleanup.                                                                                                                                                                                                                                                                                   |

The new `scripts/fixtures/pi-mcp-lifecycle.mjs` is a cohesive native HTTP acceptance
client, not a production abstraction: it centralizes per-round NDJSON, complete
discovery/stale/native result and independent upstream effect/principal assertions.
Deleting it would duplicate that test protocol across seven shell steps. Existing
init/Responses/SDK fixtures remain their owners. Finite activation/audience/expiry/
crash transitions were selected over a property-test dependency; no module mocks,
new exports, provider retry or universal invocation ledger were added.

### Final local gates

Host Node **24.21.0**, pnpm **10.33.4**, installed pinned dependencies and existing
cached Docker images only. Cached Pi processes report Node **24.15.0**. Sandbox
preflight confirmed `sbx v0.46.0` and approved `node:24-bookworm` but no prepared
repository/dependency image; explicitly authorized host/dummy Docker checks were
available and used. No install/download/image rebuild/sandbox preparation during
these checks; no private `.env` resolution or live API access.

Ten passing workload commands (plus graph, format/syntax and cleanup checks):

1. `pnpm exec vitest run --no-file-parallelism`: **76 files / 1,322 tests pass**,
   no skipped tests. Includes native migration/publication/source/Google/model,
   real SDK/Jira/built-in browser/Chromium, catalog/private reader/fence/crash,
   sandbox fail-closed/pinned-file and legacy behavior. Final duration 142.96s.
2. `pnpm typecheck`: all **eight** workspace packages pass.
3. `pnpm build`: all workspace builds pass.
4. `pnpm build:mcp-fixture`: separate current authority fixture compiles before
   offline validation; no dependencies rebuilt in acceptance scripts.
5. Cached `./scripts/test-pi-e2e.sh`: **exit 0**, actual broker/native SDK chain,
   seven lifecycle rounds (`absent`, `add`, `replace-token`, `disable`, `remove`,
   `readd`, `rotate`), complete schemas, unchanged runner ID/start time, stale
   zero-effect denials, TLS principal rotation, two stable tools/no shell roundtrip,
   unsupported review and sibling denial, signed approved continuation, structured/
   image/isError, original actor/model/host target and unsafe SIGKILL recovery.
   Final upstream effects **9**, private cards **1**, crash-window call exactly **1**.
   Actual runner/executor/gateway/admin cannot read private token/catalog/approval/
   key mounts. Existing signed intake/SSO/viewer/executor raster/wrapper paths pass.
6. Cached `./scripts/test-mcp-catalog-compose.sh`: **exit 0**, real current broker,
   catalog/default/startup validation, full private review/dispatch/result, second
   owner refusal, incomplete-authority denial and actual production managed-browser/
   command kernel proc/env/file/mount isolation, plus all four consumer probes.
7. `./scripts/test-gws-e2e.sh thor-gws-remote-cli:e2e thor-gws-opencode:e2e`:
   pass using current host-built broker artifacts, dummy per-user OAuth/GWS direct
   reads/writes, formatting/pagination, upstream denials, Drata and private mounts.
8. `node --import ./packages/runner/node_modules/tsx/dist/loader.mjs
scripts/test-gws-browser-cookie.mjs /usr/bin/chromium`: pass, actual Chromium
   withheld/preserved scoped cookie and safe recovery; no real account/profile.
9. Same Node command for `scripts/test-gws-ingress-browser.mjs`: pass, shipped
   Nginx/fake SSO/Google, genuine browser chooser/owner callback against dummy
   providers, public exact GIF/PNG bytes/MIME/decoding in both themes.
10. `pnpm exec vitest run packages/remote-cli/src/mcp-generic-approval.integration.test.ts
-t 'rechecks.*before dispatch'`: **4 pass / 44 intentionally unselected**,
    including permanent previous-day expiry and unchanged supersession/inventory.

Exact cached selectors for command 5:

```bash
PI_TEST_USE_CACHED_IMAGES=1 MCP_TEST_BROKER_IMAGE=thor-gws-remote-cli:e2e \
PI_TEST_RUNNER_IMAGE=thor-pi-e2e-1000-3364098-runner:latest \
PI_TEST_EXECUTOR_IMAGE=thor-pi-e2e-1000-3364098-pi-executor:latest \
PI_TEST_GATEWAY_IMAGE=thor-pi-e2e-1000-3364098-gateway:latest \
PI_TEST_ADMIN_IMAGE=thor-pi-e2e-1000-3364098-admin:latest \
PI_TEST_INGRESS_IMAGE=thor-pi-e2e-1000-3364098-ingress:latest \
./scripts/test-pi-e2e.sh
```

Command 6 selects the same cached broker/runner/executor/gateway/admin under
`MCP_TEST_{BROKER,RUNNER,EXECUTOR,GATEWAY,ADMIN}_IMAGE`. Current compiled artifacts
come from the host build, not historical image source. Logs:
`/tmp/mcp5-{tests,types,build,fixture-build,pi-final,catalog,gws,cookie,browser,expiry-regressions}.log`.

Base/Pi/CI/no-AppArmor graphs rendered with empty inherited environment, explicit
dummy values and `--env-file /dev/null --no-env-resolution --format json`; assertions
confirm exactly one broker-private approval mount and broker-only read-only catalog/
token mounts. Both fixture graphs additionally prove real broker entrypoint,
internal-only network, no host ports and consumer private mount absence. Local
workflow preparation/filter coherence, changed-file Prettier, `bash -n` for all
three acceptance scripts, `node --check` for all changed fixtures and
`git diff --check` pass. JSON: `/tmp/mcp5-compose-{base,pi,ci,no-apparmor,pi-fixture,mcp-fixture}.json`.
These are local workflow checks, **not** GitHub runner results.

Cleanup is asserted by the scripts and independently queried afterward; final
Pi `thor-pi-e2e-1000-280006` and catalog `neo-mcp-catalog-test-1000-303093`
project labels have no containers/volumes/networks. Earlier failed
and passing Pi probes (`180476`/`188511`) likewise leave no resources. GWS/browser
containers/networks and `thor-gws-*` temporary private directories are absent;
fresh browser contexts/servers close in `finally`. Initial Pi failure was a fixture
assertion spelling (`private-DM` vs actual actionable `private DM`), corrected
without changing product policy. The initial serial expiry failure is retained
at `/tmp/mcp5-tests-initial-date-boundary.log`, followed by the focused and full
passing runs above.

### Remaining external gates / next

**Next:** obtain explicit authorization for required Unit/Pi Runtime/MCP Catalog
and relevant Core/Sandbox GitHub checks, then live acceptance on the **existing**
Ubuntu Compose project/keys/volumes. No push, dispatch, PR or deployment here.
Full acceptance remains pending:

- Actual served provider/model behavior; Slack workspace status-feature/permissions,
  native lifecycle/client rendering, GIF/accessibility/reduced-motion and artwork
  rights; genuine provider OAuth/account identity and requester continuation.
- Live Slack/Jira/Core/OpenCode smoke and `pnpm test:mcp` against configured real
  providers. Their scripts can contact live accounts and were not launched.
- Daytona sandbox lifecycle requires cloud credentials/snapshot/external repo,
  so `test-sandbox-e2e.sh` was not launched. The feasible local sandbox/file/kernel
  denial subset passed above; it is not cloud acceptance.
- Loaded Ubuntu `thor-remote-cli` AppArmor and filesystem `flock`/rename/directory
  fsync/backup/power-loss support. This host's AppArmor kernel reports `N`; fixture
  unconfined-AppArmor and process SIGKILL do not establish Ubuntu/power-loss safety.
- Runtime-default/ingress cutover, retirement, optional Pi upgrade or Google
  redesign require their own explicit approval and are outside this local work.

Operator README/catalog guidance now makes supported HTTP/auth/schema scope,
unsupported review audiences and **one operation per original request** explicit;
completed/rejected/uncertain records still count. No all-MCP/dialect promise,
provider exactly-once guarantee, automatic uncertainty retry or private-result
publication to an unsupported audience. No `.pi`/private deployment files staged.

## Final acceptance corrections after `ef307bd` — 2026-10-05

Independent cross-phase review reproduced two runner defects and identified a
missing local production-launcher gate. Corrections belong to the final MCP Phase
5 acceptance commit, amended as requested; core phase commits are retained. No
separate correction commit, push, CI dispatch, PR, live account, optional upgrade
or deployment is authorized here. **Phase 5 remains locally verified only**, not
fully accepted.

### Repairs and decision log

| Decision / repair                                                          | Boundary and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consume continuation admission by approval action across all conversations | Existing runner-wide reconstructed request bindings find any prior receipt for the action, including historical timestamp-based IDs. New admissions use server-derived `mcp-approval:<actionId>` identity in the existing intent/submission; no ledger, scheduler or schema version added. HTTP callers cannot choose the reserved identity. Still reread the broker using original stored requester/team/repo/source/session, compare the exact projection and fingerprint the normalized payload. Equal valid clicks reuse the same admission even when the original public tool-owned conversation stays latest forever; changed payload/source/requester and real human supersession deny. |
| Recheck source at the intent/native-submit crash gap                       | The same local authority owner serves HTTP admission and pre-submit recovery. Existing native input remains the native admission authority; an unsubmitted intent alone cannot schedule after source supersession, changed result or unavailable observation. It defers without effects; no new retry coordinator. Reconstructed historical and deterministic identities reuse the original receipt/trigger rather than minting another.                                                                                                                                                                                                                                                       |
| Preserve legacy native model evidence, not classify continuation text      | A receipt without `modelSelection` inherits the original validated native AgentDoc model/thinking/full cwd. Missing metadata is not permission to choose from the new pool. New-conversation initialization and existing-conversation configuration retain this choice; unregistered/retired models, unavailable provider and cwd drift fail closed before admission/generation. Existing saved selections and escalation evidence keep their original support checks. Tool-owned historical work never acquires incoming host publication proof.                                                                                                                                              |
| Enable the exact production GWS launcher in the dummy fixture              | The old GWS fixture used `createRemoteCliApp` without the startup isolation switch; its earlier functional pass was **not** evidence of production GWS kernel execution. Export/reuse the existing one-way enable operation, with fixed production launcher/binary and fixture-only custom seccomp, capability drop, no-new-privileges, system-path and unconfined-AppArmor settings. No production config/env/mount change or unsandboxed fallback.                                                                                                                                                                                                                                           |
| Measure the actual real CLI process during API requests                    | The installed gws 0.22.5, not an executable replacement, performs dummy Google reads/writes. Broker-side proc observations prove fresh PID namespace/procfs, 0700 distinct per-command cwd, private cache bind, only that requester's token/reduced env, and absent parent cache/OAuth storage/credential env. Hostile workspace dotenv cannot replace the token. API denials and successful commands both remove private execution directories; container/network cleanup is a failing gate. No kernel/CLI regression was uncovered with the enabled production launcher.                                                                                                                     |

`currentMcpContinuation` remains a private cohesive owner inside admission: deleting
it would duplicate the same original/source/consumption checks at ingress and crash
recovery. It extends existing binding/native-submit ownership, not a new service or
operation ledger. Tests use real SQLite/Harness, signed gateway/disk queue, broker,
SDK and recording HTTP effects. Finite current/legacy/busy/intent/supersession/result/
resource cases were selected over a generator dependency; no module mocks added.

### Final local evidence (supersedes earlier local counts/GWS launcher claim)

Same Node 24.21.0/pnpm 10.33.4, pinned installed dependencies and cached images.
Preflight again confirms SBX v0.46.0 and approved `node:24-bookworm`, **no prepared
repository/dependency image**. Authorized host builds and internal-network dummy
fixtures were used; no installs/downloads/image builds/preparation, live OAuth,
private `.env` or Ubuntu deployment data.

- `pnpm exec vitest run --no-file-parallelism`: **76 files / 1,337 tests pass**,
  zero skipped, 151.54s. **15 new behavior cases** cover repeated genuinely signed
  clicks with different timestamps/gateway IDs (public tool-owned into DM and same
  DM), busy duplicate and runner restart, immutable payload/requester/source,
  supersession, reconstructed pre-submit intents with stable/historical IDs,
  superseded/changed-result/changed-requester intent recovery, v1/v3 legacy migration into both same
  and private-new conversations, explicit original model/high/full cwd and
  retired/provider/cwd failures. The existing eight host/tool disposition cases
  additionally assert new-click-ID redelivery with zero extra generation. Legacy
  completed redeliveries remain readable after model retirement without execution;
  only new/pending admissions require executable inherited resources. Focused final
  command `pnpm exec vitest run packages/runner/src/pi-runner.test.ts -t
'grant-bound automatic Google|committed intent|legacy.*approval|consumes signed|holds native completion'
--no-file-parallelism` passes **23 / 173 intentionally unselected**. A grant-bound
  automatic Google resume after MCP approval is also proven: inherited MCP result
  context is not a second direct action consumption and cannot block the existing
  Google coordinator. Ready-record redelivery adds no model input/MCP effect.
- `pnpm typecheck`, `pnpm build`, `pnpm build:mcp-fixture`: **pass**, all eight
  workspace packages and current compiled authority fixture.
- Cached `./scripts/test-pi-e2e.sh`: **exit 0**; all seven native catalog lifecycle
  rounds, signed private approval/queue/native completion, unchanged runner
  identity/start time, TLS principal rotation, image/structured/error handling,
  unsupported audience/sibling denial, private mounts and actual unsafe-effect
  SIGKILL recovery pass. No replay or live-provider assertion. Cleanup project:
  `thor-pi-e2e-1000-472639`.
- Cached `./scripts/test-mcp-catalog-compose.sh`: **exit 0**, real broker generic
  review/effect/result/reader/owner/fence, malformed/incomplete-authority zero-effect
  denials, production browser/command kernel probes, validation/defaults and
  before-listen failures. Cleanup project: `neo-mcp-catalog-test-1000-491670`.
- `./scripts/test-gws-e2e.sh thor-gws-remote-cli:e2e thor-gws-opencode:e2e`:
  **exit 0**, now through the **enabled production GWS kernel launcher** with real
  CLI: **11 isolated account commands / 23 API requests / 2 writes (one denied)**,
  dummy encrypted per-user OAuth, direct reads/writes, formatting/pagination,
  denials, Drata, live child custody observations and private-dir/container/network
  cleanup. Real Google/Ubuntu AppArmor remain unverified.
- `node --import ./packages/runner/node_modules/tsx/dist/loader.mjs
scripts/test-gws-browser-cookie.mjs /usr/bin/chromium` and the same command for
  `scripts/test-gws-ingress-browser.mjs`: **pass**, fresh Chromium and shipped
  Nginx/dummy SSO/Google flow; cookie/verified-owner and exact artwork gates retained.

Pi and catalog use the exact cached selectors documented above, with current
host-built artifacts, not image-era source. Logs:
`/tmp/mcp5-corrections-{tests,types,build,fixture-build,pi,catalog,gws,cookie,browser}.log`.
The intent-gap tests reconstruct the exact committed/pre-submit state in real
SQLite; they are not a claim of killing a process at that boundary. The separate
existing process/container SIGKILL gates cover native unsafe effect/result recovery.

One intermediate serial rerun had an unchanged legacy OpenCode entrypoint child
exit after its startup log. Its cause was not established; the unchanged focused
entrypoint test and the complete final serial rerun both pass, with no relaxed
timeout/assertion or unrelated repair. Evidence is retained at
`/tmp/mcp5-corrections-tests-entrypoint-failure.log` and
`/tmp/mcp5-corrections-entrypoint-recheck.log`.

Dummy-only Base/Pi/CI/no-AppArmor and both fixture Compose graphs, changed-file
Prettier, shell/JS syntax, `git diff --check` and independent resource checks pass.
Graphs and graph command/assertions:
`/tmp/mcp5-corrections-compose-*.json`, `/tmp/mcp5-corrections-graphs.sh` and
`/tmp/mcp5-corrections-graphs.log`. Exactly one broker approval mount, broker-only
read-only catalog/tokens, required namespace settings and internal-only/no-host-port
fixture networks remain. Both named projects and GWS/browser fixture containers/
networks have no resources after cleanup. Initial local probes exposed reserved
host request-ID parsing and fixture override/graph spelling mistakes; these were
corrected without weakening assertions or security and followed by passing gates.

Operator Pi docs now describe action-bound redelivery and fail-closed legacy
native inheritance. No new required env/config/deployment surface. All external
gates in the preceding section remain pending: GitHub, actual served models/Slack/
OAuth, Daytona, existing Ubuntu AppArmor/storage/power-loss/deploy and default
cutover/retirement. `.pi` remains untracked and excluded from the amend.
