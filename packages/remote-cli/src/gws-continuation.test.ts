import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  appendAlias,
  appendSessionEvent,
  GoogleWorkspaceExecResultSchema,
  GoogleAuthContinuationSchema,
  loadRemoteCliEnv,
} from "@thor/common";
import { z } from "zod";
import { GwsOAuthService } from "./gws-oauth.js";
import { createRemoteCliApp } from "./index.js";

const secret = "fixture-internal-secret";
const email = "person@example.com";
const owner = {
  slackUserId: "U123",
  sessionId: "continuation-session",
  anchorId: "019d0000-0000-7000-8000-000000000001",
  triggerId: "019d0000-0000-7000-8000-000000000002",
};
const args = ["docs", "documents", "create", "--json", '{"title":"private continuation title"}'];
let root: string;
let servers: Server[];
let closeApps: Array<() => Promise<void>>;
let base: string;
let provider: string;
let oauth: GwsOAuthService;
let now: number;
let dmConfirmed: boolean;
let refreshStatus: number;
let refreshBody: unknown;
let identityStatus: number;
let identityBody: unknown;
let networkFailure: boolean;
let supersedeOnRefresh: boolean;
let grantRace: "none" | "disconnect" | "replace";
let executedResult: { stdout: string; stderr: string; exitCode: number };
let messages: Array<{ channel: string; text: string }>;
let executions: Array<{ args: string[]; token: string }>;

async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Continuation fixture listener missing");
  return `http://127.0.0.1:${address.port}`;
}
function service() {
  return new GwsOAuthService(process.env, {
    now: () => now,
    authorizationEndpoint: `${provider}/auth`,
    tokenEndpoint: `${provider}/token`,
    userInfoEndpoint: `${provider}/userinfo`,
  });
}
async function start() {
  oauth = service();
  const app = createRemoteCliApp({
    env: loadRemoteCliEnv(),
    gwsOAuth: oauth,
    configLoader: () => ({ users: [] }),
    mcp: { approvalsDir: join(root, "approvals") },
    gws: {
      execute: async (argv, token) => {
        executions.push({ args: argv, token: token.reveal() });
        return { status: 200, result: executedResult };
      },
    },
  });
  closeApps.push(app.close);
  base = await listen(createServer(app.app));
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thor-continuation-"));
  servers = [];
  closeApps = [];
  messages = [];
  executions = [];
  now = Date.now();
  dmConfirmed = true;
  refreshStatus = 200;
  identityStatus = 200;
  identityBody = { sub: "subject-123", email, email_verified: true };
  networkFailure = false;
  supersedeOnRefresh = false;
  grantRace = "none";
  refreshBody = { access_token: "fixture-command-token" };
  executedResult = { stdout: "Google output", stderr: "", exitCode: 0 };
  provider = await listen(
    createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/token") {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        if (body.get("grant_type") === "authorization_code") {
          res.end(
            JSON.stringify({
              access_token: "fixture-auth-token",
              refresh_token: "fixture-refresh-token",
            }),
          );
        } else {
          if (supersedeOnRefresh)
            appendSessionEvent(owner.sessionId, {
              type: "trigger_start",
              triggerId: "019d0000-0000-7000-8000-000000000003",
              triggerSlackId: "U999",
              correlationKey: "slack:thread:C123/1710000000.001",
            });
          if (grantRace === "disconnect") oauth.disconnect(owner.slackUserId);
          if (grantRace === "replace") await connect();
          if (networkFailure) {
            req.socket.destroy();
            return;
          }
          res.statusCode = refreshStatus;
          res.end(JSON.stringify(refreshBody));
        }
      } else if (req.url === "/userinfo") {
        res.statusCode = identityStatus;
        res.end(JSON.stringify(identityBody));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    }),
  );
  const slack = await listen(
    createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const message = z
        .object({ channel: z.string(), text: z.string() })
        .parse(JSON.parse(Buffer.concat(chunks).toString()));
      messages.push(message);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ ok: true, channel: dmConfirmed ? "D123" : "C123", ts: "1710000000.100" }),
      );
    }),
  );
  const env = {
    WORKLOG_DIR: join(root, "worklog"),
    THOR_INTERNAL_SECRET: secret,
    NODE_ENV: "test",
    SLACK_BOT_TOKEN: "fixture-bot",
    SLACK_API_BASE_URL: `${slack}/api`,
    SLACK_TEAM_ID: "T123",
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "fixture",
    GITHUB_APP_BOT_ID: "1",
    GITHUB_APP_PRIVATE_KEY_FILE: "/tmp/unused.pem",
    GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "fixture-client",
    GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "fixture-secret",
    GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL: "https://neo.example.test",
    GOOGLE_WORKSPACE_OAUTH_SCOPES: "https://www.googleapis.com/auth/drive",
    GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR: join(root, "oauth"),
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  appendAlias({
    aliasType: "opencode.session",
    aliasValue: owner.sessionId,
    anchorId: owner.anchorId,
  });
  appendSessionEvent(owner.sessionId, {
    type: "trigger_start",
    triggerId: owner.triggerId,
    triggerSlackId: owner.slackUserId,
    correlationKey: "slack:thread:C123/1710000000.001",
  });
  await start();
});
afterEach(async () => {
  for (const close of closeApps) await close();
  for (const server of servers.reverse()) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function exec(argv = args) {
  const response = await fetch(`${base}/exec/gws`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-thor-session-id": owner.sessionId },
    body: JSON.stringify({ args: argv }),
  });
  return {
    status: response.status,
    result: GoogleWorkspaceExecResultSchema.parse(await response.json()),
  };
}
async function ready() {
  const response = await fetch(`${base}/internal/google-workspace/continuations`, {
    headers: { "x-thor-internal-secret": secret },
  });
  expect(response.status).toBe(200);
  return z
    .object({ continuations: z.array(GoogleAuthContinuationSchema) })
    .parse(await response.json()).continuations;
}
async function authorize(id: string) {
  const preview = oauth.previewAuthorization(id, email);
  if (!preview.ok) throw preview.error;
  const started = oauth.beginAuthorization(id, email, preview.value.confirmationToken);
  if (!started.ok) throw started.error;
  const state = new URL(started.value.authorizationUrl).searchParams.get("state");
  const response = await fetch(
    `${base}/google-workspace/oauth/callback?code=fixture-code&state=${state}`,
    {
      headers: {
        "x-thor-internal-secret": secret,
        cookie: `thor_gws_oauth_browser=${started.value.browserNonce}`,
      },
    },
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("automatically continue");
  expect(html).not.toContain("approve");
}
async function connect() {
  const request = oauth.createConnectionRequest({ ...owner, expectedGoogleEmail: email });
  if (!request.ok) throw request.error;
  await authorize(request.value.requestId);
}

it("confirms private delivery, reuses concurrent requests, persists encrypted readiness and idempotent ack across reconstruction", async () => {
  const replies = await Promise.all([exec(), exec(), exec()]);
  const wait = replies[0].result.authWait;
  if (!wait) throw new Error("Auth wait missing");
  expect(replies.map((r) => r.status)).toEqual([428, 428, 428]);
  expect(replies.every((r) => r.result.authWait?.id === wait.id)).toBe(true);
  expect(messages).toHaveLength(1);
  expect(messages[0].channel).toBe("U123");
  expect(await ready()).toEqual([]);
  expect(executions).toHaveLength(0);
  expect(JSON.stringify(replies)).not.toContain("private continuation title");
  expect(JSON.stringify(replies)).not.toContain("?request=");
  await start();
  expect((await exec()).result.authWait?.id).toBe(wait.id);
  expect(messages).toHaveLength(1);
  await authorize(wait.id);
  expect(messages).toHaveLength(1); // No misleading public manual-approval notification.
  now += 11 * 60 * 1000; // Original invitation expired; ready outbox survives.
  await start();
  const records = await ready();
  expect(records).toEqual([
    {
      id: wait.id,
      ...owner,
      slackTeamId: "T123",
      args,
      connectionId: expect.any(String),
      createdAtMs: expect.any(Number),
      expiresAtMs: expect.any(Number),
    },
  ]);
  expect(records[0].expiresAtMs).toBe(now - 11 * 60 * 1000 + 24 * 60 * 60 * 1000);
  const raw = await readFile(join(root, "oauth", "continuations", `${wait.id}.json`), "utf8");
  expect(raw).not.toContain("private continuation title");
  expect(raw).not.toContain("fixture-refresh-token");
  expect((await fetch(`${base}/internal/google-workspace/continuations`)).status).toBe(401);
  const ackUrl = `${base}/internal/google-workspace/continuations/${wait.id}/ack`;
  expect((await fetch(ackUrl, { method: "POST" })).status).toBe(401);
  for (let i = 0; i < 2; i++)
    expect(
      (await fetch(ackUrl, { method: "POST", headers: { "x-thor-internal-secret": secret } }))
        .status,
    ).toBe(200);
  await start();
  expect(await ready()).toEqual([]);
  expect((await exec()).result.stdout).toBe("Google output");
  expect(executions).toEqual([{ args, token: "fixture-command-token" }]);
  expect(await readdir(join(root, "approvals", "gws")).catch(() => [])).toEqual([]);
});

it("unconfirmed private delivery cannot yield resumable work even when its leaked-to-Slack link completes OAuth", async () => {
  dmConfirmed = false;
  const reply = await exec();
  expect(reply.status).toBe(502);
  expect(reply.result.authWait).toBeUndefined();
  const id = messages[0].text.match(/request=([A-Za-z0-9_-]+)/)?.[1];
  if (!id) throw new Error("Fixture invitation missing");
  await authorize(id);
  await start();
  expect(await ready()).toEqual([]);
  expect(executions).toHaveLength(0);
});

it("never exposes callback readiness before private DM confirmation, including the callback race", async () => {
  const request = oauth.createAuthContinuation({ ...owner, args });
  if (!request.ok) throw request.error;
  await authorize(request.value.requestId);
  expect(await ready()).toEqual([]);
  expect(oauth.confirmAuthContinuation(request.value.requestId).ok).toBe(true);
  expect(await ready()).toHaveLength(1);
});

it("bounds ready lifetime to 24 hours and does not reuse invitations for different argv or a new turn", async () => {
  const first = await exec();
  expect((await exec(["drive", "files", "list"])).result.authWait?.id).not.toBe(
    first.result.authWait?.id,
  );
  appendSessionEvent(owner.sessionId, {
    type: "trigger_start",
    triggerId: "019d0000-0000-7000-8000-000000000003",
    triggerSlackId: "U999",
    correlationKey: "slack:thread:C123/1710000000.001",
  });
  expect((await exec()).result.authWait?.id).not.toBe(first.result.authWait?.id);
  expect(messages.map((m) => m.channel)).toEqual(["U123", "U123", "U999"]);
  if (!first.result.authWait) throw new Error("Auth wait missing");
  await authorize(first.result.authWait.id);
  now += 24 * 60 * 60 * 1000 + 1;
  expect(await ready()).toEqual([]);
});

it.each(["invalid_grant", "invalid_grant_401", "identity_401"])(
  "waits without executing for definitive trusted credential failure %s",
  async (kind) => {
    await connect();
    if (kind.startsWith("invalid_grant")) {
      refreshStatus = kind === "invalid_grant" ? 400 : 401;
      refreshBody = { error: "invalid_grant" };
    } else identityStatus = 401;
    const reply = await exec();
    expect(reply.status).toBe(428);
    expect(reply.result.authWait).toBeDefined();
    expect(messages).toHaveLength(1);
    expect(executions).toHaveLength(0);
  },
);

it.each([
  "permission_403",
  "refresh_403",
  "refresh_503",
  "malformed",
  "identity_malformed",
  "network",
])("does not create an auth wait for non-credential failure %s", async (kind) => {
  await connect();
  if (kind === "permission_403") identityStatus = 403;
  if (kind === "refresh_403") {
    refreshStatus = 403;
    refreshBody = { error: "invalid_grant" };
  }
  if (kind === "network") networkFailure = true;
  if (kind === "refresh_503") {
    refreshStatus = 503;
    refreshBody = { error: "invalid_grant" };
  }
  if (kind === "malformed") {
    refreshStatus = 400;
    refreshBody = "invalid_grant";
  }
  if (kind === "identity_malformed") identityBody = {};
  const reply = await exec();
  expect(reply.status).toBe(503);
  expect(reply.result.authWait).toBeUndefined();
  expect(messages).toHaveLength(0);
  expect(executions).toHaveLength(0);
  expect(await ready()).toEqual([]);
});

it("passes uncertain provider results through once, never guesses revoked credentials from stderr", async () => {
  await connect();
  executedResult = { stdout: "", stderr: "401 invalid_grant credentials revoked", exitCode: 1 };
  expect((await exec()).result).toEqual(executedResult);
  expect(executions).toHaveLength(1);
  expect(messages).toHaveLength(0);
  expect(await ready()).toEqual([]);
});

it("fails closed when the active requester changes during trusted OAuth HTTP", async () => {
  await connect();
  supersedeOnRefresh = true;
  const reply = await exec();
  expect(reply.status).toBe(403);
  expect(executions).toHaveLength(0);
  expect(messages).toHaveLength(0);
});

it("a failed identity verification callback saves neither a grant nor ready work", async () => {
  const wait = (await exec()).result.authWait;
  if (!wait) throw new Error("Auth wait missing");
  const preview = oauth.previewAuthorization(wait.id, email);
  if (!preview.ok) throw preview.error;
  const started = oauth.beginAuthorization(wait.id, email, preview.value.confirmationToken);
  if (!started.ok) throw started.error;
  identityBody = { sub: "attacker-subject", email: "attacker@example.com", email_verified: true };
  const state = new URL(started.value.authorizationUrl).searchParams.get("state");
  const callback = await fetch(
    `${base}/google-workspace/oauth/callback?code=fixture-code&state=${state}`,
    {
      headers: {
        "x-thor-internal-secret": secret,
        cookie: `thor_gws_oauth_browser=${started.value.browserNonce}`,
      },
    },
  );
  expect(callback.status).toBe(400);
  expect(oauth.findConnectedIdentity(owner.slackUserId).ok).toBe(false);
  await start();
  expect(await ready()).toEqual([]);
});

it("retires only the exact original ready operation before dispatch, so uncertain execution cannot resume again", async () => {
  const wait = (await exec()).result.authWait;
  if (!wait) throw new Error("Auth wait missing");
  expect(
    (
      await fetch(`${base}/internal/google-workspace/continuations/${wait.id}/ack`, {
        method: "POST",
        headers: { "x-thor-internal-secret": secret },
      })
    ).status,
  ).toBe(409);
  await authorize(wait.id);
  await exec(["drive", "files", "list"]);
  expect(await ready()).toHaveLength(1);
  executedResult = {
    stdout: "",
    stderr: "Provider connection lost after possible write",
    exitCode: 1,
  };
  expect((await exec()).result).toEqual(executedResult);
  await start();
  expect(await ready()).toEqual([]);
  expect(executions.map((call) => call.args)).toEqual([["drive", "files", "list"], args]);
});

it("fails closed on corrupt durable readiness without erasing the evidence", async () => {
  const wait = (await exec()).result.authWait;
  if (!wait) throw new Error("Auth wait missing");
  await authorize(wait.id);
  const path = join(root, "oauth", "continuations", `${wait.id}.json`);
  const corrupt = '{"version":1,"iv":"broken","ciphertext":"broken","tag":"broken"}';
  await writeFile(path, corrupt);
  await start();
  const response = await fetch(`${base}/internal/google-workspace/continuations`, {
    headers: { "x-thor-internal-secret": secret },
  });
  expect(response.status).toBe(503);
  expect(await readFile(path, "utf8")).toBe(corrupt);
});

it.each(["disconnect", "replace"] as const)(
  "does not expose a ready continuation after grant %s",
  async (race) => {
    const wait = (await exec()).result.authWait;
    if (!wait) throw new Error("Auth wait missing");
    await authorize(wait.id);
    expect(await ready()).toHaveLength(1);
    if (race === "disconnect") oauth.disconnect(owner.slackUserId);
    else await connect();
    await start();
    expect(await ready()).toEqual([]);
    expect(executions).toHaveLength(0);
  },
);

it.each(["disconnect", "replace"] as const)(
  "never dispatches a retired token when refresh races grant %s",
  async (race) => {
    await connect();
    grantRace = race;
    const response = await exec();
    expect(response.status).toBe(503);
    expect(response.result.authWait).toBeUndefined();
    expect(executions).toHaveLength(0);
    expect(messages).toHaveLength(0);
    if (race === "replace")
      expect(oauth.findConnectedIdentity(owner.slackUserId, email).ok).toBe(true);
  },
);

it("binds resumed dispatch to its original grant and keeps expiry negative authority after pruning", async () => {
  const wait = (await exec()).result.authWait;
  if (!wait) throw new Error("Auth wait missing");
  await authorize(wait.id);
  const record = (await ready())[0];
  const dispatchTriggerId = "019d0000-0000-7000-8000-000000000004";
  const acknowledged = await fetch(
    `${base}/internal/google-workspace/continuations/${wait.id}/ack`,
    {
      method: "POST",
      headers: { "x-thor-internal-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ dispatchTriggerId }),
    },
  );
  expect(acknowledged.status).toBe(200);
  for (const trigger of [dispatchTriggerId, "019d0000-0000-7000-8000-000000000005"]) {
    const replay = await fetch(`${base}/internal/google-workspace/continuations/${wait.id}/ack`, {
      method: "POST",
      headers: { "x-thor-internal-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ dispatchTriggerId: trigger }),
    });
    expect(replay.status).toBe(trigger === dispatchTriggerId ? 200 : 503);
  }
  appendSessionEvent(owner.sessionId, {
    type: "trigger_start",
    triggerId: dispatchTriggerId,
    triggerSlackId: owner.slackUserId,
  });
  await connect(); // Same verified email, but a replaced grant must not execute the old task.
  expect((await exec()).status).toBe(403);
  now = record.expiresAtMs + 1;
  expect(await ready()).toEqual([]); // Executes expiry pruning.
  await start();
  expect((await exec()).status).toBe(403);
  expect(executions).toHaveLength(0);
});

it("a revoked old refresh cannot disconnect a replacement grant or create a spurious wait", async () => {
  await connect();
  grantRace = "replace";
  refreshStatus = 400;
  refreshBody = { error: "invalid_grant" };
  const response = await exec();
  expect(response.status).toBe(503);
  expect(response.result.authWait).toBeUndefined();
  expect(oauth.findConnectedIdentity(owner.slackUserId, email).ok).toBe(true);
  expect(executions).toHaveLength(0);
  expect(messages).toHaveLength(0);
});

it("never revives an unbound retired outbox record as a resumed dispatch", async () => {
  const wait = (await exec()).result.authWait;
  if (!wait) throw new Error("Auth wait missing");
  await authorize(wait.id);
  expect(oauth.acknowledgeContinuation(wait.id).ok).toBe(true);
  expect(oauth.acknowledgeContinuation(wait.id, "019d0000-0000-7000-8000-000000000004").ok).toBe(
    false,
  );
  expect(
    oauth.acknowledgeContinuation(
      "unknown_invitation_fixture",
      "019d0000-0000-7000-8000-000000000004",
    ).ok,
  ).toBe(false);
  expect(executions).toHaveLength(0);
});
