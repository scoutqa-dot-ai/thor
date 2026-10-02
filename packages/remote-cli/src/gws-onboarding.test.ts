import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendAlias, appendSessionEvent, loadRemoteCliEnv, ExecResultSchema } from "@thor/common";
import { z } from "zod";
import { createRemoteCliApp } from "./index.js";

let root: string;
let servers: Server[];
let closeApp: (() => Promise<void>) | undefined;
let baseUrl: string;
let profile: unknown;
let dm: unknown;
let dmStatus: number;
let dmRedirect: string | undefined;
let messages: Array<{ channel: string; text: string }>;
let profileRequests: number;
const secret = "fixture-internal-secret";
const member = {
  id: "U123",
  team_id: "T123",
  deleted: false,
  is_bot: false,
  profile: { email: "person@example.com" },
};

async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("GWS onboarding fixture listener missing");
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thor-gws-startup-"));
  servers = [];
  messages = [];
  profileRequests = 0;
  profile = { ok: true, user: member };
  dm = { ok: true, channel: "D123", ts: "1710000000.100" };
  dmStatus = 200;
  dmRedirect = undefined;
  const slackUrl = await listen(
    createServer(async (req, res) => {
      expect(req.headers.authorization).toBe("Bearer fixture-bot-token");
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/api/users.info")) {
        profileRequests++;
        res.end(JSON.stringify(profile));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = z
        .object({ channel: z.string(), text: z.string() })
        .parse(JSON.parse(Buffer.concat(chunks).toString()));
      res.statusCode = dmStatus;
      if (dmRedirect) res.setHeader("location", dmRedirect);
      messages.push({ channel: body.channel, text: body.text });
      res.end(JSON.stringify(dm));
    }),
  );
  const env = {
    WORKLOG_DIR: join(root, "worklog"),
    NODE_ENV: "production",
    SLACK_BOT_TOKEN: "fixture-bot-token",
    SLACK_API_BASE_URL: `${slackUrl}/api`,
    THOR_INTERNAL_SECRET: secret,
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "fixture",
    GITHUB_APP_BOT_ID: "1",
    GITHUB_APP_PRIVATE_KEY_FILE: join(root, "unused.pem"),
    GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "fixture-client",
    GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "fixture-secret",
    GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL: "https://thor.example.test",
    GOOGLE_WORKSPACE_OAUTH_SCOPES: "https://www.googleapis.com/auth/drive",
    GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR: join(root, "oauth"),
    SLACK_TEAM_ID: "T123",
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const anchorId = "019d0000-0000-7000-8000-000000000001";
  appendAlias({ aliasType: "opencode.session", aliasValue: "startup-session", anchorId });
  appendSessionEvent("startup-session", {
    type: "trigger_start",
    triggerId: "019d0000-0000-7000-8000-000000000002",
    triggerSlackId: "U123",
    correlationKey: "slack:thread:C123/1710000000.001",
  });
});

afterEach(async () => {
  await closeApp?.();
  closeApp = undefined;
  for (const server of servers.reverse()) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function start() {
  // Same environment loader and factory used by startRemoteCliServer; no injected OAuth, Slack token/base or fetch fake.
  const remote = createRemoteCliApp({
    env: loadRemoteCliEnv(),
    configLoader: () => ({ users: [] }),
    mcp: { approvalsDir: join(root, "approvals") },
  });
  closeApp = remote.close;
  baseUrl = await listen(createServer(remote.app));
}
async function request() {
  const response = await fetch(`${baseUrl}/exec/gws`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-thor-session-id": "startup-session" },
    body: JSON.stringify({ args: ["drive", "files", "list"] }),
  });
  return { status: response.status, result: ExecResultSchema.parse(await response.json()) };
}

it("loads production Slack/OAuth env and reports success only after a confirmed private DM", async () => {
  await start();
  const reply = await request();
  expect(reply.status).toBe(428);
  expect(reply.result.stderr).toContain("private authorization link was sent");
  expect(messages).toHaveLength(1);
  expect(messages[0].channel).toBe("U123");
  expect(messages[0].text).toContain("https://thor.example.test/google-workspace/connect?request=");
  expect(JSON.stringify(reply)).not.toContain("?request=");
});

it.each(["missing client secret", "invalid encryption key", "invalid origin", "invalid scopes"])(
  "classifies %s as OAuth setup, never member verification or a sent link",
  async (kind) => {
    if (kind === "missing client secret") vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", "");
    if (kind === "invalid encryption key")
      vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY", "not-a-key");
    if (kind === "invalid origin")
      vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL", "http://thor.example.test");
    if (kind === "invalid scopes") vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_SCOPES", "drive,docs,sheets");
    await start();
    const reply = await request();
    expect(reply.status).toBe(503);
    expect(reply.result.stderr).toContain("No authorization DM was sent");
    expect(messages).toHaveLength(0);
    expect(profileRequests).toBe(0);
    const health = z
      .object({
        googleWorkspaceOAuth: z.object({
          configured: z.boolean(),
          missing: z.array(z.string()),
          invalid: z.array(z.string()),
        }),
      })
      .parse(await (await fetch(`${baseUrl}/health`)).json());
    expect(health.googleWorkspaceOAuth.configured).toBe(false);
    expect([
      ...health.googleWorkspaceOAuth.missing,
      ...health.googleWorkspaceOAuth.invalid,
    ]).toHaveLength(1);
    expect(JSON.stringify(health)).not.toContain("fixture-secret");
    expect(JSON.stringify(health)).not.toContain("fixture-bot-token");
  },
);

it("sends the private link without Slack email permissions; diagnostics require operator authentication", async () => {
  profile = {
    ok: false,
    error: "missing_scope",
    needed: "users:read.email",
    provided: "chat:write",
  };
  await start();
  const reply = await request();
  expect(reply.status).toBe(428);
  expect(reply.result.stderr).toContain("private authorization link was sent");
  expect(messages).toHaveLength(1);
  expect(profileRequests).toBe(0);
  const denied = await fetch(`${baseUrl}/internal/google-workspace/diagnostics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slackUserId: "U123" }),
  });
  expect(denied.status).toBe(401);
  const probe = await fetch(`${baseUrl}/internal/google-workspace/diagnostics`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-thor-internal-secret": secret },
    body: JSON.stringify({ slackUserId: "U123" }),
  });
  expect(await probe.json()).toMatchObject({
    oauth: { configured: true },
    identity: { ok: true, pinned: false, connected: false },
  });
  expect(messages).toHaveLength(1);
  expect(profileRequests).toBe(0);
});

it("uses trusted requester attribution rather than an unrelated or unavailable Slack profile", async () => {
  profile = { ok: true, user: { ...member, id: "UOTHER", team_id: "TOTHER", profile: {} } };
  await start();
  const reply = await request();
  expect(reply.status).toBe(428);
  expect(messages[0].channel).toBe("U123");
  expect(profileRequests).toBe(0);
});

it.each(["rejected", "unconfirmed"])(
  "does not claim private delivery when Slack returns %s",
  async (kind) => {
    dm =
      kind === "rejected"
        ? { ok: false, error: "messages_tab_disabled" }
        : { ok: true, channel: "C123", ts: "1710000000.100" };
    await start();
    const reply = await request();
    expect(reply.status).toBe(kind === "rejected" ? 503 : 502);
    expect(reply.result.stderr).not.toContain("private authorization link was sent");
    expect(JSON.stringify(reply)).not.toContain("?request=");
  },
);

it("does not forward private connection links or the bot credential through Slack API redirects", async () => {
  let forwarded = 0;
  dmRedirect = await listen(
    createServer((_req, res) => {
      forwarded++;
      res.end("unexpected");
    }),
  );
  dmStatus = 307;
  await start();
  const reply = await request();
  expect(reply.status).toBe(503);
  expect(forwarded).toBe(0);
  expect(reply.result.stderr).not.toContain("private authorization link was sent");
});

it("distinguishes a lost browser cookie from missing SSO identity without exposing either value", async () => {
  await start();
  const headers = { "x-thor-internal-secret": secret, "x-vouch-user": "person@example.com" };
  const lost = await fetch(`${baseUrl}/google-workspace/connect/authorize`, { headers });
  expect(lost.status).toBe(400);
  expect(await lost.text()).toContain("connection cookie is missing or expired");
  await request();
  const link = /<(https:\/\/[^|]+)\|Connect Google Workspace>/.exec(messages[0].text)?.[1];
  if (!link) throw new Error("GWS browser context fixture link missing");
  const staged = await fetch(link.replace("https://thor.example.test", baseUrl), {
    redirect: "manual",
    headers,
  });
  const cookie = staged.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("GWS browser context fixture cookie missing");
  const unsigned = await fetch(`${baseUrl}/google-workspace/connect/authorize`, {
    headers: { "x-thor-internal-secret": secret, cookie },
  });
  expect(unsigned.status).toBe(400);
  expect(await unsigned.text()).toContain("Browser sign-in identity was not forwarded");
  expect(unsigned.headers.get("set-cookie")).toBeNull();
  const retry = await fetch(`${baseUrl}/google-workspace/connect/authorize`, {
    headers: { ...headers, cookie },
  });
  expect(retry.status).toBe(200);
  expect(await retry.text()).toContain("Confirm Google Workspace connection");
});
