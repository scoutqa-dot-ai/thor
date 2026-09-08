# Kali MCP EC2 Integration

## Goal

Let Thor use an operator-hosted Kali MCP/API server on EC2 through the existing `remote-cli` MCP policy gateway, without exposing direct network or execution control to the OpenCode agent outside the controlled `mcp` wrapper.

## Scope

- Register a `kali` MCP upstream in the proxy registry.
- Bridge the upstream Kali HTTP API exposed by `kali-server-mcp` into Thor's MCP command surface.
- Add an environment variable for the EC2 Kali API base URL.
- Add agent-facing guidance for using the Kali tools only on authorized targets.
- Update docs, compose, CI env surfaces, and targeted tests.

Out of scope for v1:

- Running a Kali container or Kali MCP service inside Thor compose.
- SSH tunneling or EC2 host provisioning.
- Human approval schemas for Kali commands.
- Per-target allowlists for penetration-testing scope.

## Phases

### Phase 1 — Registry and API bridge

- Add a `kali` proxy entry with official `mcp-kali-server` tool names.
- Add a custom Kali API connector for the official Flask API server shape.
- Keep the existing `mcp` wrapper and policy flow.

Exit: `mcp kali` lists Kali tools and `mcp kali server_health '{}'` can call the configured EC2 Kali API.

### Phase 2 — Docs and env surfaces

- Update `.env.example`, `docker-compose.yml`, README, CI fake env blocks, and agent skill docs.

Exit: operators know to set the EC2 Kali API URL and agents know the supported `mcp kali` command shape.

### Phase 3 — Verification

- Add/update behavior tests for registry, interpolation, custom bridge calls, and warm-up inventory.
- Run targeted unit tests/typecheck where practical.

Exit: targeted tests pass locally.

## Decision Log

| Decision    | Choice                                                 | Rationale                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport   | Custom remote-cli bridge to the official Kali HTTP API | The Kali package's `mcp-server` bridge is stdio-oriented, while Thor already brokers Streamable HTTP MCP upstreams from `remote-cli`; bridging the documented EC2 API shape avoids installing/running a separate stdio process. |
| Tool policy | Allow official Kali tools, including `execute_command` | Raw command execution is the package's core feature and the user's requested EC2 server is operator-hosted; Thor does not yet have typed approval schemas for Kali commands.                                                    |
| Deployment  | Configure only the EC2 API base URL in `remote-cli`    | No Kali service is added to compose, keeping EC2 ownership outside Thor and avoiding direct credentials in OpenCode.                                                                                                            |

## Exit Criteria

- `kali` appears in MCP upstream discovery.
- Kali tool calls route through `remote-cli` to `KALI_API_BASE_URL`.
- OpenCode continues to use only the existing `mcp` wrapper.
- Docs and env surfaces are updated.
- Targeted tests pass.
