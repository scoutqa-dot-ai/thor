import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { z } from "zod";
import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  appendAlias,
  appendSessionEvent,
  PROXY_REGISTRY,
  McpNativeAuthoritySchema,
  type McpNativeAuthority,
  type McpNativeOperation,
} from "@thor/common";
import { createMcpService, type McpService } from "./mcp-handler.js";
import { registerMcpPrivateRoutes } from "./mcp-private-routes.js";
import { connectUpstream, type UpstreamConnection } from "./upstream.js";

const anchorId = "00000000-0000-7000-8000-000000000201";
const triggerId = "00000000-0000-7000-8000-000000000202";
const context = McpNativeAuthoritySchema.parse({
  sessionId: `pi-${anchorId}`,
  anchorId,
  triggerId,
  requestId: "request-1",
  directory: "/workspace/repos/acme",
  repositoryDirectory: "/workspace/repos/acme",
  requester: { source: "slack", id: "U123" },
  teamId: "T123",
  sourceKey: "slack:thread:C123/1710000000.001",
  taskId: "task-1",
  callId: "call-1",
});
const searchContext = McpNativeAuthoritySchema.parse({
  ...context,
  taskId: "search-task-1",
  callId: "search-call-1",
});
const cli = {
  kind: "cli" as const,
  command: { directory: context.directory, sessionId: context.sessionId },
};
// Retain unknown wire fields so metadata/privacy assertions cannot be masked by test parsing.
// Defaults only simplify test access to absent union fields.
const fixtureHttpResponseSchema = z.looseObject({
  status: z.string().default(""),
  message: z.string().default(""),
  isError: z.boolean().optional(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  exitCode: z.number().default(-1),
  content: z.array(z.looseObject({ type: z.literal("text"), text: z.string() })).default([]),
  value: z
    .looseObject({
      tools: z.array(
        z.looseObject({
          name: z.string(),
          description: z.string().optional(),
          inputSchema: z.record(z.string(), z.unknown()),
          toolRef: z.string(),
        }),
      ),
      servers: z.array(z.looseObject({ server: z.string(), visibleTools: z.number().optional() })),
      cursor: z.string().optional(),
    })
    .default({ tools: [], servers: [] }),
});

const nestedSchema = {
  type: "object" as const,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.example/shared",
  $defs: {
    item: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  properties: {
    items: { type: "array", minItems: 1, uniqueItems: true, items: { $ref: "#/$defs/item" } },
    mode: { enum: ["read", "write"] },
    email: { type: "string", format: "email" },
    note: { type: "string", default: "must-not-be-applied" },
  },
  required: ["items", "mode"],
  dependentRequired: { email: ["note"] },
  unevaluatedProperties: false,
  _meta: { private: "dummy-schema-secret" },
};
const validArgs = { items: [{ id: 1 }], mode: "read" };

async function listen(server: HttpServer): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP fixture address unavailable");
  return `http://127.0.0.1:${address.port}`;
}
async function closeServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// Both wire ends use the installed MCP SDK, including real sessions and list-change notifications.
describe("shared MCP broker through real local SDK HTTP", () => {
  let root: string;
  let upstreamHttp: HttpServer;
  let brokerHttp: HttpServer;
  let brokerUrl: string;
  let service: McpService;
  let inventory: Tool[];
  let effects: { name: string; arguments: Record<string, unknown> | undefined; server: string }[];
  let wireCalls: number;
  let result: CallToolResult;
  let toolResults: Map<string, CallToolResult>;
  let transportFailure: boolean;
  let connections: UpstreamConnection[];
  let audit: unknown[];
  let cards: unknown[];
  let sdkServers: Server[];
  let emptyInventoryPages: number;
  let inventoryPageSize: number;
  let inventoryPages: number;
  let stallInventory: boolean;
  let upstreamStreams: Set<ServerResponse>;
  const originalPolicy = structuredClone(PROXY_REGISTRY);

  function projectCall(
    state: "started" | "ended" = "started",
    authority = context,
    operation: McpNativeOperation = "mcp_call",
  ): void {
    appendSessionEvent(authority.sessionId, {
      type: "tool_call",
      tool: operation,
      callId: authority.callId,
      payload: { nativeMcp: authority, state },
    });
  }
  function admit(authority = context): void {
    for (const aliasType of ["pi.conversation", "opencode.session"] as const)
      appendAlias({ aliasType, aliasValue: authority.sessionId, anchorId: authority.anchorId });
    appendSessionEvent(authority.sessionId, {
      type: "trigger_start",
      triggerId: authority.triggerId,
      correlationKey: authority.sourceKey,
      triggerSlackId: "U123",
      nativeMcp: {
        requestId: authority.requestId,
        directory: authority.directory,
        repositoryDirectory: authority.repositoryDirectory,
        requester: authority.requester,
        teamId: authority.teamId,
        sourceKey: authority.sourceKey,
      },
    });
    projectCall("started", authority);
    projectCall(
      "started",
      McpNativeAuthoritySchema.parse({
        ...authority,
        taskId: searchContext.taskId,
        callId: searchContext.callId,
      }),
      "mcp_search",
    );
  }
  async function post(
    path: string,
    body: unknown,
    secret: string | undefined = "dummy-internal-secret",
  ) {
    const response = await fetch(`${brokerUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-thor-internal-secret": secret } : {}),
        "x-thor-session-id": context.sessionId,
        "x-thor-call-id": context.callId,
      },
      body: JSON.stringify(body),
    });
    return { http: response.status, body: fixtureHttpResponseSchema.parse(await response.json()) };
  }
  async function search(input: unknown = { server: "atlassian", exactName: "getJiraIssue" }) {
    return post("/internal/mcp/search", { context: searchContext, input });
  }
  async function ref(name = "getJiraIssue", server = "atlassian"): Promise<string> {
    const found = await service.describeTool(server, name, cli);
    expect(found.status).toBe("ok");
    if (found.status !== "ok") throw new Error("MCP fixture tool unavailable");
    return found.value.toolRef;
  }
  async function call(toolRef: string, args: unknown = validArgs, authority: unknown = context) {
    return post("/internal/mcp/call", { context: authority, input: { toolRef, arguments: args } });
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "neo-mcp-sdk-"));
    vi.stubEnv("WORKLOG_DIR", join(root, "worklog"));
    vi.stubEnv("ATLASSIAN_AUTH", "dummy-upstream-secret");
    vi.stubEnv("POSTHOG_API_KEY", "dummy-posthog-secret");
    vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "dummy-onepassword-token");
    vi.stubEnv("ONEPASSWORD_BROWSER_VAULT_ID", "aaaaaaaaaaaaaaaaaaaaaaaaaa");
    vi.stubEnv("RUNNER_BASE_URL", "https://neo.example.test");
    effects = [];
    audit = [];
    cards = [];
    connections = [];
    sdkServers = [];
    wireCalls = 0;
    result = { content: [{ type: "text", text: "ok" }] };
    toolResults = new Map();
    transportFailure = false;
    emptyInventoryPages = 0;
    inventoryPageSize = 4;
    inventoryPages = 0;
    stallInventory = false;
    upstreamStreams = new Set();
    inventory = [...PROXY_REGISTRY.atlassian.allow, ...PROXY_REGISTRY.atlassian.approve].map(
      (name) => ({
        name,
        description: `Description of ${name}`,
        inputSchema: name === "getJiraIssue" ? nestedSchema : { type: "object" },
        _meta: { private: "dummy-tool-secret" },
        annotations: { title: "dummy-annotation-secret" },
      }),
    );
    inventory.push({
      name: "hiddenSecretTool",
      inputSchema: { type: "object", unsupportedHiddenAssertion: true },
      outputSchema: { type: "object", unsupportedHiddenAssertion: true },
      description: "dummy-hidden-secret",
    });
    const upstreamApp = express();
    upstreamApp.use(express.json());
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    upstreamApp.all("/mcp", async (req, res) => {
      if (req.method === "GET" || (stallInventory && req.body?.method === "tools/list")) {
        upstreamStreams.add(res);
        res.once("close", () => upstreamStreams.delete(res));
      }
      if (stallInventory && req.body?.method === "tools/list") {
        inventoryPages += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        return;
      }
      if (transportFailure && req.body?.method === "tools/call") {
        wireCalls += 1;
        effects.push({
          name: req.body.params.name,
          arguments: req.body.params.arguments,
          server: "wire",
        });
        res.status(503).end("dummy-vendor-error-secret");
        return;
      }
      const sessionId = req.get("mcp-session-id");
      if (sessionId) {
        const transport = sessions.get(sessionId);
        if (!transport) {
          res.status(404).end();
          return;
        }
        await transport.handleRequest(req, res, req.body);
        return;
      }
      const sdk = new Server(
        { name: "local-fixture", version: "1" },
        { capabilities: { tools: { listChanged: true } } },
      );
      sdkServers.push(sdk);
      sdk.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
        inventoryPages += 1;
        const offset = Number(params?.cursor ?? "0");
        if (offset < emptyInventoryPages) return { tools: [], nextCursor: String(offset + 1) };
        const toolOffset = offset - emptyInventoryPages;
        return {
          tools: inventory.slice(toolOffset, toolOffset + inventoryPageSize),
          ...(toolOffset + inventoryPageSize < inventory.length
            ? { nextCursor: String(offset + inventoryPageSize) }
            : {}),
        };
      });
      sdk.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        wireCalls += 1;
        effects.push({ name: params.name, arguments: params.arguments, server: "wire" });
        return toolResults.get(params.name) ?? result;
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });
      await sdk.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    upstreamHttp = createServer(upstreamApp);
    const upstreamUrl = await listen(upstreamHttp);
    service = createMcpService({
      approvalsDir: join(root, "approvals"),
      writeToolCallLogFn: (entry) => audit.push(entry),
      configLoader: () => ({
        users: [{ email: "alice@example.test", name: "Alice", slack: "U123" }],
      }),
      slack: { botToken: "dummy-slack-token" },
      fetchImpl: async (_url, init) => {
        cards.push(init?.body);
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1710000000.100" }));
      },
      connectUpstreamFn: async (name, _config, disconnected, signal) => {
        const connection = await connectUpstream(
          name,
          {
            kind: "http",
            url: `${upstreamUrl}/mcp`,
            headers: { Authorization: "Bearer dummy-upstream-secret" },
          },
          disconnected,
          signal,
        );
        connections.push(connection);
        return connection;
      },
    });
    const brokerApp = express();
    brokerApp.use(express.json());
    registerMcpPrivateRoutes(brokerApp, service, "dummy-internal-secret");
    // Exercise the legacy adapter with caller-controlled headers/body, just as /exec/mcp does.
    brokerApp.post("/exec/mcp", async (req, res) =>
      res.json(
        await service.executeMcp(req.body.args, {
          directory: req.body.directory,
          sessionId: req.get("x-thor-session-id"),
          callId: req.get("x-thor-call-id"),
        }),
      ),
    );
    brokerHttp = createServer(brokerApp);
    brokerUrl = await listen(brokerHttp);
    admit();
  });
  afterEach(async () => {
    await service?.closeAll();
    await Promise.allSettled(sdkServers.map((sdk) => sdk.close()));
    if (brokerHttp) await closeServer(brokerHttp);
    if (upstreamHttp) await closeServer(upstreamHttp);
    Object.assign(PROXY_REGISTRY, structuredClone(originalPolicy));
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("authenticates transport and every admitted identity/call field independently; no CLI upgrade", async () => {
    const toolRef = await ref();
    const envelope = { context, input: { toolRef, arguments: validArgs } };
    expect((await post("/internal/mcp/call", envelope, "")).http).toBe(401);
    expect((await post("/internal/mcp/call", envelope, "dummy-wrong-secret")).http).toBe(401);
    expect((await post("/internal/mcp/call", { ...envelope, requester: "U123" })).http).toBe(400);
    expect(
      (
        await post("/internal/mcp/call", {
          input: envelope.input,
          context: { kind: "cli", command: cli.command },
        })
      ).http,
    ).toBe(400);
    expect((await post("/internal/mcp/call", { input: envelope.input })).http).toBe(400);
    expect(
      (
        await call(toolRef, validArgs, {
          ...context,
          directory: "/workspace/worktrees/acme/branch",
        })
      ).http,
    ).toBe(400);
    for (const patch of [
      { requester: { source: "slack", id: "U_OTHER" } },
      { requester: { source: "github", id: "other" } },
      { directory: "/workspace/repos/other" },
      { teamId: "T_OTHER" },
      { sourceKey: "cron:other" },
      { taskId: "task-other" },
      { callId: "call-other" },
      { requestId: "request-other" },
      { anchorId: "00000000-0000-7000-8000-000000000203" },
      { triggerId: "00000000-0000-7000-8000-000000000203" },
      { sessionId: "legacy-session" },
    ])
      expect((await call(toolRef, validArgs, { ...context, ...patch })).body.status).toBe("denied");
    projectCall("ended");
    projectCall("ended", searchContext, "mcp_search");
    expect((await call(toolRef)).body.status).toBe("denied");
    expect((await search()).body.status).toBe("denied");
    const legacy = await post(
      "/exec/mcp",
      {
        args: [
          "atlassian",
          "getJiraIssue",
          JSON.stringify({ ...validArgs, _thor_session_id: "forged" }),
        ],
        directory: context.directory,
        context,
      },
      undefined,
    );
    expect(legacy.body.exitCode).toBe(1);
    expect(effects).toEqual([]);
    expect(cards).toEqual([]);
    projectCall();
    expect((await call(toolRef)).body).toMatchObject({ status: "completed", isError: false });
    expect(effects).toHaveLength(1);
  });

  it("binds host proof to the endpoint operation before discovery, dispatch or approval", async () => {
    const toolRef = await ref("createIssueLink");
    // A real allowed mutation, not an invented permission or transport-auth failure.
    expect((await search({ server: "atlassian", exactName: "createIssueLink" })).body.status).toBe(
      "ok",
    );
    expect((await call(toolRef, {}, searchContext)).body.status).toBe("denied");
    expect(
      (
        await post("/internal/mcp/search", {
          context,
          input: { server: "atlassian", exactName: "createIssueLink" },
        })
      ).body.status,
    ).toBe("denied");
    appendSessionEvent(context.sessionId, {
      type: "tool_call",
      tool: "bash",
      callId: context.callId,
      payload: { nativeMcp: context, state: "started" },
    });
    expect((await call(toolRef, {})).body.status).toBe("denied");
    expect(
      (
        await call(
          await ref("createJiraIssue"),
          {
            cloudId: "cloud-1",
            projectKey: "TEST",
            issueTypeName: "Task",
            summary: "must not approve",
          },
          searchContext,
        )
      ).body.status,
    ).toBe("denied");
    expect(effects).toEqual([]);
    expect(cards).toEqual([]);
    expect(connections).toHaveLength(1);
    projectCall();
    expect((await call(toolRef, {})).body.status).toBe("completed");
    expect(effects.map((effect) => effect.name)).toEqual(["createIssueLink"]);
  });

  it("inherits canonical repo authority while checking the full admitted subdirectory", async () => {
    const admitted = McpNativeAuthoritySchema.parse({
      ...context,
      directory: "/workspace/repos/acme/packages/../packages/service",
      triggerId: "00000000-0000-7000-8000-000000000205",
    });
    admit(admitted);
    const discoveryContext = McpNativeAuthoritySchema.parse({
      ...admitted,
      taskId: searchContext.taskId,
      callId: searchContext.callId,
    });
    const found = await post("/internal/mcp/search", {
      context: discoveryContext,
      input: { server: "atlassian", exactName: "getJiraIssue" },
    });
    expect(found.body.status).toBe("ok");
    const toolRef = found.body.value.tools[0].toolRef;
    for (const patch of [
      { directory: "/workspace/repos/acme/packages/other" },
      { directory: "/workspace/repos/acme" },
      { repositoryDirectory: "/workspace/repos/other" },
      { directory: "/workspace/repos/acme/../../etc" },
      { directory: "/workspace/repos/other", repositoryDirectory: "/workspace/repos/other" },
      { repositoryDirectory: "/workspace/repos/acme/packages" },
    ])
      expect((await call(toolRef, validArgs, { ...admitted, ...patch })).body.status).toBe(
        "denied",
      );
    expect(effects).toEqual([]);
    expect((await call(toolRef, validArgs, admitted)).body.status).toBe("completed");
    expect(effects).toHaveLength(1);
  });

  it("rejects absent/ended/superseded native admissions even with otherwise valid references", async () => {
    const toolRef = await ref();
    appendSessionEvent(context.sessionId, { type: "trigger_end", triggerId, status: "completed" });
    expect((await call(toolRef)).body.status).toBe("denied");
    appendSessionEvent(context.sessionId, {
      type: "trigger_start",
      triggerId: "00000000-0000-7000-8000-000000000204",
      correlationKey: context.sourceKey,
      triggerSlackId: "U123",
    });
    expect((await call(toolRef)).body.status).toBe("denied");
    expect((await search()).body.status).toBe("denied");
    expect(effects).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("hides private inventory and validates nested schemas without coercion, defaults or stripping", async () => {
    const discovery = await search();
    expect(discovery.http).toBe(200);
    expect(discovery.body.status).toBe("ok");
    const metadata = JSON.stringify(discovery.body);
    for (const privateValue of [
      "dummy-upstream-secret",
      "dummy-schema-secret",
      "dummy-tool-secret",
      "dummy-annotation-secret",
      "hiddenSecretTool",
    ])
      expect(metadata).not.toContain(privateValue);
    expect(discovery.body.value.tools[0].inputSchema.$defs).toEqual(nestedSchema.$defs);
    const toolRef = await ref();
    for (const args of [
      { items: [{ id: "1" }], mode: "read" },
      { items: [{ id: 0 }], mode: "read" },
      { items: [{ id: 1, extra: true }], mode: "read" },
      { items: [], mode: "read" },
      { items: [{ id: 1 }, { id: 1 }], mode: "read" },
      { ...validArgs, mode: "unknown" },
      { ...validArgs, extra: true },
      { ...validArgs, email: "not-an-email", note: "x" },
      { ...validArgs, email: "alice@example.test" },
    ])
      expect((await call(toolRef, args)).body.status).toBe("invalid_arguments");
    for (const name of ["hiddenSecretTool", "unknown", "getJira"])
      expect((await search({ server: "atlassian", exactName: name })).body.status).toBe("denied");
    expect((await call("atlassian.hiddenSecretTool")).body.status).toBe("stale");
    expect((await call("unknown.random-reference")).body.status).toBe("stale");
    expect(effects).toEqual([]);
    expect(cards).toEqual([]);
    expect((await call(toolRef)).body.status).toBe("completed");
    expect(effects[0].arguments).toEqual(validArgs);
    expect(JSON.stringify(audit)).not.toContain("items");
    expect(JSON.stringify(audit)).not.toContain("ok");
    expect(
      (
        await post("/exec/mcp", {
          args: ["atlassian", "getJiraIssue", JSON.stringify(validArgs)],
          directory: context.directory,
        })
      ).body,
    ).toMatchObject({ stdout: "ok", stderr: "", exitCode: 0 });
  });

  it("reviews draft-07 versus 2020-12 local ref semantics and isolates identical schema IDs", async () => {
    const base = {
      type: "object" as const,
      $id: "https://schemas.example/same-id",
      definitions: { "value/key~id": { type: "string", minLength: 2 } },
      properties: { value: { $ref: "#/definitions/value~1key~0id", maxLength: 3 } },
      required: ["value"],
      additionalProperties: false,
    };
    inventory = inventory.map((tool) =>
      tool.name === "getJiraIssue"
        ? { ...tool, inputSchema: { ...base, $schema: "http://json-schema.org/draft-07/schema#" } }
        : tool.name === "getConfluencePage"
          ? {
              ...tool,
              inputSchema: { ...base, $schema: "https://json-schema.org/draft/2020-12/schema" },
            }
          : tool,
    );
    const oldDraft = await ref();
    const newDraft = await ref("getConfluencePage");
    expect((await call(oldDraft, { value: "longer" })).body.status).toBe("completed");
    expect((await call(newDraft, { value: "longer" })).body.status).toBe("invalid_arguments");
    expect((await call(oldDraft, { value: "x" })).body.status).toBe("invalid_arguments");
    expect((await call(newDraft, { value: "yes" })).body.status).toBe("completed");
    expect(effects).toHaveLength(2);
  });

  it("enforces conditional, combinator, tuple/contains and unevaluated assertions", async () => {
    const schema = {
      type: "object" as const,
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {
        mode: { enum: ["strict", "other"] },
        values: {
          type: "array",
          prefixItems: [{ type: "integer" }],
          items: { type: "string" },
          contains: { const: "yes" },
          minContains: 1,
          maxContains: 1,
        },
        code: {
          oneOf: [
            { type: "integer", multipleOf: 2 },
            { type: "string", pattern: "^OK$" },
          ],
        },
      },
      required: ["mode", "values", "code"],
      if: { properties: { mode: { const: "strict" } } },
      then: { properties: { approved: { const: true } }, required: ["approved"] },
      else: { not: { required: ["approved"] } },
      unevaluatedProperties: false,
    };
    inventory = inventory.map((tool) =>
      tool.name === "getJiraIssue" ? { ...tool, inputSchema: schema } : tool,
    );
    const toolRef = await ref();
    const accepted = { mode: "strict", values: [2, "yes"], code: "OK", approved: true };
    for (const args of [
      { ...accepted, approved: false },
      { mode: "strict", values: [2, "yes"], code: "OK" },
      { ...accepted, mode: "other" },
      { ...accepted, code: 3 },
      { ...accepted, values: ["bad", "yes"] },
      { ...accepted, values: [2, "no"] },
      { ...accepted, values: [2, "yes", "yes"] },
      { ...accepted, extra: 1 },
    ])
      expect((await call(toolRef, args)).body.status).toBe("invalid_arguments");
    expect(effects).toEqual([]);
    expect((await call(toolRef, accepted)).body.status).toBe("completed");
  });

  it("invalidates old references/cursors on reconnect, policy and schema revision changes", async () => {
    const oldRef = await ref();
    const page = await search({ server: "atlassian", limit: 1 });
    expect(page.body.value.cursor).toBeDefined();
    await connections[0].client.close();
    inventory = inventory.map((tool) =>
      tool.name === "getJiraIssue"
        ? { ...tool, inputSchema: { type: "object", required: ["newField"] } }
        : tool,
    );
    expect((await call(oldRef)).body.status).toBe("stale");
    expect(
      (await search({ server: "atlassian", limit: 1, cursor: page.body.value.cursor })).body.status,
    ).toBe("stale");
    const current = await ref();
    expect(current).not.toBe(oldRef);
    PROXY_REGISTRY.atlassian.allow = PROXY_REGISTRY.atlassian.allow.filter(
      (name) => name !== "getJiraIssue",
    );
    expect((await call(current, { newField: true })).body.status).toBe("stale");
    expect((await search()).body.status).toBe("denied");
    expect(effects).toEqual([]);
  });

  it("revokes a live inventory snapshot on real SDK list-change notification before redispatch", async () => {
    const oldRef = await ref();
    await sdkServers[0].sendToolListChanged();
    await vi.waitFor(async () => expect(await ref()).not.toBe(oldRef));
    expect((await call(oldRef)).body.status).toBe("stale");
    expect(effects).toEqual([]);
  });

  it("paginates complete descriptors within count/byte budgets, never exposes hidden counts", async () => {
    inventory = inventory.map((tool) => ({ ...tool, description: "x".repeat(29_000) }));
    let cursor: string | undefined;
    const discovered: string[] = [];
    do {
      const page = await search({ server: "atlassian", limit: 20, ...(cursor ? { cursor } : {}) });
      expect(page.body.status).toBe("ok");
      expect(Buffer.byteLength(JSON.stringify(page.body.value.tools))).toBeLessThanOrEqual(
        256 * 1024,
      );
      expect(page.body.value.servers[0].visibleTools).toBe(inventory.length - 1);
      expect(page.body.value.tools.every((tool) => tool.description?.length === 29_000)).toBe(true);
      discovered.push(...page.body.value.tools.map((tool: { name: string }) => tool.name));
      cursor = page.body.value.cursor;
    } while (cursor);
    expect(new Set(discovered).size).toBe(inventory.length - 1);
    expect(discovered).not.toContain("hiddenSecretTool");
    expect((await search()).body.value.tools[0].name).toBe("getJiraIssue");
  });

  it.each([
    { type: "object" as const, properties: { x: { $ref: "https://private.example/schema" } } },
    { type: "object" as const, properties: { x: { $ref: "#/$defs/missing" } } },
    { type: "object" as const, properties: { x: { unsupportedAssertion: true } } },
    { type: "object" as const, $schema: "https://json-schema.org/draft/2019-09/schema" },
    { type: "object" as const, properties: { x: { $id: "nested", type: "string" } } },
    { type: "object" as const, description: "x".repeat(33_000) },
    {
      type: "object" as const,
      default: { loophole: { $dynamicRef: "#" } },
      properties: { x: { $ref: "#/default/loophole" } },
    },
    {
      type: "object" as const,
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $dynamicAnchor: "root",
    },
  ])("fails unsupported schema inventory closed without effects (case %#)", async (schema) => {
    inventory = inventory.map((tool) =>
      tool.name === "getJiraIssue" ? { ...tool, inputSchema: schema } : tool,
    );
    expect((await search()).body.status).toBe("unavailable");
    expect((await call("atlassian.obsolete")).body.status).toBe("unavailable");
    expect(effects).toEqual([]);
    expect(cards).toEqual([]);
    expect(readdirSync(root)).not.toContain("approvals");
  });

  it("preserves HTTP-200 isError, structured-only and non-text usability, and uncertain transport effects", async () => {
    const toolRef = await ref();
    result = { content: [{ type: "text", text: "Rejected by provider" }], isError: true };
    const failed = await call(toolRef);
    expect(failed).toMatchObject({
      http: 200,
      body: {
        status: "completed",
        isError: true,
        content: [{ type: "text", text: "Rejected by provider" }],
      },
    });
    expect(
      (
        await post("/exec/mcp", {
          args: ["atlassian", "getJiraIssue", JSON.stringify(validArgs)],
          directory: context.directory,
        })
      ).body.exitCode,
    ).toBe(1);
    result = {
      content: [],
      structuredContent: { ticket: { id: 123 } },
      _meta: { secret: "dummy-result-secret" },
    };
    expect((await call(toolRef)).body.content).toEqual([
      { type: "text", text: '{"ticket":{"id":123}}' },
    ]);
    result = {
      content: [
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from("dummy-binary-secret").toString("base64"),
        },
        {
          type: "resource",
          resource: {
            uri: "https://private.example/never-fetch",
            text: "dummy-resource-secret",
            _meta: { secret: "dummy-resource-meta-secret" },
          },
        },
      ],
    };
    const binary = await call(toolRef);
    expect(binary.body.content).toHaveLength(2);
    expect(JSON.stringify(binary.body)).not.toContain("dummy-binary-secret");
    expect(JSON.stringify(binary.body)).not.toContain(
      Buffer.from("dummy-binary-secret").toString("base64"),
    );
    expect(binary.body.content.every((block) => block.text.startsWith("Unsupported MCP"))).toBe(
      true,
    );
    expect(JSON.stringify(binary.body)).not.toContain("private.example");
    const legacy = await post("/exec/mcp", {
      args: ["atlassian", "getJiraIssue", JSON.stringify(validArgs)],
      directory: context.directory,
    });
    expect(JSON.parse(legacy.body.stdout).content[0].type).toBe("image");
    expect(legacy.body.stdout).not.toContain("dummy-resource-meta-secret");
    transportFailure = true;
    const count = wireCalls;
    const uncertain = await call(toolRef);
    expect(uncertain.body.status).toBe("uncertain");
    expect(uncertain.body.message).toContain("Do not retry automatically");
    expect(JSON.stringify(uncertain.body)).not.toContain("dummy-vendor-error-secret");
    expect(wireCalls).toBe(count + 1);
  });

  it("validates structured output with the same SDK dialect contract without retrying a dispatched failure", async () => {
    inventory = inventory.map((tool) =>
      tool.name === "getJiraIssue"
        ? {
            ...tool,
            outputSchema: {
              type: "object",
              $schema: "https://json-schema.org/draft/2020-12/schema",
              $defs: { count: { type: "integer", minimum: 1 } },
              properties: { count: { $ref: "#/$defs/count" } },
              required: ["count"],
              additionalProperties: false,
            },
          }
        : tool,
    );
    const toolRef = await ref();
    result = { content: [], structuredContent: { count: 1 } };
    expect((await call(toolRef)).body.content).toEqual([{ type: "text", text: '{"count":1}' }]);
    result = { content: [], structuredContent: { count: "dummy-invalid-output-secret" } };
    const rejected = await call(toolRef);
    expect(rejected.body.status).toBe("uncertain");
    expect(JSON.stringify(rejected.body)).not.toContain("dummy-invalid-output-secret");
    expect(effects).toHaveLength(2);
  });

  it("retains typed native pending approvals and real SDK Jira attribution/disclaimer preparation", async () => {
    inventory.push({ name: "lookupJiraAccountId", inputSchema: { type: "object" } });
    toolResults.set("lookupJiraAccountId", {
      content: [
        {
          type: "text",
          text: JSON.stringify({ data: { users: { users: [{ accountId: "jira-alice" }] } } }),
        },
      ],
    });
    const toolRef = await ref("createJiraIssue");
    const pending = await call(toolRef, {
      cloudId: "cloud-1",
      projectKey: "NEO",
      issueTypeName: "Task",
      summary: "Fix",
      description: "body",
    });
    expect(pending.http).toBe(200);
    expect(pending.body.status).toBe("pending_approval");
    const stored = await service.executeApproval(["list"]);
    expect(JSON.stringify(pending.body)).not.toContain("approvalEvent");
    expect(JSON.stringify(pending.body)).not.toContain("cliOutput");
    expect(pending.body).not.toHaveProperty("args");
    const actions = z
      .object({ approvals: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(stored.stdout));
    expect(actions.approvals).toHaveLength(1);
    expect(effects).toEqual([]);
    expect(cards).toHaveLength(1);
    const approved = await service.executeMcp(
      ["resolve", actions.approvals[0].id, "approved", "U123"],
      {},
    );
    expect(approved.exitCode).toBe(0);
    expect(effects.map((effect) => effect.name)).toEqual([
      "lookupJiraAccountId",
      "createJiraIssue",
    ]);
    expect(effects[1].arguments).toMatchObject({ assignee_account_id: "jira-alice" });
    expect(effects[1].arguments?.description).toContain(
      `https://neo.example.test/runner/v/${anchorId}/${triggerId}`,
    );
    expect(JSON.stringify(audit)).not.toContain("body");
  });

  it("does not redispatch an approved mutation after a returned uncertain SDK transport outcome", async () => {
    const toolRef = await ref("createJiraIssue");
    expect(
      (
        await call(toolRef, {
          projectKey: "NEO",
          issueTypeName: "Task",
          summary: "Fix",
          description: "body",
        })
      ).body.status,
    ).toBe("pending_approval");
    const stored = await service.executeApproval(["list"]);
    const actions = z
      .object({ approvals: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(stored.stdout));
    const args = ["resolve", actions.approvals[0].id, "approved", "U123"];
    transportFailure = true;
    const failed = await service.executeMcp(args, {});
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("outcome is uncertain");
    expect(await service.executeMcp(args, {})).toEqual(failed);
    expect(effects.map((effect) => effect.name)).toEqual(["createJiraIssue"]);
  });

  it("retains real SDK browser login preflight, trusted outbound context and single-use approval", async () => {
    const policy = PROXY_REGISTRY["onepassword-browser"];
    inventory = [...policy.allow, ...policy.approve, "_resolve_login_plan"].map((name) => ({
      name,
      inputSchema: { type: "object" },
    }));
    const loginPlan = {
      login_plan_id: "00000000-0000-4000-8000-000000000211",
      item_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
      title: "Fixture login",
      application_origin: "https://app.example.test",
      credential_origin: "https://login.example.test",
      callback_origin: "https://app.example.test",
    };
    toolResults.set("_resolve_login_plan", {
      content: [{ type: "text", text: JSON.stringify(loginPlan) }],
    });
    const toolRef = await ref("browser_open_authenticated", "onepassword-browser");
    const pending = await call(toolRef, {
      login_plan_id: loginPlan.login_plan_id,
      item_id: loginPlan.item_id,
    });
    expect(pending.body.status).toBe("pending_approval");
    expect(effects.map((effect) => effect.name)).toEqual(["_resolve_login_plan"]);
    const stored = await service.executeApproval(["list"]);
    const actions = z
      .object({ approvals: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(stored.stdout));
    const actionId = actions.approvals[0].id;
    expect((await service.executeMcp(["resolve", actionId, "approved", "U123"], {})).exitCode).toBe(
      0,
    );
    expect(effects[1]).toMatchObject({
      name: "browser_open_authenticated",
      arguments: {
        _approved_item_title: "Fixture login",
        _thor_session_id: context.sessionId,
        automate_totp: false,
      },
    });
    await service.executeMcp(["resolve", actionId, "approved", "U123"], {});
    expect(effects).toHaveLength(2);
  });

  it.each(["confirmed_error", "transport_unknown"] as const)(
    "durably retains browser %s without redispatch after reconstruction",
    async (disposition) => {
      const policy = PROXY_REGISTRY["onepassword-browser"];
      inventory = [...policy.allow, ...policy.approve, "_resolve_login_plan"].map((name) => ({
        name,
        inputSchema: { type: "object" },
      }));
      const loginPlan = {
        login_plan_id: "00000000-0000-4000-8000-000000000211",
        item_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
        title: "Fixture login",
        application_origin: "https://app.example.test",
        credential_origin: "https://login.example.test",
        callback_origin: "https://app.example.test",
      };
      toolResults.set("_resolve_login_plan", {
        content: [{ type: "text", text: JSON.stringify(loginPlan) }],
      });
      const pending = await call(await ref("browser_open_authenticated", "onepassword-browser"), {
        login_plan_id: loginPlan.login_plan_id,
        item_id: loginPlan.item_id,
      });
      expect(pending.body.status).toBe("pending_approval");
      const actionId = z.object({ actionId: z.string() }).parse(pending.body).actionId;
      toolResults.set("browser_open_authenticated", {
        isError: true,
        content: [{ type: "text", text: "Known provider rejection" }],
      });
      transportFailure = disposition === "transport_unknown";
      const first = await service.executeMcp(["resolve", actionId, "approved", "U123"], {});
      expect(first.exitCode).toBe(1);
      if (disposition === "confirmed_error") {
        expect(first.stdout).toContain("Known provider rejection");
        expect(first.stderr).toBe("");
      } else {
        expect(first.stderr).toContain("outcome is uncertain");
        expect(first.stderr).toContain("Do not retry automatically");
      }
      const replay = await service.executeMcp(["resolve", actionId, "approved", "U123"], {});
      if (disposition === "confirmed_error") expect(replay).toEqual(first);
      else
        expect(replay).toMatchObject({
          stdout: "",
          exitCode: 1,
          stderr: expect.stringContaining("outcome is unknown and must not be retried"),
        });
      await service.closeAll();
      let reconnects = 0;
      service = createMcpService({
        approvalsDir: join(root, "approvals"),
        connectUpstreamFn: async () => {
          reconnects += 1;
          throw new Error("Consumed fixture must not reconnect");
        },
      });
      expect(await service.executeMcp(["resolve", actionId, "approved", "U123"], {})).toEqual(
        replay,
      );
      const status = await service.executeApproval(["status", actionId]);
      expect(JSON.parse(status.stdout)).toMatchObject({ status: "approved", result: replay });
      expect(reconnects).toBe(0);
      expect(effects.map((effect) => effect.name)).toEqual([
        "_resolve_login_plan",
        "browser_open_authenticated",
      ]);
    },
  );

  it.each([2050, Infinity])(
    "bounds %s empty unique inventory pages without leaking hidden inventory or effects",
    async (pages) => {
      emptyInventoryPages = pages;
      inventoryPageSize = inventory.length;
      const found = await search();
      expect(found.body.status).toBe("unavailable");
      expect(inventoryPages).toBe(128);
      expect(found.body.value.tools).toEqual([]);
      expect(JSON.stringify(found.body)).not.toContain("hiddenSecretTool");
      expect(JSON.stringify(found.body)).not.toContain("dummy-hidden-secret");
      expect(service.getHealth()).toMatchObject({ connected: 0 });
      expect(connections).toEqual([]);
      await vi.waitFor(() => expect(upstreamStreams.size).toBe(0));
      await service.closeAll();
      expect(inventoryPages).toBe(128);
      expect(effects).toEqual([]);
      expect(cards).toEqual([]);
    },
  );

  it("accepts a complete inventory at the page bound, including preceding empty pages", async () => {
    emptyInventoryPages = 127;
    inventoryPageSize = inventory.length;
    expect((await search()).body.status).toBe("ok");
    expect(inventoryPages).toBe(128);
    expect(effects).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("cancels a stalled SDK inventory and closes live streams before broker shutdown returns", async () => {
    stallInventory = true;
    const pending = search();
    await vi.waitFor(() => expect(inventoryPages).toBe(1));
    expect(upstreamStreams.size).toBeGreaterThan(0);
    await service.closeAll();
    expect((await pending).body.status).toBe("unavailable");
    await vi.waitFor(() => expect(upstreamStreams.size).toBe(0));
    expect(service.getHealth()).toMatchObject({ connected: 0 });
    expect(connections).toEqual([]);
    expect(inventoryPages).toBe(1);
    expect(effects).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("rejects missing policy inventory and duplicate names without dispatch or approval", async () => {
    inventory = inventory.filter((tool) => tool.name !== "createJiraIssue");
    expect((await search()).body.status).toBe("unavailable");
    inventory.push({ name: "createJiraIssue", inputSchema: { type: "object" } });
    inventory.push(inventory[0]);
    expect((await search()).body.status).toBe("unavailable");
    expect(effects).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("cannot run specialized browser/Jira hooks for same bare names on another server", async () => {
    PROXY_REGISTRY.posthog.allow = [
      "browser_open_authenticated",
      "find_login_items",
      "createJiraIssue",
      "post_message",
    ];
    PROXY_REGISTRY.posthog.approve = [];
    inventory = PROXY_REGISTRY.posthog.allow.map((name) => ({
      name,
      inputSchema: { type: "object" },
    }));
    for (const name of PROXY_REGISTRY.posthog.allow) {
      const toolRef = await ref(name, "posthog");
      expect((await call(toolRef, { original: true })).body.status).toBe("completed");
    }
    expect(effects.map((effect) => effect.name)).toEqual(PROXY_REGISTRY.posthog.allow);
    expect(
      effects.every((effect) => JSON.stringify(effect.arguments) === '{"original":true}'),
    ).toBe(true);
    expect(cards).toEqual([]);
  });
});
