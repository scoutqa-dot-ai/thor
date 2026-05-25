# Falcon MCP Integration

## Goal

Give Thor controlled, read-only access to CrowdStrike Falcon through the existing `remote-cli` MCP policy gateway without exposing Falcon credentials to the OpenCode agent container.

## Scope

- Add a `falcon-mcp` Streamable HTTP service to Docker Compose.
- Register a `falcon` MCP upstream in `packages/common/src/proxies.ts`.
- Start with a read-only allowlist for investigation use cases.
- Update deployment docs, examples, and CI fake env surfaces.
- Verify policy/unit tests locally.

Out of scope for v1:

- Falcon write/destructive actions.
- Human approval schemas for Falcon mutation tools.
- Direct Falcon credentials in OpenCode.

## Phases

### Phase 1 — Compose and policy registry

- Add `falcon-mcp` service using the upstream container image and streamable-http transport.
- Register `falcon` in the proxy registry with read-only tools only.
- Keep `approve` empty until Falcon-specific approval schemas are designed.

Exit: `mcp` upstream discovery includes `falcon`; write-capable Falcon tools stay hidden.

### Phase 2 — Docs and env surfaces

- Update `.env.example`, `README.md`, and CI workflow fake env blocks.
- Document Falcon credentials as mounted only on the `falcon-mcp` service, not `opencode`.

Exit: operators know which env vars to set and agents continue using the existing `mcp` CLI.

### Phase 3 — Verification

- Update affected tests.
- Run targeted unit tests for proxy registry/MCP handling and formatting checks where practical.

Exit: local tests pass.

## Decision Log

| Decision      | Choice                                                       | Rationale                                                                                                                                                  |
| ------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport     | Run Falcon MCP as a separate Streamable HTTP compose service | Thor already proxies Streamable HTTP MCP upstreams from `remote-cli`; this keeps credentials server-side and avoids stdio process management in the agent. |
| v1 access     | Read-only allowlist                                          | Falcon includes mutating/security-sensitive tools; Thor approvals currently have typed schemas only for existing Jira/PostHog writes.                      |
| Modules       | Default to `detections,hosts,intel,spotlight`                | These cover common investigation workflows while avoiding modules with obvious mutation surfaces such as IOC, RTR, firewall, custom IOA, and cases.        |
| Internal auth | Do not enable Falcon MCP HTTP API-key auth in v1             | The service is not published on the host; avoiding optional header plumbing keeps the first integration aligned with existing internal Grafana MCP style.  |

## Exit Criteria

- `falcon` appears in MCP upstream discovery.
- Only read-only Falcon investigation tools are visible through Thor policy.
- Falcon credentials are scoped to the `falcon-mcp` service.
- Tests covering the registry and MCP upstream inventory pass.
