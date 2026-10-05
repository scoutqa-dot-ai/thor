import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { once } from "node:events";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  readdirSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  appendAlias,
  appendSessionEvent,
  sessionLogPath,
  McpNativeAuthoritySchema,
  McpToolRefSchema,
  McpApprovalProjectionSchema,
  findLatestMcpApprovalProjection,
  SlackReplyAdmissionSchema,
  mintAnchor,
  PROXY_NAMES,
  type McpNativeAuthority,
} from "@thor/common";
import { ApprovalStore } from "./approval-store.js";
import { createMcpService, type McpService } from "./mcp-handler.js";
import { McpApprovalOwner } from "./mcp-approval-owner.js";
import { loadMcpCatalogSnapshot } from "./mcp-catalog-files.js";
import { registerMcpPrivateRoutes } from "./mcp-private-routes.js";
import { createRequire } from "node:module";
const loader = createRequire(createRequire(import.meta.url).resolve("tsup")).resolve("tsx");

async function listen(server: HttpServer) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: HttpServer) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
const reply = z.looseObject({
  status: z.string(),
  actionId: z.string().optional(),
  value: z.unknown().optional(),
});

// Installed MCP SDK on both ends, real Slack HTTP, real worklog, files and flock subprocesses.
describe("private generic MCP review and durable dispatch", { timeout: 30_000 }, () => {
  let root: string, endpoint: string, slackUrl: string, brokerUrl: string;
  let upstream: HttpServer, slack: HttpServer, broker: HttpServer;
  let service: McpService;
  let authority: McpNativeAuthority;
  let tools: Tool[], sdks: Server[];
  let effects: unknown[], cards: Record<string, unknown>[];
  let callsHeld: (() => void)[], receiptsHeld: ServerResponse[];
  let holdCalls: boolean,
    loseReceipt: boolean,
    rejectPost: boolean,
    badPrivate: boolean,
    toolError: boolean,
    transportError: boolean;
  let children: ChildProcess[];
  let caRoot: string, caBefore: string[], tls: { key: Buffer; cert: Buffer };
  let bearerCalls: string[];
  const input = { text: "dummy-private-business-argument" };
  const schema = {
    type: "object" as const,
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  };
  function writeCatalog(
    policy: { allow: string[]; approve: string[] } = { allow: [], approve: ["createJiraIssue"] },
    enabled = true,
  ) {
    const value = {
      version: 1,
      disabled: [...PROXY_NAMES],
      servers: enabled
        ? {
            docs: {
              transport: "streamable-http",
              description: "Private fixture business mutation",
              url: endpoint,
              auth: { type: "bearer", secretFile: "docs-token" },
              policy,
            },
          }
        : {},
    };
    const path = join(root, "catalog/catalog.json");
    writeFileSync(path + ".next", JSON.stringify(value));
    renameSync(path + ".next", path);
  }
  function admit(
    context = authority,
    delivery: NonNullable<ReturnType<typeof findLatestMcpApprovalProjection>>["delivery"] | null = {
      owner: "tool",
    },
  ) {
    for (const aliasType of ["pi.conversation", "opencode.session"] as const)
      appendAlias({ aliasType, aliasValue: context.sessionId, anchorId: context.anchorId });
    appendSessionEvent(context.sessionId, {
      type: "trigger_start",
      triggerId: context.triggerId,
      correlationKey: context.sourceKey,
      ...(delivery ? { nativeMcpDelivery: delivery } : {}),
      ...(context.requester.source === "slack"
        ? { triggerSlackId: context.requester.id }
        : { triggerGithubLogin: "fixture" }),
      nativeMcp: {
        requestId: context.requestId,
        directory: context.directory,
        repositoryDirectory: context.repositoryDirectory,
        requester: context.requester,
        teamId: context.teamId,
        sourceKey: context.sourceKey,
      },
    });
    projectCall(context);
  }
  function projectCall(context = authority) {
    appendSessionEvent(context.sessionId, {
      type: "tool_call",
      callId: context.callId,
      tool: "mcp_call",
      payload: { nativeMcp: context, state: "started" },
    });
  }
  async function start() {
    const ownership = await McpApprovalOwner.acquire(join(root, "generic"));
    if (!ownership.ok) throw new Error("fixture state owned");
    const loaded = loadMcpCatalogSnapshot({
      catalogDirectory: join(root, "catalog"),
      secretsDirectory: join(root, "secrets"),
    });
    if (!loaded.ok) throw new Error("fixture catalog invalid");
    service = createMcpService({
      catalog: loaded.value,
      genericApprovalOwner: ownership.value,
      approvalsDir: join(root, "legacy"),
      writeToolCallLogFn: () => undefined,
      slack: { botToken: "dummy-slack-token", apiBaseUrl: slackUrl },
    });
    const app = express();
    app.use(express.json());
    registerMcpPrivateRoutes(app, service, "dummy-internal-secret");
    broker = createServer(app);
    brokerUrl = await listen(broker);
  }
  async function restart() {
    await service.closeAll();
    await close(broker);
    await start();
  }
  async function post(
    path: string,
    body: unknown,
    secret = "dummy-internal-secret",
    url = brokerUrl,
  ) {
    const response = await fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-thor-internal-secret": secret },
      body: JSON.stringify(body),
    });
    return { http: response.status, body: reply.parse(await response.json()) };
  }
  async function toolRef() {
    const found = await service.describeTool("docs", "createJiraIssue", {
      kind: "cli",
      command: { directory: authority.directory },
    });
    if (found.status !== "ok") throw new Error("fixture tool missing");
    return found.value.toolRef;
  }
  async function request(args = input, context = authority, url = brokerUrl, ref?: string) {
    const found = ref ?? (await toolRef());
    const result = await post(
      "/internal/mcp/call",
      { context, input: { toolRef: found, arguments: args } },
      "dummy-internal-secret",
      url,
    );
    return result.body;
  }
  function click(actionId: string, overrides = {}) {
    return {
      actionId,
      decision: "approved",
      userId: "U123",
      teamId: "T123",
      channel: "D123",
      messageTs: "1710000000.123",
      ...overrides,
    };
  }
  function reader(overrides = {}) {
    return {
      requester: authority.requester,
      teamId: authority.teamId,
      repositoryDirectory: authority.repositoryDirectory,
      sourceKey: authority.sourceKey,
      requestId: authority.requestId,
      sessionId: authority.sessionId,
      ...overrides,
    };
  }
  async function pending() {
    const result = await request();
    expect(result.status).toBe("pending_approval");
    if (!result.actionId) throw new Error("missing action");
    return result.actionId;
  }
  function store() {
    return new ApprovalStore(join(root, "generic"), "genericMcp");
  }
  function loadedRecord(id: string) {
    const record = store().getGeneric(id);
    if (!record) throw new Error("fixture generic record missing");
    return record;
  }

  async function waitFor(predicate: () => boolean) {
    for (let i = 0; i < 500; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("fixture readiness");
  }

  async function childBroker() {
    await service.closeAll();
    await close(broker);
    const code = `
      import express from ${JSON.stringify(createRequire(import.meta.url).resolve("express"))}; import { createServer } from 'node:http';
      import { McpApprovalOwner } from './packages/remote-cli/src/mcp-approval-owner.ts';
      import { loadMcpCatalogSnapshot } from './packages/remote-cli/src/mcp-catalog-files.ts';
      import { createMcpService } from './packages/remote-cli/src/mcp-handler.ts';
      import { registerMcpPrivateRoutes } from './packages/remote-cli/src/mcp-private-routes.ts';
      const owner=await McpApprovalOwner.acquire(${JSON.stringify(join(root, "generic"))});if(!owner.ok)process.exit(2);
      const snapshot=loadMcpCatalogSnapshot({catalogDirectory:${JSON.stringify(join(root, "catalog"))},secretsDirectory:${JSON.stringify(join(root, "secrets"))}});if(!snapshot.ok)process.exit(3);
      const service=createMcpService({catalog:snapshot.value,genericApprovalOwner:owner.value,approvalsDir:${JSON.stringify(join(root, "legacy"))},writeToolCallLogFn:()=>{},slack:{botToken:'dummy-slack-token',apiBaseUrl:${JSON.stringify(slackUrl)}}});
      const found=await service.describeTool('docs','createJiraIssue',{kind:'cli',command:{directory:'/workspace/repos/fixture'}});if(found.status!=='ok')process.exit(4);
      const app=express();app.use(express.json());registerMcpPrivateRoutes(app,service,'dummy-internal-secret');const server=createServer(app);server.listen(0,'127.0.0.1',()=>{process.stdout.write('READY '+JSON.stringify({port:server.address().port,ref:found.value.toolRef})+'\\n')});`;
    const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", code], {
      env: {
        ...process.env,
        WORKLOG_DIR: join(root, "worklog"),
        NODE_EXTRA_CA_CERTS: join(caRoot, "cert.pem"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "",
      error = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      error += chunk;
    });
    await waitFor(() => output.includes("READY ") || child.exitCode !== null);
    if (!output.includes("READY ")) throw new Error(error);
    const ready = z
      .object({ port: z.number(), ref: z.string() })
      .parse(JSON.parse(output.split("READY ")[1].split("\n")[0]));
    return { child, url: `http://127.0.0.1:${ready.port}`, ref: ready.ref };
  }
  async function kill(child: ChildProcess) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }

  beforeAll(() => {
    caRoot = mkdtempSync(join(tmpdir(), "neo-approval-ca-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(caRoot, "key.pem"),
        "-out",
        join(caRoot, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    tls = {
      key: readFileSync(join(caRoot, "key.pem")),
      cert: readFileSync(join(caRoot, "cert.pem")),
    };
    caBefore = getCACertificates("default");
    setDefaultCACertificates([...caBefore, tls.cert.toString()]);
  });
  afterAll(() => {
    setDefaultCACertificates(caBefore);
    rmSync(caRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "neo-generic-approval-"));
    mkdirSync(join(root, "catalog"));
    mkdirSync(join(root, "secrets"), { mode: 0o700 });
    vi.stubEnv("WORKLOG_DIR", join(root, "worklog"));
    sdks = [];
    effects = [];
    cards = [];
    callsHeld = [];
    receiptsHeld = [];
    children = [];
    bearerCalls = [];
    writeFileSync(join(root, "secrets/docs-token"), "dummy-account-a-token", { mode: 0o600 });
    holdCalls = false;
    loseReceipt = false;
    rejectPost = false;
    badPrivate = false;
    toolError = false;
    transportError = false;
    const anchorId = mintAnchor();
    authority = McpNativeAuthoritySchema.parse({
      sessionId: `pi-${anchorId}`,
      anchorId,
      triggerId: mintAnchor(),
      requestId: "fixture-request",
      directory: "/workspace/repos/fixture",
      repositoryDirectory: "/workspace/repos/fixture",
      requester: { source: "slack", id: "U123" },
      teamId: "T123",
      sourceKey: "slack:thread:C123/1710000000.001",
      taskId: "fixture-task",
      callId: "fixture-call",
    });
    tools = [{ name: "createJiraIssue", inputSchema: schema }];
    const app = express();
    app.use(express.json());
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    app.all("/mcp", async (req, res) => {
      if (req.body?.method === "tools/call") bearerCalls.push(req.get("authorization") ?? "");
      if (transportError && req.body?.method === "tools/call") {
        effects.push(req.body.params);
        res.destroy();
        return;
      }
      const id = req.get("mcp-session-id");
      if (id) {
        const transport = sessions.get(id);
        if (!transport) {
          res.status(404).end();
          return;
        }
        await transport.handleRequest(req, res, req.body);
        return;
      }
      const sdk = new Server(
        { name: "generic-fixture", version: "1" },
        { capabilities: { tools: { listChanged: true } } },
      );
      sdks.push(sdk);
      sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      sdk.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        effects.push(params);
        if (holdCalls) await new Promise<void>((resolve) => callsHeld.push(resolve));
        return {
          isError: toolError,
          content: [{ type: "text", text: "dummy-private-vendor-result" }],
        };
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
    upstream = createTlsServer(tls, app);
    endpoint = (await listen(upstream)).replace("http://127.0.0.1", "https://localhost") + "/mcp";
    const slackApp = express();
    slackApp.use(express.json());
    slackApp.post("/:method", (req, res) => {
      expect(req.get("authorization")).toBe("Bearer dummy-slack-token");
      switch (req.params.method) {
        case "auth.test":
          res.json({ ok: true, team_id: "T123" });
          break;
        case "conversations.open":
          expect(req.body.users).toBe("U123");
          res.json({ ok: true, channel: { id: "D123" } });
          break;
        case "conversations.info":
          res.json({ ok: true, channel: { id: "D123", is_im: !badPrivate, user: "U123" } });
          break;
        case "chat.postMessage":
          cards.push(req.body);
          if (rejectPost) res.json({ ok: false });
          else if (loseReceipt) receiptsHeld.push(res);
          else res.json({ ok: true, channel: "D123", ts: "1710000000.123" });
          break;
        case "chat.update":
          res.json({ ok: true });
          break;
        default:
          res.json({ ok: false });
      }
    });
    slack = createServer(slackApp);
    slackUrl = await listen(slack);
    writeCatalog();
    admit();
    await start();
  });
  afterEach(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) await kill(child);
    callsHeld.forEach((resolve) => resolve());
    receiptsHeld.forEach((res) => res.destroy());
    await service.closeAll();
    await close(broker);
    await Promise.allSettled(sdks.map((sdk) => sdk.close()));
    await close(upstream);
    await close(slack);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("reviews full business arguments privately and dispatches same-named custom tools without Jira hooks, exactly once", async () => {
    const id = await pending();
    expect(cards).toHaveLength(1);
    expect(cards[0].channel).toBe("D123");
    expect(JSON.stringify(cards[0])).toContain(input.text);
    expect(effects).toHaveLength(0);
    expect(JSON.stringify(store().getGeneric(id))).not.toContain("dummy-slack-token");
    appendSessionEvent(authority.sessionId, {
      type: "tool_call",
      tool: "mcp_call",
      callId: authority.callId,
      payload: { nativeMcp: authority, state: "ended" },
    });
    appendSessionEvent(authority.sessionId, {
      type: "trigger_end",
      triggerId: authority.triggerId,
      status: "completed",
    });
    const resolved = await post("/internal/mcp/approvals/resolve", click(id));
    expect(McpApprovalProjectionSchema.parse(resolved.body.value).disposition).toBe("completed");
    expect(effects).toEqual([{ name: "createJiraIssue", arguments: input }]);
    expect(JSON.stringify(resolved)).not.toContain("dummy-private-vendor-result");
    expect(JSON.stringify(resolved)).not.toContain(input.text);
    await post("/internal/mcp/approvals/resolve", click(id));
    expect(effects).toHaveLength(1);
    for (const [path, mode] of [
      [join(root, "generic"), 0o700],
      [join(root, "generic/owner.lock"), 0o600],
      [join(root, "generic", loadedRecord(id).dateSegment, id + ".json"), 0o600],
    ] as const)
      expect(statSync(path).mode & 0o7777).toBe(mode);
  });
  it.each([
    { log: "session", tail: '{"type":"trigger_start","triggerId":"' },
    { log: "session", tail: '{"type":"trigger_start"\n' },
    { log: "session", tail: '{"type":"trigger_start"}\n' },
    { log: "aliases", tail: '{"aliasType":"pi.conversation","aliasValue":"' },
    { log: "aliases", tail: '{"aliasType":"pi.conversation"\n' },
    { log: "aliases", tail: '{"aliasType":"pi.conversation"}\n' },
    {
      log: "session",
      tail: '{"schemaVersion":1,"ts":"fixture","type":"tool_call","tool":"other","payload":{}}',
    },
    {
      log: "aliases",
      tail: '{"ts":"fixture","aliasType":"git.branch","aliasValue":"other","anchorId":"00000000-0000-7000-8000-000000000201"}',
    },
    {
      log: "session",
      tail: Buffer.concat([
        Buffer.from(
          '{"schemaVersion":1,"ts":"fixture","type":"tool_call","tool":"other","payload":"',
        ),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}\n'),
      ]),
    },
    {
      log: "aliases",
      tail: Buffer.concat([
        Buffer.from('{"ts":"fixture","aliasType":"git.branch","aliasValue":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('","anchorId":"00000000-0000-7000-8000-000000000201"}\n'),
      ]),
    },
  ])(
    "authenticated native calls and generic clicks fail closed on incomplete/malformed $log evidence: $tail",
    async ({ log, tail }) => {
      const ref = await toolRef();
      const search = McpNativeAuthoritySchema.parse({
        ...authority,
        taskId: "search-task",
        callId: "search-call",
      });
      appendSessionEvent(authority.sessionId, {
        type: "tool_call",
        tool: "mcp_search",
        callId: search.callId,
        payload: { nativeMcp: search, state: "started" },
      });
      expect(
        (await post("/internal/mcp/search", { context: search, input: { server: "docs" } })).body
          .status,
      ).toBe("ok");
      const id = await pending();
      const path =
        log === "session"
          ? sessionLogPath(authority.sessionId)
          : join(root, "worklog/aliases.jsonl");
      appendFileSync(path, tail);
      const evidence = readFileSync(path);
      const resolved = await post("/internal/mcp/approvals/resolve", click(id));
      expect(McpApprovalProjectionSchema.parse(resolved.body.value).disposition).toBe("rejected");
      expect((await request(input, authority, brokerUrl, ref)).status).toBe("denied");
      await post("/internal/mcp/approvals/resolve", click(id));
      expect(
        (await post("/internal/mcp/search", { context: search, input: { server: "docs" } })).body
          .status,
      ).toBe("denied");
      expect(effects).toHaveLength(0);
      expect(cards).toHaveLength(1);
      expect(loadedRecord(id).dispatch.status).toBe("rejected");
      expect(readFileSync(path)).toEqual(evidence);
    },
  );

  it("valid final JSON cannot authorize a native call until newline committed; complete tails still approve normally", async () => {
    const ref = await toolRef();
    const path = sessionLogPath(authority.sessionId);
    appendFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        ts: new Date().toISOString(),
        type: "tool_call",
        tool: "other",
        payload: "é🙂",
      }),
    );
    expect((await request(input, authority, brokerUrl, ref)).status).toBe("denied");
    expect(cards).toHaveLength(0);
    expect(effects).toHaveLength(0);
    appendFileSync(path, "\n");
    const id = await pending();
    expect(
      McpApprovalProjectionSchema.parse(
        (await post("/internal/mcp/approvals/resolve", click(id))).body.value,
      ).disposition,
    ).toBe("completed");
    expect(effects).toEqual([{ name: "createJiraIssue", arguments: input }]);
    expect(cards).toHaveLength(1);
  });

  it("retains failed private publication intent and never automatically duplicates a card", async () => {
    rejectPost = true;
    expect((await request()).status).toBe("uncertain");
    expect((await request()).status).toBe("uncertain");
    expect(cards).toHaveLength(1);
    const action = store().listGeneric()[0];
    expect(action.notification.status).toBe("uncertain");
    expect((await post("/internal/mcp/approvals/resolve", click(action.id))).body.status).toBe(
      "denied",
    );
    expect(effects).toHaveLength(0);
  });

  it.each(["C123", "D_OTHER", null])(
    "broker rejects unsupported/missing frozen host audience %s and ignores caller delivery hints",
    async (channel) => {
      admit(
        authority,
        channel
          ? {
              owner: "host",
              target: SlackReplyAdmissionSchema.parse({
                version: 1,
                teamId: "T123",
                channel,
                threadTs: "1710000000.001",
              }),
            }
          : null,
      );
      expect((await request()).status).toBe("review_not_supported");
      const hinted = await post("/internal/mcp/call", {
        context: { ...authority, nativeMcpDelivery: { owner: "tool" } },
        input: { toolRef: await toolRef(), arguments: input },
      });
      expect(hinted.body.status).toBe("denied");
      expect(cards).toHaveLength(0);
      expect(effects).toHaveLength(0);
      expect(store().listGeneric()).toHaveLength(0);
    },
  );

  it("same task/call retains its pending review, but distinct calls cannot create another operation even after resolution or restart", async () => {
    const id = await pending();
    expect(await request()).toMatchObject({ status: "pending_approval", actionId: id });
    const siblings = [
      McpNativeAuthoritySchema.parse({ ...authority, callId: "another-call" }),
      McpNativeAuthoritySchema.parse({ ...authority, taskId: "another-task" }),
    ];
    for (const sibling of siblings) {
      projectCall(sibling);
      expect(await request(input, sibling)).toMatchObject({ status: "denied" });
    }
    expect(cards).toHaveLength(1);
    expect(effects).toHaveLength(0);
    await post("/internal/mcp/approvals/resolve", click(id));
    for (const sibling of siblings) expect((await request(input, sibling)).status).toBe("denied");
    await restart();
    expect((await request(input, siblings[0])).status).toBe("denied");
    expect(store().listGeneric()).toHaveLength(1);
    expect(cards).toHaveLength(1);
    expect(effects).toHaveLength(1);
    authority = McpNativeAuthoritySchema.parse({
      ...authority,
      requestId: "fresh-human-request",
      triggerId: mintAnchor(),
      callId: "fresh-human-call",
    });
    admit();
    await pending();
    expect(cards).toHaveLength(2);
    expect(effects).toHaveLength(1);
  });

  it("concurrent preparation has one durable notification intent, and receipt loss cannot resend", async () => {
    loseReceipt = true;
    const first = request();
    await waitFor(() => cards.length === 1);
    expect((await request()).status).toBe("denied");
    expect(store().listGeneric()[0].notification.status).toBe("intent");
    receiptsHeld[0].destroy();
    expect((await first).status).toBe("uncertain");
    expect((await request()).status).toBe("uncertain");
    expect(cards).toHaveLength(1);
    expect(effects).toHaveLength(0);
  });

  it("supersession while a private card receipt is pending revokes its frozen authority", async () => {
    loseReceipt = true;
    const first = request();
    await waitFor(() => cards.length === 1);
    const action = store().listGeneric()[0];
    authority = McpNativeAuthoritySchema.parse({
      ...authority,
      triggerId: mintAnchor(),
      requestId: "during-publication",
    });
    admit();
    receiptsHeld[0].setHeader("content-type", "application/json");
    receiptsHeld[0].end(JSON.stringify({ ok: true, channel: "D123", ts: "1710000000.123" }));
    expect((await first).status).toBe("denied");
    expect(
      McpApprovalProjectionSchema.parse(
        (await post("/internal/mcp/approvals/resolve", click(action.id))).body.value,
      ).disposition,
    ).toBe("rejected");
    expect(cards).toHaveLength(1);
    expect(effects).toHaveLength(0);
  });

  it("rejects incomplete/private review, unsupported full budget and CLI/GitHub-forged reviewers before cards", async () => {
    expect((await request({ text: "x".repeat(3000) })).status).toBe("review_not_supported");
    badPrivate = true;
    expect((await request()).status).toBe("denied");
    badPrivate = false;
    const ref = await toolRef();
    expect(
      (
        await service.callTool(
          { toolRef: McpToolRefSchema.parse(ref), arguments: input },
          {
            kind: "cli",
            command: { directory: authority.directory, sessionId: authority.sessionId },
          },
        )
      ).status,
    ).toBe("denied");
    const github = McpNativeAuthoritySchema.parse({
      ...authority,
      requester: { source: "github", id: "fixture" },
      triggerId: mintAnchor(),
    });
    admit(github);
    expect((await request(input, github)).status).toBe("denied");
    expect(cards).toHaveLength(0);
    expect(effects).toHaveLength(0);
  });
  it.each(["userId", "teamId", "channel", "messageTs"])(
    "rejects forged click %s and unauthenticated readers",
    async (field) => {
      const id = await pending();
      expect(
        (await post("/internal/mcp/approvals/resolve", click(id, { [field]: "other" }))).body
          .status,
      ).toBe("denied");
      expect((await post("/internal/mcp/approvals/resolve", click(id), "wrong")).http).toBe(401);
      expect(effects).toHaveLength(0);
    },
  );
  it.each(["requester", "teamId", "repositoryDirectory", "sourceKey", "requestId", "sessionId"])(
    "protects status/list/results across reader %s, including removed aliases and CLI fallback",
    async (field) => {
      const id = await pending();
      await post("/internal/mcp/approvals/resolve", click(id));
      writeCatalog(undefined, false);
      await restart();
      const other =
        field === "requester"
          ? { source: "slack", id: "U999" }
          : field === "repositoryDirectory"
            ? "/workspace/repos/other"
            : "other";
      expect(
        (
          await post("/internal/mcp/approvals/read", {
            actionId: id,
            reader: reader({ [field]: other }),
          })
        ).http,
      ).toBe(403);
      expect(
        (await post("/internal/mcp/approvals/list", reader({ [field]: other }))).body.value,
      ).toEqual([]);
      expect(
        (await post("/internal/mcp/approvals/read", { actionId: id, reader: reader() })).http,
      ).toBe(200);
      expect(
        (
          await service.executeApproval(["status", id], {
            sessionId: authority.sessionId,
            directory: authority.directory,
          })
        ).exitCode,
      ).toBe(1);
      expect(
        (
          await service.executeApproval(["result", id, "fake-capability"], {
            sessionId: authority.sessionId,
          })
        ).exitCode,
      ).toBe(1);
      expect((await service.executeApproval(["list"])).stdout).not.toContain(id);
      expect((await service.executeMcp(["resolve", id, "approved", "U123"], {})).exitCode).toBe(1);
      expect(effects).toHaveLength(1);
    },
  );
  it("kernel owner refusal cannot change activation, and identical restarts/removal/re-addition invalidate authority", async () => {
    const id = await pending(),
      oldRef = await toolRef();
    const before = readFileSync(join(root, "generic/activation.json"), "utf8");
    const other = await McpApprovalOwner.acquire(join(root, "generic"));
    expect(other.ok).toBe(false);
    expect(readFileSync(join(root, "generic/activation.json"), "utf8")).toBe(before);
    await restart();
    expect(readFileSync(join(root, "generic/activation.json"), "utf8")).not.toBe(before);
    expect((await request(input, authority, brokerUrl, oldRef)).status).toBe("stale");
    expect(
      McpApprovalProjectionSchema.parse(
        (await post("/internal/mcp/approvals/resolve", click(id))).body.value,
      ).disposition,
    ).toBe("rejected");
    writeCatalog(undefined, false);
    await restart();
    writeCatalog();
    await restart();
    await post("/internal/mcp/approvals/resolve", click(id));
    expect(effects).toHaveLength(0);
  });
  it.each(["account-replacement", "token-rotation"])(
    "pins credentials within activation and invalidates pending %s using the same filename",
    async (mode) => {
      const id = await pending();
      const token =
        mode === "account-replacement" ? "dummy-account-b-token" : "dummy-account-a-rotated-token";
      const file = join(root, "secrets/docs-token");
      writeFileSync(file + ".next", token, { mode: 0o600 });
      renameSync(file + ".next", file);
      await post("/internal/mcp/approvals/resolve", click(id));
      expect(bearerCalls).toEqual(["Bearer dummy-account-a-token"]);
      authority = McpNativeAuthoritySchema.parse({
        ...authority,
        callId: "second-call",
        requestId: "second-request",
        triggerId: mintAnchor(),
      });
      admit();
      const old = await pending();
      await restart();
      await post("/internal/mcp/approvals/resolve", click(old));
      expect(effects).toHaveLength(1);
      authority = McpNativeAuthoritySchema.parse({
        ...authority,
        callId: "fresh-call",
        requestId: "fresh-request",
        triggerId: mintAnchor(),
      });
      admit();
      const fresh = await pending();
      await post("/internal/mcp/approvals/resolve", click(fresh));
      expect(bearerCalls).toEqual(["Bearer dummy-account-a-token", `Bearer ${token}`]);
    },
  );

  it("policy approval-to-allow change after activation never upgrades old approval authority", async () => {
    const id = await pending();
    writeCatalog({ allow: ["createJiraIssue"], approve: [] });
    await restart();
    await post("/internal/mcp/approvals/resolve", click(id));
    expect(effects).toHaveLength(0);
  });

  it.each(["superseded", "expired", "expired_previous_day", "inventory"])(
    "rechecks %s before dispatch and supports authorized historical inspection",
    async (mode) => {
      const id = await pending();
      if (mode === "superseded") {
        authority = McpNativeAuthoritySchema.parse({
          ...authority,
          triggerId: mintAnchor(),
          requestId: "next-request",
        });
        admit();
      }
      if (mode.startsWith("expired")) {
        const action = loadedRecord(id);
        const originalDate = action.dateSegment;
        const age = mode === "expired_previous_day" ? 24 * 3600_000 : 3600_000;
        action.createdAt = new Date(Date.now() - age).toISOString();
        action.dateSegment = action.createdAt.slice(0, 10);
        action.expiresAt = new Date(Date.now() - 1000).toISOString();
        store().updateGeneric(action);
        // Backdating across UTC midnight must not leave a newer, still-live copy.
        // The store updates immutable dated identities; fixture relocation is explicit.
        if (action.dateSegment !== originalDate)
          rmSync(join(root, "generic", originalDate, `${id}.json`));
        expect(
          store()
            .listGeneric()
            .filter((record) => record.id === id),
        ).toHaveLength(1);
        expect(loadedRecord(id).expiresAt).toBe(action.expiresAt);
      }
      if (mode === "inventory") {
        tools = [
          {
            name: "createJiraIssue",
            inputSchema: { ...schema, properties: { text: { type: "integer" } } },
          },
        ];
        await sdks[0].sendToolListChanged();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const response = await post("/internal/mcp/approvals/resolve", click(id));
      expect(McpApprovalProjectionSchema.parse(response.body.value).disposition).toBe("rejected");
      expect(effects).toHaveLength(0);
    },
  );
  it("holds stable action lock across dispatch/result replacement, concurrent/rejected/late clicks cannot redispatch", async () => {
    const id = await pending();
    holdCalls = true;
    const first = post("/internal/mcp/approvals/resolve", click(id));
    await waitFor(() => effects.length === 1);
    const inode = statSync(join(root, "generic/locks", id + ".lock")).ino;
    expect((await post("/internal/mcp/approvals/resolve", click(id))).body.status).toBe("busy");
    expect(
      (await post("/internal/mcp/approvals/resolve", click(id, { decision: "rejected" }))).body
        .status,
    ).toBe("busy");
    callsHeld[0]();
    expect((await first).body.status).toBe("generic");
    expect(statSync(join(root, "generic/locks", id + ".lock")).ino).toBe(inode);
    await post("/internal/mcp/approvals/resolve", click(id));
    await restart();
    await post("/internal/mcp/approvals/resolve", click(id));
    expect(effects).toHaveLength(1);
  });
  it("supersession after dispatch cannot undo the effect and never grants another dispatch", async () => {
    const id = await pending();
    holdCalls = true;
    const dispatch = post("/internal/mcp/approvals/resolve", click(id));
    await waitFor(() => effects.length === 1);
    authority = McpNativeAuthoritySchema.parse({
      ...authority,
      triggerId: mintAnchor(),
      requestId: "after-effect",
    });
    admit();
    callsHeld[0]();
    expect((await dispatch).body.status).toBe("generic");
    await post("/internal/mcp/approvals/resolve", click(id));
    expect(effects).toHaveLength(1);
  });

  it.each(["isError", "transport"])(
    "persists dispatched %s without retryable pending",
    async (mode) => {
      const id = await pending();
      toolError = mode === "isError";
      transportError = mode === "transport";
      const result = await post("/internal/mcp/approvals/resolve", click(id));
      expect(McpApprovalProjectionSchema.parse(result.body.value).disposition).toBe(
        mode === "isError" ? "tool_error" : "uncertain",
      );
      await restart();
      await post("/internal/mcp/approvals/resolve", click(id));
      expect(effects).toHaveLength(1);
    },
  );
  it("rejects nested JSON keys that the envelope decoder would silently strip, before review/effects", async () => {
    tools = [
      {
        name: "createJiraIssue",
        inputSchema: {
          ...schema,
          properties: { ...schema.properties, nested: { type: "object" } },
        },
      },
    ];
    const args = JSON.parse('{"text":"fixture","nested":{"__proto__":{"role":"admin"}}}');
    const result = await request(args);
    expect(result.status).toBe("denied");
    expect(cards).toHaveLength(0);
    expect(effects).toHaveLength(0);
  });

  it("duplicate persisted dispatch keys cannot downgrade a consumed record into another pending dispatch", async () => {
    const id = await pending();
    await post("/internal/mcp/approvals/resolve", click(id));
    const action = loadedRecord(id);
    if (action.dispatch.status !== "confirmed") throw new Error("fixture dispatch not confirmed");
    action.dispatch = { status: "consumed", claimedAt: action.dispatch.claimedAt };
    store().updateGeneric(action);
    const path = join(root, "generic", action.dateSegment, id + ".json");
    const raw = readFileSync(path, "utf8");
    const duplicate = raw.trimEnd().slice(0, -1) + ',"dispatch":{"status":"pending"}}\n';
    writeFileSync(path, duplicate);
    expect((await post("/internal/mcp/approvals/resolve", click(id))).body.status).toBe("denied");
    expect(effects).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(duplicate);
  });

  it("malformed new records cannot fall through to legacy or leak private parser fragments", async () => {
    const id = await pending();
    const action = loadedRecord(id);
    const path = join(root, "generic", action.dateSegment, id + ".json");
    writeFileSync(
      path,
      JSON.stringify({ ...action, version: 2, arguments: { private: "dummy-private-corrupt" } }),
    );
    const response = await post("/internal/mcp/approvals/resolve", click(id));
    expect(response.body.status).toBe("denied");
    expect(JSON.stringify(response)).not.toContain("dummy-private-corrupt");
    expect((await service.executeApproval(["status", id])).exitCode).toBe(1);
    expect(effects).toHaveLength(0);
    expect(readFileSync(path, "utf8")).toContain('"version":2');
  });
  it("real broker process crash after dispatch before result remains consumed/uncertain across ownership recovery", async () => {
    const child = await childBroker();
    holdCalls = true;
    const requested = await request(input, authority, child.url, child.ref);
    const id = requested.actionId;
    if (!id) throw new Error("fixture pending approval missing");
    expect(requested.status).toBe("pending_approval");
    const resolving = post(
      "/internal/mcp/approvals/resolve",
      click(id),
      "dummy-internal-secret",
      child.url,
    ).catch(() => undefined);
    await waitFor(() => effects.length === 1);
    expect(store().getGeneric(id)?.dispatch.status).toBe("consumed");
    await kill(child.child);
    await resolving;
    callsHeld[0]();
    await start();
    const result = await post("/internal/mcp/approvals/resolve", click(id));
    expect(McpApprovalProjectionSchema.parse(result.body.value).disposition).toBe("uncertain");
    expect(effects).toHaveLength(1);
  });
  it("real broker process crash after Slack card before receipt cannot resend or approve unconfirmed notification", async () => {
    const child = await childBroker();
    loseReceipt = true;
    const requested = request(input, authority, child.url, child.ref).catch(() => undefined);
    await waitFor(() => cards.length === 1);
    const action = store().listGeneric()[0];
    expect(action.notification.status).toBe("intent");
    await kill(child.child);
    await requested;
    receiptsHeld[0].destroy();
    await start();
    expect((await request()).status).toBe("denied");
    expect((await post("/internal/mcp/approvals/resolve", click(action.id))).body.status).toBe(
      "denied",
    );
    expect(cards).toHaveLength(1);
    expect(effects).toHaveLength(0);
  });
  it("real signed Slack gateway continues only stored private result projection, rejecting forged signature/card scope", async () => {
    const id = await pending();
    const block = z
      .object({
        blocks: z.array(
          z.looseObject({ elements: z.array(z.looseObject({ value: z.string() })).optional() }),
        ),
      })
      .parse(cards[0]);
    const value = block.blocks.flatMap((block) => block.elements ?? [])[0].value;
    const continuations: unknown[] = [];
    const runnerApp = express();
    runnerApp.use(express.json());
    runnerApp.post("/trigger", (req, res) => {
      continuations.push(req.body);
      res.json({ accepted: true });
    });
    const runner = createServer(runnerApp);
    const runnerUrl = await listen(runner);
    const config = {
      signingSecret: "dummy-signing-secret",
      slackBotToken: "dummy-slack-token",
      slackBotUserId: "UBOT",
      slackTeamId: "T123",
      slackApiBaseUrl: slackUrl,
      runnerUrl,
      internalSecret: "dummy-internal-secret",
      queueDir: join(root, "queue"),
      disableQueueInterval: true,
      remoteCliHost: "127.0.0.1",
      remoteCliPort: Number(new URL(brokerUrl).port),
    };
    const code = `import {createGatewayApp} from './packages/gateway/src/app.ts';import {createServer} from 'node:http';
      const gateway=createGatewayApp({...${JSON.stringify(config)},workspaceConfigLoader:()=>({owners:{},users:[]})});
      gateway.app.post('/fixture/flush',async(_req,res)=>{await gateway.queue.flush();res.json({ok:true})});
      const server=createServer(gateway.app);server.listen(0,'127.0.0.1',()=>process.stdout.write('READY '+server.address().port+'\\n'));`;
    const gateway = spawn(
      process.execPath,
      ["--import", loader, "--input-type=module", "-e", code],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(gateway);
    let output = "",
      errors = "";
    gateway.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    gateway.stderr?.on("data", (chunk) => {
      errors += chunk;
    });
    await waitFor(() => output.includes("READY ") || gateway.exitCode !== null);
    if (!output.includes("READY ")) throw new Error(errors);
    const url = `http://127.0.0.1:${output.split("READY ")[1].split("\n")[0]}`;
    async function signed(secret: string, user = "U123", channel = "D123") {
      const body = new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T123" },
          user: { id: user },
          channel: { id: channel },
          message: { ts: "1710000000.123" },
          actions: [{ action_id: "approval_approve", value }],
        }),
      }).toString();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sig =
        "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
      return fetch(url + "/slack/interactivity", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-signature": sig,
          "x-slack-request-timestamp": timestamp,
        },
        body,
      });
    }
    try {
      expect((await signed("wrong")).status).toBe(401);
      await signed("dummy-signing-secret", "U999");
      await signed("dummy-signing-secret", "U123", "C123");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(effects).toHaveLength(0);
      expect((await signed("dummy-signing-secret")).status).toBe(200);
      await waitFor(() => effects.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(output).not.toContain(input.text);
      expect(output).not.toContain("dummy-private-vendor-result");
      expect(store().getGeneric(id)?.dispatch.status).toBe("confirmed");
      await fetch(url + "/fixture/flush", { method: "POST" });
      expect(continuations).toHaveLength(1);
      const continuation = z
        .looseObject({
          directory: z.string(),
          prompt: z.string(),
          triggerSlackId: z.string(),
          correlationKey: z.string(),
        })
        .parse(continuations[0]);
      expect(continuation.directory).toBe(authority.repositoryDirectory);
      expect(continuation.triggerSlackId).toBe("U123");
      expect(continuation.correlationKey).toBe("slack:thread:D123/1710000000.123");
      const frozenSource = McpApprovalProjectionSchema.parse(
        z.looseObject({ mcpApprovalSource: z.unknown() }).parse(continuations[0]).mcpApprovalSource,
      );
      expect(frozenSource).toMatchObject({
        actionId: id,
        disposition: "completed",
        channel: "D123",
        reader: {
          requestId: authority.requestId,
          sourceKey: authority.sourceKey,
          sessionId: authority.sessionId,
        },
      });
      expect(
        z
          .looseObject({
            slackReplyAdmission: z.object({
              version: z.literal(1),
              teamId: z.string(),
              channel: z.string(),
              threadTs: z.string(),
            }),
          })
          .parse(continuations[0]).slackReplyAdmission,
      ).toEqual({ version: 1, teamId: "T123", channel: "D123", threadTs: "1710000000.123" });
      expect(continuation.prompt).toContain("do not replay");
      expect(JSON.stringify(continuations)).not.toContain(input.text);
      expect(JSON.stringify(continuations)).not.toContain("dummy-private-vendor-result");
      await signed("dummy-signing-secret");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const queuedFile = readdirSync(join(root, "queue")).find(
        (file) => file.endsWith(".json") && !file.startsWith("."),
      );
      if (!queuedFile) throw new Error("missing continuation record");
      const queuePath = join(root, "queue", queuedFile);
      const queued = z
        .looseObject({ payload: z.looseObject({ genericMcp: McpApprovalProjectionSchema }) })
        .parse(JSON.parse(readFileSync(queuePath, "utf8")));
      writeFileSync(
        queuePath,
        JSON.stringify({
          ...queued,
          payload: {
            ...queued.payload,
            genericMcp: {
              ...queued.payload.genericMcp,
              reader: {
                ...queued.payload.genericMcp.reader,
                requester: { source: "slack", id: "U999" },
              },
            },
          },
        }),
      );
      await fetch(url + "/fixture/flush", { method: "POST" });
      expect(continuations).toHaveLength(1);
      expect(effects).toHaveLength(1);
    } finally {
      await kill(gateway);
      await close(runner);
    }
  });
});
