import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendAlias,
  appendSessionEvent,
  ApprovalRequiredEventPayloadSchema,
  ExecResultSchema,
  type ApprovalRequiredEventPayload,
} from "@thor/common";
import { createRemoteCliApp } from "./index.js";
import { GwsOAuthService, type GwsAccessToken } from "./gws-oauth.js";

const sessionId = "gws-owner-session";
const slackUserId = "U123";
const googleEmail = "person@example.com";
const anchorId = "019d0000-0000-7000-8000-000000000001";
const triggerId = "019d0000-0000-7000-8000-000000000002";
const internalSecret = "fixture-internal-secret";

let root: string;
let server: Server | undefined;
let closeApp: (() => Promise<void>) | undefined;
let baseUrl: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thor-gws-user-flow-"));
  vi.stubEnv("WORKLOG_DIR", join(root, "worklogs"));
  vi.stubEnv("THOR_INTERNAL_SECRET", internalSecret);
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await closeApp?.();
  server = undefined;
  closeApp = undefined;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function oauthEnv(): NodeJS.ProcessEnv {
  return {
    GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "fixture-client-id",
    GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "fixture-client-secret",
    GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL: "https://thor.example.test",
    GOOGLE_WORKSPACE_OAUTH_SCOPES:
      "https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/documents,https://www.googleapis.com/auth/spreadsheets",
    GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
    GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR: join(root, "oauth"),
    SLACK_TEAM_ID: "T123",
  };
}

async function connect(service: GwsOAuthService): Promise<void> {
  const request = service.createConnectionRequest({
    slackUserId,
    expectedGoogleEmail: googleEmail,
    sessionId,
    anchorId,
    triggerId,
  });
  if (!request.ok) throw request.error;
  const authorization = service.beginAuthorization(request.value.requestId, googleEmail);
  if (!authorization.ok) throw authorization.error;
  const state = new URL(authorization.value.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("fixture state missing");
  const completed = await service.completeAuthorization({
    state,
    code: "fixture-code",
    browserNonce: authorization.value.browserNonce,
  });
  if (!completed.ok) throw completed.error;
}

function providerFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/token")) {
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
      if (body.get("grant_type") === "authorization_code") {
        return Response.json({
          access_token: "fixture-authorization-token",
          refresh_token: "fixture-refresh-token",
          expires_in: 3600,
        });
      }
      return Response.json({ access_token: "fixture-command-token", expires_in: 3600 });
    }
    if (url.endsWith("/userinfo")) {
      return Response.json({
        sub: "google-subject-123",
        email: googleEmail,
        email_verified: true,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, result: ExecResultSchema.parse(await response.json()) };
}

describe("per-user Google Workspace execution", () => {
  it.each([true, false])(
    "requires owner approval, executes once and disconnects (explicit pin: %s)",
    async (explicitPin) => {
      const oauth = new GwsOAuthService(oauthEnv(), {
        fetch: providerFetch(),
        authorizationEndpoint: "https://provider.example.test/auth",
        tokenEndpoint: "https://provider.example.test/token",
        userInfoEndpoint: "https://provider.example.test/userinfo",
      });
      await connect(oauth);

      appendAlias({ aliasType: "opencode.session", aliasValue: sessionId, anchorId });
      appendAlias({
        aliasType: "slack.thread",
        aliasValue: "C123/1710000000.001",
        anchorId,
      });
      appendSessionEvent(sessionId, {
        type: "trigger_start",
        triggerId,
        triggerSlackId: slackUserId,
        correlationKey: "slack:thread:C123/1710000000.001",
      });

      let currentEmail = googleEmail;
      let restrictEmailAfterApproval = false;
      const executions: Array<{ args: string[]; token: string }> = [];
      const slackBodies: string[] = [];
      const remoteCli = createRemoteCliApp({
        env: {
          port: 3004,
          nodeEnv: "test",
          slackBotToken: "xoxb-test",
          slackApiBaseUrl: "https://slack.example.test/api",
          thorInternalSecret: internalSecret,
          githubAppId: "app-id",
          githubAppSlug: "thor-github-app",
          githubAppBotId: "12345",
          githubAppPrivateKeyFile: "/tmp/private-key.pem",
          gitIdentityName: "thor[bot]",
          gitIdentityEmail: "thor@example.com",
        },
        configLoader: () => ({
          users: [
            {
              email: googleEmail,
              name: "Fixture Person",
              slack: slackUserId,
              ...(explicitPin || restrictEmailAfterApproval
                ? { google_workspace_email: currentEmail }
                : {}),
            },
          ],
        }),
        gwsOAuth: oauth,
        gws: {
          execute: async (args: string[], token: GwsAccessToken) => {
            executions.push({ args, token: token.reveal() });
            return {
              status: 200 as const,
              result: { stdout: "fixture command output", stderr: "", exitCode: 0 },
            };
          },
        },
        mcp: {
          approvalsDir: join(root, "approvals"),
          writeToolCallLogFn: () => {},
          fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
            if (String(_input).includes("/users.info"))
              return Response.json({
                ok: true,
                user: {
                  id: slackUserId,
                  team_id: "T123",
                  deleted: false,
                  is_bot: false,
                  profile: { email: currentEmail },
                },
              });
            slackBodies.push(String(init?.body ?? ""));
            const message = JSON.parse(String(init?.body ?? "{}"));
            return Response.json({
              ok: true,
              channel: message.channel?.startsWith("U") ? "D123" : "C123",
              ts: "1710000000.100",
            });
          }) as typeof fetch,
        },
      });
      closeApp = remoteCli.close;
      server = createServer(remoteCli.app);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture listener missing");
      baseUrl = `http://127.0.0.1:${address.port}`;

      const browserRequest = oauth.createConnectionRequest({
        slackUserId,
        expectedGoogleEmail: googleEmail,
        sessionId,
        anchorId,
        triggerId,
      });
      if (!browserRequest.ok) throw browserRequest.error;
      const staged = await fetch(
        browserRequest.value.connectUrl.replace("https://thor.example.test", baseUrl),
        {
          redirect: "manual",
          headers: { "x-thor-internal-secret": internalSecret },
        },
      );
      expect(staged.status).toBe(302);
      expect(staged.headers.get("location")).toBe("/google-workspace/connect/authorize");
      const requestCookie = staged.headers.get("set-cookie")?.split(";")[0];
      if (!requestCookie) throw new Error("connection request cookie missing");
      const authorized = await fetch(`${baseUrl}/google-workspace/connect/authorize`, {
        redirect: "manual",
        headers: {
          cookie: requestCookie,
          "x-thor-internal-secret": internalSecret,
          "x-vouch-user": googleEmail,
        },
      });
      expect(authorized.status).toBe(302);
      expect(authorized.headers.get("location")).toContain("https://provider.example.test/auth");
      expect(authorized.headers.get("location")).not.toContain(browserRequest.value.requestId);

      const args = ["drive", "files", "update", "--json", '{"name":"private title"}'];
      const pending = await post(
        "/exec/gws",
        { args },
        { "x-thor-session-id": sessionId, "x-thor-call-id": "call-1" },
      );
      expect(pending.status).toBe(200);
      expect(executions).toHaveLength(0);
      const event = JSON.parse(pending.result.stdout) as ApprovalRequiredEventPayload;
      expect(event).toMatchObject({
        type: "approval_required",
        tool: "google_workspace_command",
        args: {
          operation: "drive.files.update",
          argument_count: args.length,
          google_workspace_email: googleEmail,
          slack_user_id: slackUserId,
        },
      });
      expect(event.args).not.toHaveProperty("argv");
      expect(slackBodies.join("\n")).not.toContain("private title");

      const wrongRejector = await post(
        "/exec/mcp",
        { args: ["resolve", event.actionId, "rejected", "U999"] },
        { "x-thor-internal-secret": internalSecret },
      );
      expect(wrongRejector.result.exitCode).toBe(1);

      const wrongReviewer = await post(
        "/exec/mcp",
        { args: ["resolve", event.actionId, "approved", "U999"] },
        { "x-thor-internal-secret": internalSecret },
      );
      expect(wrongReviewer.result.exitCode).toBe(1);
      expect(executions).toHaveLength(0);

      const approved = await post(
        "/exec/mcp",
        { args: ["resolve", event.actionId, "approved", slackUserId] },
        { "x-thor-internal-secret": internalSecret },
      );
      const resolution = JSON.parse(approved.result.stdout) as {
        status: string;
        tool: string;
        upstream: string;
        result_available: boolean;
        result_capability: string;
      };
      expect(resolution).toMatchObject({
        status: "completed",
        tool: "google_workspace_command",
        upstream: "gws",
        result_available: true,
      });
      expect(resolution.result_capability).toMatch(/^[A-Za-z0-9_-]{32,200}$/);
      expect(approved.result.exitCode).toBe(0);
      expect(executions).toEqual([{ args, token: "fixture-command-token" }]);

      const wrongReviewerReplay = await post(
        "/exec/mcp",
        { args: ["resolve", event.actionId, "approved", "U999"] },
        { "x-thor-internal-secret": internalSecret },
      );
      expect(wrongReviewerReplay.result.exitCode).toBe(1);
      expect(wrongReviewerReplay.result.stdout).not.toContain("result_capability");

      const status = await post("/exec/approval", { args: ["status", event.actionId] });
      expect(status.result.exitCode).toBe(0);
      expect(status.result.stdout).not.toContain("result_capability");
      expect(status.result.stdout).not.toContain("fixture command output");

      const wrongCapability = await post(
        "/exec/approval",
        { args: ["result", event.actionId, "wrong-capability-value-that-is-long-enough"] },
        { "x-thor-session-id": sessionId },
      );
      expect(wrongCapability.result.exitCode).toBe(1);
      expect(wrongCapability.result.stdout).toBe("");

      const result = await post(
        "/exec/approval",
        { args: ["result", event.actionId, resolution.result_capability] },
        { "x-thor-session-id": sessionId },
      );
      expect(result.result).toEqual({
        stdout: "fixture command output",
        stderr: "",
        exitCode: 0,
      });

      const resultReplay = await post(
        "/exec/approval",
        { args: ["result", event.actionId, resolution.result_capability] },
        { "x-thor-session-id": sessionId },
      );
      expect(resultReplay.result.exitCode).toBe(1);

      const replay = await post(
        "/exec/mcp",
        { args: ["resolve", event.actionId, "approved", slackUserId] },
        { "x-thor-internal-secret": internalSecret },
      );
      expect(replay.result.exitCode).toBe(0);
      expect(JSON.parse(replay.result.stdout)).toMatchObject({
        status: "completed",
        result_available: true,
      });
      expect(executions).toHaveLength(1);

      const beforeReconnect = await post("/exec/gws", { args }, { "x-thor-session-id": sessionId });
      const oldConnectionAction = ApprovalRequiredEventPayloadSchema.parse(
        JSON.parse(beforeReconnect.result.stdout),
      );
      await connect(oauth);
      const replaced = await post(
        "/exec/mcp",
        { args: ["resolve", oldConnectionAction.actionId, "approved", slackUserId] },
        { "x-thor-internal-secret": internalSecret },
      );
      expect(replaced.result.exitCode).toBe(1);
      expect(executions).toHaveLength(1);

      const changedPending = await post(
        "/exec/gws",
        { args: ["drive", "files", "list"] },
        { "x-thor-session-id": sessionId },
      );
      const changedEvent = ApprovalRequiredEventPayloadSchema.parse(
        JSON.parse(changedPending.result.stdout),
      );
      currentEmail = "changed@example.com";
      restrictEmailAfterApproval = true;
      await post(
        "/exec/mcp",
        { args: ["resolve", changedEvent.actionId, "approved", slackUserId] },
        { "x-thor-internal-secret": internalSecret },
      );
      expect(executions).toHaveLength(1);
      currentEmail = googleEmail;
      const wrongDisconnect = await fetch(`${baseUrl}/google-workspace/disconnect`, {
        headers: {
          "x-thor-internal-secret": internalSecret,
          "x-vouch-user": "another@example.com",
        },
      });
      expect(wrongDisconnect.status).toBe(403);
      const disconnectPage = await fetch(`${baseUrl}/google-workspace/disconnect`, {
        headers: {
          "x-thor-internal-secret": internalSecret,
          "x-vouch-user": googleEmail,
        },
      });
      expect(disconnectPage.status).toBe(200);
      expect(disconnectPage.headers.get("content-security-policy")).toContain("form-action 'self'");
      const disconnectHtml = await disconnectPage.text();
      const csrf = disconnectHtml.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
      expect(csrf).toBeTruthy();
      const disconnectCookie = disconnectPage.headers.get("set-cookie")?.split(";")[0];
      expect(disconnectCookie).toBeTruthy();
      if (!csrf || !disconnectCookie) throw new Error("disconnect fixture tokens missing");

      const csrfRejected = await fetch(`${baseUrl}/google-workspace/disconnect`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-thor-internal-secret": internalSecret,
          "x-vouch-user": googleEmail,
        },
        body: new URLSearchParams({ csrf }),
      });
      expect(csrfRejected.status).toBe(403);
      expect(oauth.findConnectedIdentity(slackUserId, googleEmail).ok).toBe(true);

      const freshDisconnectPage = await fetch(`${baseUrl}/google-workspace/disconnect`, {
        headers: {
          "x-thor-internal-secret": internalSecret,
          "x-vouch-user": googleEmail,
        },
      });
      const freshHtml = await freshDisconnectPage.text();
      const freshCsrf = freshHtml.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
      const freshCookie = freshDisconnectPage.headers.get("set-cookie")?.split(";")[0];
      if (!freshCsrf || !freshCookie) throw new Error("disconnect fixture tokens missing");
      const disconnected = await fetch(`${baseUrl}/google-workspace/disconnect`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: freshCookie,
          "x-thor-internal-secret": internalSecret,
          "x-vouch-user": googleEmail,
        },
        body: new URLSearchParams({ csrf: freshCsrf }),
      });
      expect(disconnected.status).toBe(200);
      expect(oauth.findConnectedIdentity(slackUserId, googleEmail)).toMatchObject({
        ok: false,
        error: { code: "connection_missing" },
      });
    },
  );
});
