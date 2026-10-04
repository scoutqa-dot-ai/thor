# Operator MCP HTTP catalog

Phases 2–3 support restart-only custom MCP servers through the existing broker.
Allow-only tools retain the legacy `mcp` wrapper. Custom `approve` uses a versioned
generic operation and the authenticated structured broker edge; CLI attribution
cannot create generic review. Native `mcp_search` / `mcp_call` registration is a
later phase, not installed by Phase 3. `allow` authorizes effects,
not merely reads. Review the provider's business-argument and credential contract:
tools needing credentials in arguments require a dedicated broker adapter.

Catalog aliases cannot adopt/read/resolve records from the shared legacy approval
directory, even if a record was independently planted there. Historical built-in
status remains readable when disabled, but dispatch remains denied.

## Fixed private directories

| Host                          | remote-cli only, read-only |
| ----------------------------- | -------------------------- |
| `docker-volumes/mcp-catalog/` | `/etc/thor/mcp-catalog/`   |
| `docker-volumes/mcp-secrets/` | `/run/secrets/thor-mcp/`   |

The base and Pi Compose stacks share these mounts. Keep them outside the shared
workspace, tmp, repositories and Git. Do not mount them in runner, executor,
OpenCode, gateway, admin, mitmproxy or browser children. There are **no new runtime
environment variables** for catalog locations or custom credentials.

Missing `catalog.json` (including missing/empty optional directories) retains all
six bundled aliases/policies/managed credentials. A present malformed, unreadable,
symlinked or unsupported catalog fails startup **before listen**; no partial overlay
or fallback. **Deleting the whole catalog restores bundled defaults on restart**,
including previously disabled built-ins. For revocation, keep a valid explicit
`disabled` list. Removing one custom definition removes only that custom alias.

Before provisioning tokens, create the host directories. With the standard
container UID/GID 1001:

```bash
sudo install -d -m 0755 docker-volumes/mcp-catalog
sudo install -d -m 0700 -o 1001 -g 1001 docker-volumes/mcp-secrets
```

Token files must be owned by the broker UID, owner-readable 0400 or 0600, with no
group/world/execute/special bits, and one link. The secrets directory must be owned
by that UID, private, readable/searchable (normally 0700). Catalog files/directory must
not be group/world-writable. Directory and token symlinks, nonregular files,
missing/empty/over-16-KiB tokens and unsafe permissions/ownership are rejected.
`secretFile` is a 1–64 character ASCII basename (`[A-Za-z0-9][A-Za-z0-9_-]*`), not a
path. Write tokens through your private operator/secret-store flow, never shell
history, command arguments or workspace files. **Exactly one terminal LF is
removed**; CR/CRLF, embedded LF, whitespace, templates and non-bearer-token bytes
are rejected. Unpadded/padded RFC 6750 bearer token characters are accepted.
Enabled missing credentials never downgrade to unauthenticated access. Disabled
servers' credential files are not read.

## Version 1 example

Write `catalog.json` using atomic file replacement **within the directory mount**:

```json
{
  "version": 1,
  "servers": {
    "mydocs": {
      "transport": "streamable-http",
      "url": "https://mcp.docs.example/mcp",
      "description": "Search team documentation",
      "auth": { "type": "bearer", "secretFile": "mydocs-token" },
      "policy": { "allow": ["search_docs", "fetch_doc"], "approve": [] }
    }
  },
  "disabled": []
}
```

Use `{ "type": "none" }` for unauthenticated HTTPS. Complete custom definitions
add aliases; they cannot shadow bundled aliases, inherit their credentials or
select managed implementations. `disabled` can name only a known bundled/custom
alias and must not repeat names. Aliases use lower-case `[a-z][a-z0-9-]*`, at most
40 characters; prototype names, paths and broker CLI verbs are reserved. Policy
names are exact ASCII tool identifiers, at most 128 characters, starting with a
letter/digit/underscore and continuing with letters/digits/underscore/dot/hyphen.
No wildcard, duplicates, overlap or fuzzy dispatch. Unlisted tools stay hidden.
Maximum 32 custom servers, 128 names per policy list and 256 KiB JSON/depth 32.
Unknown fields, duplicate **decoded** JSON keys, unsupported versions/transports,
headers, executable/env references and interpolation are rejected. Descriptions
are bounded untrusted data, not instructions.

URLs are absolute HTTPS, with no userinfo, query (even empty), fragment, control
characters, whitespace, backslashes or templates. Do not put secrets in URL paths.
Bearer credentials over HTTP are unsupported. For an explicitly operator-reviewed
**internal unauthenticated** fixture/service only, use `auth.type: "none"`, an HTTP
URL and this additional typed contract:

```json
"http": { "type": "internal-unauthenticated", "operatorReviewed": true }
```

That exception accepts single-label internal DNS names, localhost, RFC1918/loopback
IPv4 and IPv6 loopback; public HTTP DNS/IP endpoints are rejected. It is not a
network firewall or proof of DNS placement. Operators own endpoint/network review.
The two existing managed Grafana/Falcon HTTP definitions remain unchanged.

## Validate, connect explicitly, activate

These commands are operator-only (not new agent CLI verbs):

```bash
docker compose exec remote-cli node /app/packages/remote-cli/dist/index.js mcp-catalog schema
docker compose exec remote-cli node /app/packages/remote-cli/dist/index.js mcp-catalog validate
# Explicit network check, inventory only; never invokes a tool:
docker compose exec remote-cli node /app/packages/remote-cli/dist/index.js mcp-catalog check mydocs
```

`schema` generates structural JSON Schema from the owning parser. Duplicate-key,
URL/HTTP, collision/policy and filesystem refinements still require `validate`.
Local validation never connects and prints only presence and active aliases.
`check` has a ten-second whole-check budget, reports bounded status and permitted
names only, and returns nonzero for unavailable/unsupported servers. Neither prints
tokens, credential references, URLs, headers, hidden names or vendor errors. When
the service is stopped, use `docker compose run --rm --no-deps remote-cli node ...`
with the same command; it needs no live integration credentials to validate files.

After validation, drain broker-dependent work, then restart/recreate **remote-cli**.
Subsequent supported additions need no source edit, rebuild or runner restart.
Inspect `/health` status and `mcp --help`, then `mcp mydocs` / tool `--help` via the
existing agent wrapper. Offline servers are individually unavailable, not broker
startup failures. All credential bytes are immutable startup snapshots; replacing
a token file alone does not rotate the active client. Rotate and restart, then
rediscover: every connection revision invalidates old tool references/cursors,
including identical removal/re-addition. No watcher/hot reload exists.

Reconnect revalidates the complete permitted inventory. Missing/duplicate tools,
unsupported assertions and changed permitted input/output schemas/metadata fail
that server closed for the activation; explicitly restart to adopt reviewed drift.
Hidden additions never become permitted. Calls never automatically retry after a
transport error; a dispatched call with an unconfirmed result is **uncertain**.
Removing policy or revoking credentials cannot undo an issued effect. Emergency
revocation may also require revoking the token upstream.

HTTP I/O uses the installed SDK with one endpoint-pinned fetch for initialization,
notifications, calls, SSE/resume and session DELETE. Redirects are refused, including
same-origin redirects. No legacy SSE endpoint selection, OAuth discovery,
resource-URI fetcher or client-selected origins are enabled.
Generic bearer MCP `isError` retains a confirmed error disposition with bounded
text, not vendor fragments. Exact known-token reflection in inventory or a
successful result is unsupported: inventory stays unavailable; a dispatched
result becomes uncertain, without returning the reflected bytes or retrying.
This is a specific credential boundary, not general business-field redaction.

## Generic approval safety contract

Custom `approve` names need no source-defined tool enum and never select specialized
Jira/browser/Google handlers by bare name. Operators must review business-argument
contracts: credentials in tool arguments are unsupported and require a dedicated
adapter, not field-name redaction. Bearer account/scope is service-owned, not proof
of the requesting user's upstream identity.

New generic records and stable fence files live in the broker-only named volume
`mcp-approval-state`, mounted at `/var/lib/remote-cli/mcp-approvals`; directories
are 0700, files 0600, broker-owned. Dockerfile provisions ownership for new volumes.
Version 1 private records use the broker's canonical JSON encoding; manual rewrites,
duplicate fields and decoder-stripped arguments fail closed rather than becoming
weaker proof. Preserve record bytes when backing up/restoring; use the broker to
request fresh review instead of editing pending files.
Do not mount this volume in another service/child or share it through workspace.
Historical `/workspace/data/approvals` remains shared and untouched; it is **not**
private, encrypted or migrated by this feature. Private modes do not erase native
history or make backups encrypted. Keep backup/restore access equally restricted.

One Linux kernel owner fence is held for broker lifetime. A second broker fails
before changing activation or listening. Every successful startup atomically
flushes a fresh activation ID, revoking old generic references/pending approval
authority even with identical aliases, endpoint, schema, policy or secret filename.
Reconnect revisions likewise revoke affected pending authority. Editing credentials
without restart never changes active clients; account replacement/rotation requires
restart and fresh review. Provider-internal principal/behavior changes cannot be
proven by schema equality: restart/reapprove incompatible changes.

Only a host-admitted Slack requester with current workspace/repository/source proof
can review generic operations. GitHub/system/cron and forgeable CLI attributes are
insufficient. The broker confirms its Slack workspace and the requester's private
DM, displays complete effective JSON as plain text (one section, conservative 2800
UTF-16-code-unit budget including heading/repo), or returns `review_not_supported`.
There is no truncated review, public raw payload, caller-selected reviewer/channel,
or generic detailed UI. Private notification intent is durable **before** posting;
missing receipt is uncertain, never an automatic second card for the same host call.

On click the authenticated signed gateway supplies actual user/team/channel/card
evidence, not button routing hints. The broker rechecks original latest request
(including supersession), expiry (15 minutes), private audience, activation,
endpoint/catalog/policy/schema/preparation and live pinned connection before a
durably consumed claim under a stable action lock. It holds that lock through the
dispatch/result window. Atomic record replacement flushes file and directory.
Process loss, transport errors or missing confirmed results leave consumed state
uncertain; approval clicks never automatically redispatch it. Revocation cannot
undo an issued effect. This is tested on Linux local Docker volumes/process crashes,
not universal power-loss, NFS/distributed lease or provider exactly-once proof.

Authenticated reads/list/result projections check stored requester, team, canonical
repo, original source/request/session even for removed servers. CLI returns denial
for generic IDs and excludes generic records from legacy lists; no raw fallback.
Generic result projection is deliberately the minimal completed/tool-error/uncertain
disposition, not raw vendor content. The existing gateway approval continuation
reauthorizes stored scope and routes only to its private DM thread/frozen repo; it
does not create an outbox, task waiter or tool invocation ledger. Pending review is
not successful execution and never instructs the agent to retry the mutation.

Use local volume semantics supporting `flock`, atomic rename and directory `fsync`.
Drain broker work before restart. Do not remove/recreate the state volume to bypass
ownership or resolve uncertainty; investigate effects with the provider/operator.

## Child and container boundary

Broker-owned command children run through fixed integration binaries and reduced
per-integration environments in rootless bubblewrap namespaces; catalog, MCP token
directory, other private broker state and the broker's procfs are absent. Legacy
git/gh retain only their dedicated GitHub key/cache grant; gws receives its private
execution directory and one requester token. Workspace git/GitHub/attachment
workflows remain supported; this is not a claim that a GitHub credential granted
to the legacy GitHub adapter is inaccessible to that adapter. Internal exec admits
only typed git/gh commands in admitted workspace directories, never an arbitrary
executable or shell. Shared Slack block files and cloud sandbox artifact/bundle
uploads are pinned and checked by opened inode, including symlink/race escapes,
before reading. Artifact sync requires regular worktree files (not symlinks)
within its existing size budget; SDK uploads retain the verified descriptor
through completion rather than reopening an agent-swappable path. Binary
contents/destination names remain unchanged.

The browser uses fresh procfs in its child PID namespace rather than binding the
broker's `/proc`. Docker's default masked procfs prevents that rootless mount;
remote-cli alone therefore uses `systempaths=unconfined`, **not** privileged or an
unconfined seccomp profile. It retains the custom seccomp/AppArmor policy, runs as
UID 1001, drops all capabilities and sets no-new-privileges. Keep this configuration
coherent in platform/CI overrides; if namespaces cannot be established, commands
fail, never fall back to an unsandboxed child.

## Isolated acceptance

Prepare current broker artifacts with `pnpm build`, then compile the authority
fixture with `pnpm build:mcp-fixture` using existing pinned dependencies **before**
offline validation. Preparation is separate; the acceptance script never builds.

`pnpm test` includes local filesystem and real SDK/TLS/session cases. The separate
`./scripts/test-mcp-catalog-compose.sh` fixture uses a real broker with current
compiled artifacts, dummy private named volumes, an internal network and no host
ports/deployment data. Supply prebuilt broker/runner/executor image names through
its `MCP_TEST_{BROKER,RUNNER,EXECUTOR,GATEWAY,ADMIN}_IMAGE` test-only selectors;
it never installs/builds/downloads. All four consumer image probes and managed
children check that private records/fences are inaccessible. These are measurement
processes, not a live Pi conversation;
full Pi native discovery/approval acceptance remains a later phase. CI explicitly
prepares images before running that gate. All fixture resources are removed on exit.
