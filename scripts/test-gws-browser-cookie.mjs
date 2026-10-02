#!/usr/bin/env node
// Real Chromium cookie handoff regression. Run with the repository tsx loader:
// node --import ./packages/runner/node_modules/tsx/dist/loader.mjs scripts/test-gws-browser-cookie.mjs /path/to/chromium
// Local HTTPS fixtures only; no Google/Slack calls, live profiles or production stack.
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { GwsOAuthService, createRemoteCliApp } from "../packages/remote-cli/src/index.ts";

const require = createRequire(
  new URL("../packages/onepassword-browser-mcp/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");
const root = await mkdtemp(join(tmpdir(), "thor-gws-browser-cookie-"));
const servers = [];
let browser;
let remote;
const originalSecret = process.env.THOR_INTERNAL_SECRET;
const originalWorklog = process.env.WORKLOG_DIR;
try {
  process.env.THOR_INTERNAL_SECRET = "fixture-cookie-probe-secret";
  process.env.WORKLOG_DIR = join(root, "worklog");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  const tls = {
    key: await readFile(join(root, "key.pem")),
    cert: await readFile(join(root, "cert.pem")),
  };
  const oauth = new GwsOAuthService({
    GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "fixture-client",
    GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "fixture-secret",
    GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL: "https://thor.example.test",
    GOOGLE_WORKSPACE_OAUTH_SCOPES: "https://www.googleapis.com/auth/drive",
    GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
    GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR: join(root, "oauth"),
    SLACK_TEAM_ID: "T123",
  });
  remote = createRemoteCliApp({
    gwsOAuth: oauth,
    configLoader: () => ({ users: [] }),
    mcp: { approvalsDir: join(root, "approvals") },
  });
  async function listen(server, host) {
    servers.push(server);
    server.listen(0, "0.0.0.0");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("GWS browser fixture listener missing");
    return `https://${host}:${address.port}`;
  }
  const brokerUrl = await listen(
    createServer(tls, (req, res) => {
      // Local fake ingress supplies trusted browser identity; never deployed.
      req.headers["x-thor-internal-secret"] = process.env.THOR_INTERNAL_SECRET;
      req.headers["x-vouch-user"] = "fixture@example.test";
      remote.app(req, res);
    }),
    "localhost",
  );
  const loginUrl = await listen(
    createServer(tls, (_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<form method="post" action="${brokerUrl}/google-workspace/connect/authorize"><button>Return from cross-site login</button></form>`,
      );
    }),
    "127.0.0.1",
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.argv[2] ? { executablePath: process.argv[2] } : {}),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const invitation = oauth.createConnectionRequest({
    slackUserId: "U123",
    sessionId: "fixture-session",
    anchorId: "fixture-anchor",
    triggerId: "fixture-trigger",
  });
  if (!invitation.ok) throw invitation.error;
  await page.goto(invitation.value.connectUrl.replace("https://thor.example.test", brokerUrl));
  await page.getByRole("heading", { name: "Confirm Google Workspace connection" }).waitFor();
  let cookies = (await context.cookies()).filter(
    (cookie) => cookie.name === "thor_gws_connect_request",
  );
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].sameSite, "Lax");
  assert.equal(cookies[0].secure, true);
  assert.equal(cookies[0].httpOnly, true);
  await page.goto(loginUrl);
  await page.getByRole("button", { name: "Return from cross-site login" }).click();
  await page.getByRole("heading", { name: "Resume Google Workspace connection" }).waitFor();
  cookies = (await context.cookies()).filter(
    (cookie) => cookie.name === "thor_gws_connect_request",
  );
  assert.equal(
    cookies.length,
    1,
    "A withheld Lax cookie must not be deleted by the error response",
  );
  await page.getByRole("link", { name: "Continue securely in this browser" }).click();
  await page.getByRole("heading", { name: "Confirm Google Workspace connection" }).waitFor();
  assert.equal(
    oauth.findConnectedIdentity("U123").ok,
    false,
    "Recovery must not bypass account confirmation or authorize a grant",
  );
  await context.close();
  console.log(
    "PASS: real Chromium stores scoped Secure/HttpOnly Lax cookie, withholds it on cross-site POST, preserves it and resumes safely on same-site click",
  );
} finally {
  await browser?.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await remote?.close();
  if (originalSecret === undefined) delete process.env.THOR_INTERNAL_SECRET;
  else process.env.THOR_INTERNAL_SECRET = originalSecret;
  if (originalWorklog === undefined) delete process.env.WORKLOG_DIR;
  else process.env.WORKLOG_DIR = originalWorklog;
  await rm(root, { recursive: true, force: true });
}
