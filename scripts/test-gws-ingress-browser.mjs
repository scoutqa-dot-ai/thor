#!/usr/bin/env node
// Real Chromium + shipped Nginx template, local fake SSO/Google providers, no live accounts.
// Requires Linux Docker, openssl and Chromium. Optional first arg: browser executable.
import assert from "node:assert/strict";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { GwsOAuthService, createRemoteCliApp } from "../packages/remote-cli/src/index.ts";
const require = createRequire(
  new URL("../packages/onepassword-browser-mcp/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");
const root = await mkdtemp(join(tmpdir(), "thor-gws-nginx-probe-"));
const servers = [];
const container = "thor-gws-ingress-probe-" + process.pid;
let browser, remote;
let ingressPort;
const forwarded = [];
async function listen(server, host = "localhost", scheme = "http") {
  servers.push(server);
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  return `${scheme}://${host}:${server.address().port}`;
}
try {
  process.env.THOR_INTERNAL_SECRET = "fixture-internal-secret";
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
  const publicUrl = await listen(
    httpsServer(tls, (req, res) => {
      const p = httpRequest(
        {
          host: "127.0.0.1",
          port: ingressPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      p.on("error", () => {
        res.statusCode = 502;
        res.end();
      });
      req.pipe(p);
    }),
    "localhost",
    "https",
  );
  const broker = await listen(
    httpServer((req, res) => {
      forwarded.push({
        path: req.url.split("?")[0],
        requestCookiePresent: req.headers.cookie?.includes("thor_gws_connect_request=") ?? false,
        identityPresent: !!req.headers["x-vouch-user"],
      });
      remote.app(req, res);
    }),
  );
  const provider = await listen(
    httpServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/userinfo"
            ? { sub: "fixture-google-subject", email: "fixture@example.test", email_verified: true }
            : {
                access_token: "fixture-access",
                refresh_token: "fixture-refresh",
                expires_in: 3600,
              },
        ),
      );
    }),
  );
  const login = await listen(
    httpsServer(tls, (req, res) => {
      const url = new URL(req.url, "https://fixture");
      res.setHeader("content-type", "text/html");
      if (url.pathname === "/google/authorize") {
        assert.equal(url.searchParams.get("prompt"), "select_account consent");
        const state = url.searchParams.get("state");
        res.end(
          `<h1>Google account selection fixture</h1><a href="${publicUrl}/google-workspace/oauth/callback?state=${encodeURIComponent(state)}&code=fixture-code">Choose fixture Google account and consent</a>`,
        );
      } else res.end(`<a href="${publicUrl}/vouch/auth">Select fixture Google account for SSO</a>`);
    }),
    "127.0.0.1",
    "https",
  );
  const oauth = new GwsOAuthService(
    {
      GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "fixture-client",
      GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "fixture-secret",
      GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL: publicUrl,
      GOOGLE_WORKSPACE_OAUTH_SCOPES: "https://www.googleapis.com/auth/drive",
      GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
      GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR: join(root, "oauth"),
      SLACK_TEAM_ID: "T123",
    },
    {
      authorizationEndpoint: login + "/google/authorize",
      tokenEndpoint: provider + "/token",
      userInfoEndpoint: provider + "/userinfo",
    },
  );
  remote = createRemoteCliApp({
    gwsOAuth: oauth,
    configLoader: () => ({ users: [] }),
    mcp: { approvalsDir: join(root, "approvals") },
  });

  const fakeVouch = await listen(
    httpServer((req, res) => {
      if (req.url === "/vouch/validate") {
        if (!req.headers.cookie?.includes("fixture_sso=1")) {
          res.statusCode = 401;
          res.end();
          return;
        }
        res.setHeader("X-Vouch-User", "fixture@example.test");
        res.end("ok");
      } else if (req.url.startsWith("/vouch/login")) {
        res.writeHead(302, { location: login });
        res.end();
      } else if (req.url === "/vouch/auth") {
        res.writeHead(302, {
          "set-cookie": "fixture_sso=1; Path=/; Secure; HttpOnly; SameSite=Lax",
          location: publicUrl + "/google-workspace/connect/authorize",
        });
        res.end();
      } else {
        res.statusCode = 404;
        res.end();
      }
    }),
  );
  let conf = await readFile(
    new URL("../docker/ingress/nginx.conf.template", import.meta.url),
    "utf8",
  );
  const reserv = httpServer();
  await new Promise((resolve) => reserv.listen(0, "127.0.0.1", resolve));
  ingressPort = reserv.address().port;
  await new Promise((resolve) => reserv.close(resolve));
  const gateway = "127.0.0.1";
  conf = conf.replace("listen 8080;", `listen 127.0.0.1:${ingressPort};`);
  conf = conf
    .replaceAll("${THOR_ADMIN_EMAILS_REGEX}", "nobody@example.test")
    .replaceAll("${THOR_AGENT_UPSTREAM}", "http://127.0.0.1:8080")
    .replaceAll("${THOR_INTERNAL_SECRET}", process.env.THOR_INTERNAL_SECRET)
    .replaceAll("${GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL}", publicUrl)
    .replaceAll("remote-cli:3004", gateway + ":" + new URL(broker).port)
    .replaceAll("vouch:9090", gateway + ":" + new URL(fakeVouch).port);
  await writeFile(join(root, "nginx.conf"), conf);
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      container,
      "--network",
      "host",
      "-v",
      join(root, "nginx.conf") + ":/etc/nginx/conf.d/default.conf:ro",
      "-v",
      fileURLToPath(new URL("../docker/ingress/static/", import.meta.url)) +
        ":/usr/share/nginx/thor-brand:ro",
      "--entrypoint",
      "nginx",
      "nginx:alpine",
      "-g",
      "daemon off;",
    ],
    { stdio: "ignore" },
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.argv[2] ? { executablePath: process.argv[2] } : {}),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  // Public branding assets work before login, including historical bookmarked URLs.
  const manifestResponse = await context.request.get(publicUrl + "/site.webmanifest");
  assert.equal(manifestResponse.status(), 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.name, "Neo");
  for (const icon of manifest.icons) {
    const response = await context.request.get(publicUrl + icon.src);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["content-type"], "image/png");
  }
  const currentIcon = await context.request.get(publicUrl + "/favicon-v4.svg");
  const legacyIcon = await context.request.get(publicUrl + "/favicon-v3.svg");
  assert.equal(currentIcon.status(), 200);
  assert.equal(legacyIcon.status(), 200);
  assert.match(await currentIcon.text(), /aria-label="Neo"/);
  assert.equal(await legacyIcon.text(), await currentIcon.text());
  console.log("PASS: public Neo manifest/icons and legacy asset URL compatibility");
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error")
      console.log("Browser console error:", msg.text().replace(/\?[^\s"']*/g, "?[REDACTED]"));
  });
  const invitation = oauth.createConnectionRequest({
    slackUserId: "U123",
    sessionId: "fixture-session",
    anchorId: "fixture-anchor",
    triggerId: "fixture-trigger",
  });
  if (!invitation.ok) throw invitation.error;
  try {
    await page.goto(invitation.value.connectUrl);
    await page.getByRole("link", { name: "Select fixture Google account for SSO" }).click();
    await page.getByRole("heading", { name: "Confirm Google Workspace connection" }).waitFor();
  } catch (err) {
    console.log("Forwarded flags:", forwarded);
    console.log(execFileSync("docker", ["logs", container], { encoding: "utf8" }));
    throw err;
  }
  console.log("Page heading:", await page.locator("h1").innerText());
  console.log("Forwarded flags:", forwarded);
  assert.equal(await page.locator("h1").innerText(), "Confirm Google Workspace connection");
  await page.getByRole("button", { name: "Connect this Google account" }).click();
  console.log(
    "After confirmation:",
    new URL(page.url()).pathname,
    await page.locator("h1").innerText(),
  );
  await page.getByRole("heading", { name: "Google account selection fixture" }).waitFor();
  await page.getByRole("link", { name: "Choose fixture Google account and consent" }).click();
  await page.getByRole("heading", { name: "Google Workspace connected" }).waitFor();
  assert.match(await page.locator("body").innerText(), /Neo will automatically continue/);
  assert.equal(oauth.findConnectedIdentity("U123").ok, true);
  console.log(
    "PASS: real Chromium/shipped Nginx cold SSO login, scoped cookies, Google chooser/consent and verified owner callback grant",
  );
} finally {
  await browser?.close();
  try {
    execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  } catch {}
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  await remote?.close();
  await rm(root, { recursive: true, force: true });
}
