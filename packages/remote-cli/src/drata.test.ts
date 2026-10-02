import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { ExecResultSchema } from "@thor/common";
import { createRemoteCliApp } from "./index.js";
import { DrataService } from "./drata.js";

const servers: Server[] = [];
let closeRemote: (() => Promise<void>) | undefined;
let apiUrl: string;
let remoteUrl: string;
let oauthStatus: number;
let oauthPayload: unknown;
let expiresIn: number;
let redirectTarget: string;
let calls: Array<{
  method: string | undefined;
  url: string | undefined;
  body: string;
  auth: string | undefined;
  contentType: string | undefined;
}>;

async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  oauthStatus = 200;
  oauthPayload = undefined;
  expiresIn = 3600;
  redirectTarget = "http://unused.invalid";
  calls = [];
  apiUrl = await listen(
    createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.push({
        method: req.method,
        url: req.url,
        body,
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
      });
      res.setHeader("content-type", "application/json");
      if (req.url === "/oauth/token") {
        res.statusCode = oauthStatus;
        if (oauthStatus >= 300 && oauthStatus < 400) res.setHeader("location", redirectTarget);
        res.end(
          JSON.stringify(
            oauthStatus === 200
              ? (oauthPayload ?? { access_token: "fixture-token", expires_in: expiresIn })
              : { error: "failure that echoes fixture-client-secret" },
          ),
        );
      } else if (req.url === "/disconnect") {
        req.socket.destroy();
      } else if (req.url === "/text") {
        res.statusCode = 503;
        res.setHeader("content-type", "text/plain");
        res.end("Fixture maintenance");
      } else if (req.url === "/denied") {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "insufficient_scope" }));
      } else if (req.url === "/redirect") {
        res.statusCode = 307;
        res.setHeader("location", redirectTarget);
        res.end();
      } else if (req.method === "DELETE") {
        res.statusCode = 204;
        res.end();
      } else {
        res.statusCode = req.method === "POST" ? 201 : 200;
        res.end(JSON.stringify({ accepted: true }));
      }
    }),
  );
  for (const [key, value] of Object.entries({
    DRATA_OAUTH_TOKEN_URL: `${apiUrl}/oauth/token`,
    DRATA_CLIENT_ID: "fixture-client-id",
    DRATA_CLIENT_SECRET: "fixture-client-secret",
    DRATA_AUDIENCE: apiUrl,
    DRATA_SCOPES: "fixture:scope",
    DRATA_API_BASE_URL: apiUrl,
  }))
    vi.stubEnv(key, value);
});

afterEach(async () => {
  await closeRemote?.();
  closeRemote = undefined;
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  vi.unstubAllEnvs();
});

async function start() {
  const remote = createRemoteCliApp();
  closeRemote = remote.close;
  remoteUrl = await listen(createServer(remote.app));
}

async function command(args: unknown) {
  const response = await fetch(`${remoteUrl}/exec/drata`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args }),
  });
  return { status: response.status, result: ExecResultSchema.parse(await response.json()) };
}

describe("Drata API passthrough through real HTTP boundaries", () => {
  it("forwards reads, writes, custom methods, and JSON outside the old v2 prefix", async () => {
    await start();
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "PURGE"];
    for (const method of methods) {
      const body = ["POST", "PUT", "PATCH", "PURGE"].includes(method)
        ? ["--json", '{"enabled":true}']
        : [];
      const result = await command([
        "api",
        method.toLowerCase(),
        "/v1/resources/id?expand=all",
        ...body,
      ]);
      expect(result).toMatchObject({ status: 200, result: { stderr: "", exitCode: 0 } });
      if (method === "DELETE" || method === "HEAD") expect(result.result.stdout).toBe("null");
    }
    expect(calls.filter((call) => call.url === "/oauth/token")).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      client_id: "fixture-client-id",
      client_secret: "fixture-client-secret",
      audience: apiUrl,
      grant_type: "client_credentials",
      scope: "fixture:scope",
    });
    const apiCalls = calls.filter((call) => call.url !== "/oauth/token");
    expect(apiCalls.map((call) => call.method)).toEqual(methods);
    expect(apiCalls.every((call) => call.auth === "Bearer fixture-token")).toBe(true);
    expect(
      apiCalls
        .filter((call) => call.body)
        .every(
          (call) => call.body === '{"enabled":true}' && call.contentType === "application/json",
        ),
    ).toBe(true);
    expect(
      await command([
        "api",
        "PATCH",
        "/other-api/items",
        '--json=[{"op":"replace","path":"/name","value":"New"}]',
      ]),
    ).toMatchObject({ result: { exitCode: 0 } });
  });

  it("lets upstream permissions deny an operation and returns the provider response", async () => {
    await start();
    const response = await command(["api", "POST", "/denied", "--json", "{}"]);
    expect(response).toEqual({
      status: 200,
      result: {
        stdout: JSON.stringify({ error: "insufficient_scope" }, null, 2),
        stderr: "Drata API returned HTTP 403",
        exitCode: 1,
      },
    });
    expect(calls.at(-1)?.method).toBe("POST");
  });

  it("rejects malformed input and host changes before minting a token", async () => {
    await start();
    for (const args of [
      null,
      {},
      [1],
      ["api", "POST", "/path", "--json", "{bad"],
      ["api", "GET", "//elsewhere.invalid/path"],
      ["api", "GET", "https://elsewhere.invalid/path"],
      ["api", "GET", "/\\elsewhere.invalid/path"],
      ["api", "GET", "/path#fragment"],
      ["api", "GET\r\nHeader", "/path"],
      ["api", "GET", "/path", "--json"],
    ])
      expect(await command(args)).toMatchObject({ status: 400, result: { exitCode: 1 } });
    expect(calls).toEqual([]);
    // The service also protects the credential destination for direct callers.
    const service = new DrataService(process.env);
    expect(
      await service.execute({ method: "POST", path: "https://elsewhere.invalid/path", json: {} }),
    ).toMatchObject({ ok: false, error: { stage: "destination" } });
    expect(calls).toEqual([]);
  });

  it("does not forward tokens or write bodies through redirects", async () => {
    let redirectedCalls = 0;
    redirectTarget = await listen(
      createServer((_req, res) => {
        redirectedCalls++;
        res.end();
      }),
    );
    await start();
    expect(
      await command(["api", "POST", "/redirect", "--json", '{"private":"fixture"}']),
    ).toMatchObject({
      status: 200,
      result: { exitCode: 1, stderr: "Drata API returned HTTP 307" },
    });
    expect(redirectedCalls).toBe(0);
  });

  it("returns safe OAuth failures without echoing credentials from the provider", async () => {
    oauthStatus = 401;
    await start();
    const response = await command(["api", "POST", "/path", "--json", "{}"]);
    expect(response).toMatchObject({
      status: 502,
      result: { exitCode: 1, stderr: "Drata integration failed: oauth (HTTP 401)" },
    });
    expect(JSON.stringify(response)).not.toContain("fixture-client-secret");
    expect(calls).toHaveLength(1);
  });

  it.each([{}, { access_token: 12 }, { access_token: "fixture-token", expires_in: "3600" }])(
    "rejects malformed OAuth envelopes before calling an API",
    async (payload) => {
      oauthPayload = payload;
      await start();
      expect(await command(["api", "POST", "/path", "--json", "{}"])).toMatchObject({
        status: 502,
        result: { exitCode: 1, stderr: "Drata integration failed: oauth (HTTP 200)" },
      });
      expect(calls).toHaveLength(1);
    },
  );

  it("does not send the client secret through an OAuth redirect", async () => {
    let redirectedCalls = 0;
    redirectTarget = await listen(
      createServer((_req, res) => {
        redirectedCalls++;
        res.end();
      }),
    );
    oauthStatus = 307;
    await start();
    expect(await command(["api", "POST", "/path"])).toMatchObject({
      status: 502,
      result: { exitCode: 1, stderr: "Drata integration failed: oauth (HTTP 307)" },
    });
    expect(redirectedCalls).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("preserves non-JSON API errors and translates broken connections into safe failures", async () => {
    await start();
    expect(await command(["api", "GET", "/text"])).toMatchObject({
      status: 200,
      result: {
        stdout: '"Fixture maintenance"',
        stderr: "Drata API returned HTTP 503",
        exitCode: 1,
      },
    });
    expect(await command(["api", "POST", "/disconnect", "--json", "{}"])).toMatchObject({
      status: 502,
      result: { stdout: "", stderr: "Drata integration failed: request", exitCode: 1 },
    });
  });

  it("refreshes the cached OAuth token before expiry", async () => {
    expiresIn = 120;
    let now = 0;
    const service = new DrataService(process.env, () => now);
    expect((await service.execute({ method: "GET", path: "/path" })).ok).toBe(true);
    now = 10_000;
    expect((await service.execute({ method: "GET", path: "/path" })).ok).toBe(true);
    now = 61_000;
    expect((await service.execute({ method: "GET", path: "/path" })).ok).toBe(true);
    expect(calls.filter((call) => call.url === "/oauth/token")).toHaveLength(2);
  });

  it("keeps help available without configuration and reports missing credentials without I/O", async () => {
    vi.stubEnv("DRATA_CLIENT_SECRET", "");
    await start();
    expect(await command(["--help"])).toMatchObject({ status: 200, result: { exitCode: 0 } });
    expect(await command(["api", "DELETE", "/path"])).toMatchObject({
      status: 503,
      result: { exitCode: 1 },
    });
    expect(calls).toEqual([]);
  });
});
