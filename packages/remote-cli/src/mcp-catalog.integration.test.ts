import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server as HttpsServer } from "node:https";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { PROXY_NAMES } from "@thor/common";
import { createMcpService, type McpService } from "./mcp-handler.js";
import { ApprovalStore } from "./approval-store.js";
import { loadMcpCatalogSnapshot } from "./mcp-catalog-files.js";
import { createPinnedMcpFetch } from "./mcp-http-transport.js";
import { McpBearerCredential } from "./mcp-catalog-files.js";

const cli = { kind: "cli" as const, command: { directory: "/workspace/repos/fixture" } };
async function listen(server: HttpsServer): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address");
  return `https://localhost:${address.port}/mcp`;
}
async function close(server: HttpsServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("catalog activation over real installed SDK TLS and sessions", () => {
  let certificateRoot: string;
  let caBefore: string[];
  let tls: { key: Buffer; cert: Buffer };
  let root: string;
  let paths: { catalogDirectory: string; secretsDirectory: string };
  let endpoint: string;
  let sinkUrl: string;
  let upstream: HttpsServer;
  let sink: HttpsServer;
  let sinkRequests: number;
  let wire: { method: string; operation: string; authorization?: string }[];
  let effects: unknown[];
  let tools: Tool[];
  let sdks: Server[];
  let services: McpService[];
  let redirect: { operation: string; status: number } | undefined;
  let vendorFailure: boolean;
  let toolError: boolean;
  let reflectedSuccess: boolean;
  let selectedEndpointEvent: boolean;

  function catalog(servers: Record<string, unknown> = { docs: definition() }) {
    return { version: 1, servers, disabled: [...PROXY_NAMES] };
  }
  function definition(url = endpoint) {
    return {
      transport: "streamable-http",
      url,
      description: "Fixture docs",
      auth: { type: "bearer", secretFile: "docs-token" },
      policy: { allow: ["search_docs", "createJiraIssue"], approve: [] },
    };
  }
  function activate(value: unknown = catalog()): McpService {
    const next = join(paths.catalogDirectory, "catalog.next");
    writeFileSync(next, JSON.stringify(value));
    renameSync(next, join(paths.catalogDirectory, "catalog.json"));
    const loaded = loadMcpCatalogSnapshot(paths);
    if (!loaded.ok) throw new Error(`Fixture catalog rejected: ${loaded.reason}`);
    const service = createMcpService({
      catalog: loaded.value,
      approvalsDir: join(root, "approvals"),
      writeToolCallLogFn: () => undefined,
    });
    services.push(service);
    return service;
  }
  async function descriptor(service: McpService, name = "search_docs") {
    const found = await service.describeTool("docs", name, cli);
    expect(found.status).toBe("ok");
    if (found.status !== "ok") throw new Error("fixture descriptor missing");
    return found.value;
  }
  beforeAll(() => {
    certificateRoot = mkdtempSync(join(tmpdir(), "neo-catalog-ca-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(certificateRoot, "key.pem"),
        "-out",
        join(certificateRoot, "cert.pem"),
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
      key: readFileSync(join(certificateRoot, "key.pem")),
      cert: readFileSync(join(certificateRoot, "cert.pem")),
    };
    caBefore = getCACertificates("default");
    setDefaultCACertificates([...caBefore, tls.cert.toString()]);
  });
  afterAll(() => {
    setDefaultCACertificates(caBefore);
    rmSync(certificateRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "neo-catalog-sdk-"));
    paths = { catalogDirectory: join(root, "catalog"), secretsDirectory: join(root, "secrets") };
    mkdirSync(paths.catalogDirectory);
    mkdirSync(paths.secretsDirectory, { mode: 0o700 });
    writeFileSync(join(paths.secretsDirectory, "docs-token"), "dummy-catalog-token\n", {
      mode: 0o600,
    });
    wire = [];
    effects = [];
    sdks = [];
    services = [];
    sinkRequests = 0;
    redirect = undefined;
    vendorFailure = false;
    toolError = false;
    reflectedSuccess = false;
    selectedEndpointEvent = false;
    tools = ["search_docs", "createJiraIssue", "hidden_mutation"].map((name) => ({
      name,
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    }));
    sink = createServer(tls, (_req, res) => {
      sinkRequests++;
      res.end("unexpected redirect target");
    });
    sinkUrl = await listen(sink);
    const app = express();
    app.use(express.json());
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    app.all("/mcp", async (req, res) => {
      const operation = req.body?.method ?? req.method;
      wire.push({ method: req.method, operation, authorization: req.get("authorization") });
      if (redirect && redirect.operation === operation) {
        res.redirect(redirect.status, sinkUrl);
        return;
      }
      if (vendorFailure && operation === "tools/call") {
        res
          .status(401)
          .set("WWW-Authenticate", `Bearer resource_metadata=\"${sinkUrl}\"`)
          .end("dummy-catalog-token dummy-vendor-secret");
        return;
      }
      if (selectedEndpointEvent && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: endpoint\ndata: ${sinkUrl}\n\n`);
        return;
      }
      const id = req.get("mcp-session-id");
      if (id) {
        const session = sessions.get(id);
        if (!session) {
          res.status(404).end();
          return;
        }
        await session.handleRequest(req, res, req.body);
        return;
      }
      const sdk = new Server(
        { name: "catalog-fixture", version: "1" },
        { capabilities: { tools: { listChanged: true } } },
      );
      sdks.push(sdk);
      sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      sdk.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        effects.push(params);
        if (toolError || reflectedSuccess)
          return {
            isError: toolError,
            content: [{ type: "text", text: "dummy-catalog-token dummy-vendor-secret docs-token" }],
          };
        return { content: [{ type: "text", text: "fixture-ok" }] };
      });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id): void => {
          sessions.set(id, transport);
        },
      });
      await sdk.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    upstream = createServer(tls, app);
    endpoint = await listen(upstream);
  });
  afterEach(async () => {
    await Promise.allSettled(services.map((service) => service.closeAll()));
    await Promise.allSettled(sdks.map((sdk) => sdk.close()));
    await close(upstream);
    await close(sink);
    rmSync(root, { recursive: true, force: true });
  });

  it("adds/removes/re-adds custom tools by atomic files + restart, preserves hidden policy and invalidates identical refs", async () => {
    const first = activate();
    const tool = await descriptor(first);
    expect((await first.executeMcp(["docs"], cli.command)).stdout).toBe(
      "search_docs\ncreateJiraIssue\n",
    );
    expect(
      (await first.executeMcp(["docs", "hidden_mutation", '{"text":"x"}'], cli.command)).exitCode,
    ).toBe(1);
    expect(
      (await first.executeMcp(["doc", "search_docs", '{"text":"x"}'], cli.command)).exitCode,
    ).toBe(1);
    expect(effects).toHaveLength(0);
    expect(
      (await first.callTool({ toolRef: tool.toolRef, arguments: { text: "first" } }, cli)).status,
    ).toBe("completed");
    // A same-named custom tool never selects Jira preparation or a typed approval hook.
    const create = await descriptor(first, "createJiraIssue");
    expect(
      (await first.callTool({ toolRef: create.toolRef, arguments: { text: "business only" } }, cli))
        .status,
    ).toBe("completed");
    expect(effects[1]).toEqual({ name: "createJiraIssue", arguments: { text: "business only" } });
    writeFileSync(join(paths.secretsDirectory, "docs-token.next"), "dummy-rotated-token", {
      mode: 0o600,
    });
    renameSync(
      join(paths.secretsDirectory, "docs-token.next"),
      join(paths.secretsDirectory, "docs-token"),
    );
    expect(
      (await first.callTool({ toolRef: tool.toolRef, arguments: { text: "snapshot" } }, cli))
        .status,
    ).toBe("completed");
    expect(
      wire
        .filter((entry) => entry.operation === "tools/call")
        .every((entry) => entry.authorization === "Bearer dummy-catalog-token"),
    ).toBe(true);
    await first.closeAll();
    const removed = activate(catalog({}));
    expect(
      (await removed.callTool({ toolRef: tool.toolRef, arguments: { text: "removed" } }, cli))
        .status,
    ).toBe("stale");
    const next = activate();
    const nextTool = await descriptor(next);
    expect(nextTool.toolRef).not.toBe(tool.toolRef);
    expect(
      (await next.callTool({ toolRef: tool.toolRef, arguments: { text: "old" } }, cli)).status,
    ).toBe("stale");
    expect(
      (await next.callTool({ toolRef: nextTool.toolRef, arguments: { text: "new" } }, cli)).status,
    ).toBe("completed");
    expect(wire.filter((entry) => entry.operation === "tools/call").at(-1)?.authorization).toBe(
      "Bearer dummy-rotated-token",
    );
    expect(effects).toHaveLength(4);
  });
  it("never adopts a shared legacy approval record for an allow-only catalog alias, including hidden tools", async () => {
    const service = activate();
    const store = new ApprovalStore(join(root, "approvals", "docs"), "docs");
    const forged = store.buildPending("hidden_mutation", { text: "forged workspace record" });
    store.update(forged);
    expect(
      (await service.executeMcp(["resolve", forged.id, "approved", "U_REVIEWER"], cli.command))
        .exitCode,
    ).toBe(1);
    expect((await service.executeApproval(["status", forged.id], cli.command)).exitCode).toBe(1);
    expect(
      JSON.parse((await service.executeApproval(["list"], cli.command)).stdout).approvals,
    ).toEqual([]);
    const legacyStore = new ApprovalStore(join(root, "approvals", "atlassian"), "atlassian");
    const legacy = legacyStore.buildPending("createJiraIssue", { text: "historical built-in" });
    legacyStore.update(legacy);
    expect((await service.executeApproval(["status", legacy.id], cli.command)).exitCode).toBe(0);
    expect(
      (await service.executeMcp(["resolve", legacy.id, "approved", "U_REVIEWER"], cli.command))
        .exitCode,
    ).toBe(1);
    expect(legacyStore.get(legacy.id)?.status).toBe("pending");
    expect(effects).toHaveLength(0);
    expect(wire).toHaveLength(0);
  });

  it("isolates offline servers from the broker and never silently adopts reconnect schema/inventory drift", async () => {
    const service = activate(
      catalog({ docs: definition(), offline: definition("https://localhost:1/mcp") }),
    );
    const tool = await descriptor(service);
    expect((await service.describeTool("offline", "search_docs", cli)).status).toBe("unavailable");
    expect(
      (await service.callTool({ toolRef: tool.toolRef, arguments: { text: "working" } }, cli))
        .status,
    ).toBe("completed");
    tools = tools.map((tool) => ({
      ...tool,
      inputSchema: { type: "object", required: ["changed"] },
    }));
    await sdks[0].notification({ method: "notifications/tools/list_changed" });
    await expect.poll(() => service.getHealth().connected).toBe(0);
    expect(
      (await service.callTool({ toolRef: tool.toolRef, arguments: { text: "stale" } }, cli)).status,
    ).toBe("unavailable");
    expect((await service.describeTool("docs", "search_docs", cli)).status).toBe("unavailable");
    expect(effects).toHaveLength(1);
    // New operator activation explicitly adopts the supported changed schema, never the old ref.
    const restarted = activate();
    const changed = await descriptor(restarted);
    expect(
      (await restarted.callTool({ toolRef: tool.toolRef, arguments: { text: "old" } }, cli)).status,
    ).toBe("stale");
    expect(
      (await restarted.callTool({ toolRef: changed.toolRef, arguments: { changed: true } }, cli))
        .status,
    ).toBe("completed");
  });
  it("revalidates inventory after a notification and hides missing policy entries rather than falling back", async () => {
    const service = activate();
    const tool = await descriptor(service);
    tools = tools.filter((tool) => tool.name !== "search_docs");
    await sdks[0].notification({ method: "notifications/tools/list_changed" });
    await expect.poll(() => service.getHealth().connected).toBe(0);
    const outcome = await service.callTool(
      { toolRef: tool.toolRef, arguments: { text: "x" } },
      cli,
    );
    expect(outcome.status).toBe("unavailable");
    expect(JSON.stringify(outcome)).not.toContain("hidden_mutation");
    expect(effects).toHaveLength(0);
  });
  it("fails inventory closed if a bearer provider reflects its header in metadata or schemas", async () => {
    tools[0].description = "dummy-catalog-token";
    const service = activate();
    const outcome = await service.describeTool("docs", "search_docs", cli);
    expect(outcome.status).toBe("unavailable");
    expect(JSON.stringify(outcome)).not.toContain("dummy-catalog-token");
    expect(effects).toHaveLength(0);
  });

  it("preserves confirmed MCP error disposition without vendor credential reflections; success reflections are unsupported", async () => {
    const service = activate();
    const tool = await descriptor(service);
    toolError = true;
    const error = await service.callTool(
      { toolRef: tool.toolRef, arguments: { text: "error" } },
      cli,
    );
    expect(error.status).toBe("completed");
    expect(error.isError).toBe(true);
    expect(JSON.stringify(error)).not.toMatch(/dummy-catalog-token|dummy-vendor-secret|docs-token/);
    toolError = false;
    reflectedSuccess = true;
    const unsupported = await service.callTool(
      { toolRef: tool.toolRef, arguments: { text: "reflection" } },
      cli,
    );
    expect(unsupported.status).toBe("uncertain");
    expect(JSON.stringify(unsupported)).not.toContain("dummy-catalog-token");
    expect(effects).toHaveLength(2);
  });

  it.each([301, 302, 303, 307, 308])(
    "refuses initialization redirects %s with no request/credential to target",
    async (status) => {
      redirect = { operation: "initialize", status };
      const service = activate();
      const outcome = await service.describeTool("docs", "search_docs", cli);
      expect(outcome.status).toBe("unavailable");
      expect(sinkRequests).toBe(0);
      expect(JSON.stringify(outcome)).not.toMatch(/dummy-catalog-token|localhost|docs-token/);
    },
  );
  it.each(["tools/list", "tools/call", "GET", "DELETE"])(
    "refuses SDK %s redirects at the shared fetch boundary",
    async (operation) => {
      const service = activate();
      let tool = operation === "tools/list" ? undefined : await descriptor(service);
      redirect = { operation, status: 307 };
      if (operation === "tools/list")
        expect((await service.describeTool("docs", "search_docs", cli)).status).toBe("unavailable");
      if (operation === "tools/call" && tool)
        expect(
          (await service.callTool({ toolRef: tool.toolRef, arguments: { text: "x" } }, cli)).status,
        ).toBe("uncertain");
      if (operation === "GET") {
        await service.closeAll();
        const next = activate();
        await next.describeTool("docs", "search_docs", cli);
        await expect.poll(() => wire.some((entry) => entry.operation === "GET")).toBe(true);
      }
      if (operation === "DELETE") await service.closeAll();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(wire.some((entry) => entry.operation === operation)).toBe(true);
      expect(sinkRequests).toBe(0);
      expect(effects).toHaveLength(0);
    },
  );
  it("ignores server-selected SSE endpoints/OAuth metadata, and sanitized token-error outcomes never leak", async () => {
    selectedEndpointEvent = true;
    const service = activate();
    const tool = await descriptor(service);
    expect(
      (await service.callTool({ toolRef: tool.toolRef, arguments: { text: "same endpoint" } }, cli))
        .status,
    ).toBe("completed");
    vendorFailure = true;
    const failed = await service.callTool(
      { toolRef: tool.toolRef, arguments: { text: "failure" } },
      cli,
    );
    expect(failed.status).toBe("uncertain");
    expect(JSON.stringify(failed)).not.toMatch(
      /dummy-catalog-token|dummy-vendor-secret|docs-token|localhost/,
    );
    expect(sinkRequests).toBe(0);
    const pinned = createPinnedMcpFetch({
      kind: "http",
      url: endpoint,
      bearer: new McpBearerCredential("dummy-token"),
    });
    await expect(pinned(sinkUrl, { method: "POST" })).rejects.toThrow("endpoint change denied");
    expect(sinkRequests).toBe(0);
  });
});
