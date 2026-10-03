import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GoogleWorkspaceConnectionStatusClient } from "./google-workspace-connection-status.js";

let server: Server;
let client: GoogleWorkspaceConnectionStatusClient;
let status: number;
let responseBody: unknown;
let requester: string;
let redirected: number;

beforeEach(async () => {
  status = 200;
  redirected = 0;
  requester = "";
  responseBody = {
    oauth: { configured: true },
    identity: { ok: true, connectionState: "connected" },
  };
  server = createServer(async (req, res) => {
    if (req.url === "/redirected") {
      redirected++;
      res.end();
      return;
    }
    expect(req.headers["x-thor-internal-secret"]).toBe("fixture-private-secret");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
    expect(body).toEqual({ slackUserId: "U123" });
    requester = "U123";
    res.writeHead(status, { "content-type": "application/json", location: "/redirected" });
    res.end(JSON.stringify(responseBody));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Google Workspace status fixture listener missing");
  client = new GoogleWorkspaceConnectionStatusClient({
    remoteCliUrl: `http://127.0.0.1:${address.port}`,
    internalSecret: "fixture-private-secret",
  });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("queries only the trusted requester and returns connection evidence without credentials/provider metadata", async () => {
  responseBody = {
    oauth: { configured: true },
    identity: {
      ok: true,
      connectionState: "connected",
      email: "private@example.test",
      refreshToken: "must-not-return",
    },
  };
  expect(await client.forSlackUser("U123")).toBe("connected");
  expect(requester).toBe("U123");
  expect(JSON.stringify(client)).not.toContain("fixture-private-secret");
});
it.each([401, 500, 302])(
  "treats broker HTTP %i as unavailable, never follows a credential-bearing redirect",
  async (code) => {
    status = code;
    expect(await client.forSlackUser("U123")).toBe("unavailable");
    expect(redirected).toBe(0);
  },
);
it.each([
  { oauth: { configured: false }, identity: { ok: true, connected: true } },
  { oauth: { configured: true }, identity: { ok: false } },
  { identity: { ok: true, connected: true } },
  { oauth: { configured: true }, identity: { ok: true, connectionState: "unavailable" } },
])(
  "does not convert invalid/config/policy/storage failure into a connected claim",
  async (body) => {
    responseBody = body;
    expect(await client.forSlackUser("U123")).toBe("unavailable");
  },
);
it("distinguishes a missing current grant from unavailable legacy negative evidence", async () => {
  responseBody = {
    oauth: { configured: true },
    identity: { ok: true, connectionState: "missing" },
  };
  expect(await client.forSlackUser("U123")).toBe("missing");
  responseBody = { oauth: { configured: true }, identity: { ok: true, connected: false } };
  expect(await client.forSlackUser("U123")).toBe("unavailable");
});
