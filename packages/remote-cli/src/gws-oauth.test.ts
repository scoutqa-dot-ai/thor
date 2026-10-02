import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { createCipheriv } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GwsOAuthService } from "./gws-oauth.js";

const slackUserId = "U123";
const expectedGoogleEmail = "person@example.com";
const refreshToken = "fixture-refresh-token-never-log";
const authorizationAccessToken = "fixture-authorization-access-token";
const refreshedAccessToken = "fixture-refreshed-access-token";

let storageDir: string;
let nowMs: number;

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "thor-gws-oauth-"));
  nowMs = Date.parse("2026-09-29T00:00:00.000Z");
});

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

function oauthEnv(): NodeJS.ProcessEnv {
  return {
    GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "fixture-client-id",
    GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "fixture-client-secret",
    GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL: "https://thor.example.test",
    GOOGLE_WORKSPACE_OAUTH_SCOPES:
      "https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/documents,https://www.googleapis.com/auth/spreadsheets",
    GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR: storageDir,
    SLACK_TEAM_ID: "T123",
  };
}

function createProviderFetch(options: { userEmail?: string; tokenStatus?: number } = {}): {
  fetch: typeof fetch;
  calls: Array<{ url: string; grantType?: string; redirect?: RequestInit["redirect"] }>;
} {
  const calls: Array<{ url: string; grantType?: string; redirect?: RequestInit["redirect"] }> = [];
  const providerFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body instanceof URLSearchParams ? init.body : undefined;
    const grantType = body?.get("grant_type") ?? undefined;
    calls.push({
      url,
      ...(grantType ? { grantType } : {}),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    });

    if (url.endsWith("/token")) {
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return new Response("provider error must not escape", { status: options.tokenStatus });
      }
      if (grantType === "authorization_code") {
        return Response.json({
          access_token: authorizationAccessToken,
          refresh_token: refreshToken,
          expires_in: 3600,
        });
      }
      if (grantType === "refresh_token") {
        expect(body?.get("refresh_token")).toBe(refreshToken);
        return Response.json({ access_token: refreshedAccessToken, expires_in: 3600 });
      }
    }
    if (url.endsWith("/userinfo")) {
      expect([`Bearer ${authorizationAccessToken}`, `Bearer ${refreshedAccessToken}`]).toContain(
        new Headers(init?.headers).get("authorization"),
      );
      return Response.json({
        sub: "google-subject-123",
        email: options.userEmail ?? expectedGoogleEmail,
        email_verified: true,
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: providerFetch as typeof fetch, calls };
}

function ownerInput() {
  return {
    slackUserId,
    expectedGoogleEmail,
    sessionId: "session-123",
    anchorId: "019d0000-0000-7000-8000-000000000001",
    triggerId: "019d0000-0000-7000-8000-000000000002",
  };
}

async function connect(service: GwsOAuthService) {
  const request = service.createConnectionRequest(ownerInput());
  expect(request.ok).toBe(true);
  if (!request.ok) throw request.error;

  const started = service.beginAuthorization(request.value.requestId, expectedGoogleEmail);
  expect(started.ok).toBe(true);
  if (!started.ok) throw started.error;
  const authorizationUrl = new URL(started.value.authorizationUrl);
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizationUrl.searchParams.get("scope")).toContain("openid");

  const state = authorizationUrl.searchParams.get("state");
  expect(state).toBeTruthy();
  const completed = await service.completeAuthorization({
    state: state!,
    code: "fixture-code",
    browserNonce: started.value.browserNonce,
  });
  expect(completed.ok).toBe(true);
  if (!completed.ok) throw completed.error;
  return { request, started, completed, state: state! };
}

async function readStorageText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) contents.push(await readStorageText(path));
    else contents.push(await readFile(path, "utf8"));
  }
  return contents.join("\n");
}

describe("GwsOAuthService", () => {
  it("rejects ambiguous email grants without revoking either owner", async () => {
    const service = new GwsOAuthService(oauthEnv(), { fetch: createProviderFetch().fetch });
    await connect(service);
    const request = service.createConnectionRequest({ ...ownerInput(), slackUserId: "UOTHER" });
    if (!request.ok) throw request.error;
    const started = service.beginAuthorization(request.value.requestId, expectedGoogleEmail);
    if (!started.ok) throw started.error;
    const state = new URL(started.value.authorizationUrl).searchParams.get("state");
    if (!state) throw new Error("GWS duplicate grant fixture state missing");
    expect(
      (
        await service.completeAuthorization({
          state,
          code: "fixture-code",
          browserNonce: started.value.browserNonce,
        })
      ).ok,
    ).toBe(true);
    expect(service.findConnectedIdentityByEmail(expectedGoogleEmail)).toMatchObject({
      ok: false,
      error: { stage: "identity", code: "identity_mismatch" },
    });
    expect(service.findConnectedIdentity(slackUserId, expectedGoogleEmail).ok).toBe(true);
    expect(service.findConnectedIdentity("UOTHER", expectedGoogleEmail).ok).toBe(true);
  });

  it.each(["corrupt", "unreadable", "owner/path mismatch"])(
    "preserves %s grant evidence instead of skipping it during disconnect lookup",
    async (kind) => {
      const service = new GwsOAuthService(oauthEnv(), { fetch: createProviderFetch().fetch });
      const connected = await connect(service);
      const directory = join(storageDir, "connections");
      const name = (await readdir(directory))[0];
      if (!name) throw new Error("GWS encrypted grant fixture missing");
      const originalPath = join(directory, name);
      const original = await readFile(originalPath, "utf8");
      let evidencePath = originalPath;
      if (kind === "unreadable") {
        evidencePath = join(directory, `${"a".repeat(64)}.json`);
        await mkdir(evidencePath);
      } else if (kind === "corrupt") {
        evidencePath = join(directory, `${"a".repeat(64)}.json`);
        await writeFile(evidencePath, '{"version":1,"ciphertext":"invalid"}');
      } else {
        const iv = Buffer.alloc(12, 9);
        const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 7), iv, {
          authTagLength: 16,
        });
        cipher.setAAD(Buffer.from(`thor:gws-user-oauth:v1\0${originalPath}`));
        const record = {
          version: 1,
          connectionId: connected.completed.value.connectionId,
          slackTeamId: "T123",
          slackUserId: "UOTHER",
          expectedGoogleEmail,
          googleEmail: expectedGoogleEmail,
          googleSubject: "google-subject-123",
          refreshToken,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        };
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()]);
        await writeFile(
          originalPath,
          JSON.stringify({
            version: 1,
            iv: iv.toString("base64"),
            ciphertext: ciphertext.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
          }),
        );
      }
      const evidence = kind === "unreadable" ? undefined : await readFile(evidencePath, "utf8");
      expect(service.findConnectedIdentityByEmail(expectedGoogleEmail)).toMatchObject({
        ok: false,
        error: { stage: "storage" },
      });
      if (kind !== "unreadable") expect(await readFile(evidencePath, "utf8")).toBe(evidence);
      else expect(await readdir(evidencePath)).toEqual([]);
      if (kind !== "owner/path mismatch")
        expect(await readFile(originalPath, "utf8")).toBe(original);
    },
  );
  it("binds one Google identity and injects only a refreshed short-lived token", async () => {
    const provider = createProviderFetch();
    const service = new GwsOAuthService(oauthEnv(), {
      fetch: provider.fetch,
      now: () => nowMs,
      authorizationEndpoint: "https://provider.example.test/auth",
      tokenEndpoint: "https://provider.example.test/token",
      userInfoEndpoint: "https://provider.example.test/userinfo",
    });

    const connected = await connect(service);
    expect(connected.completed.value).toMatchObject({
      googleEmail: expectedGoogleEmail,
      slackUserId,
    });

    const token = await service.getAccessToken(slackUserId, expectedGoogleEmail);
    expect(token.ok).toBe(true);
    if (!token.ok) throw token.error;
    expect(token.value.reveal()).toBe(refreshedAccessToken);
    expect(token.value.googleSubject).toBe("google-subject-123");
    expect(provider.calls.every((call) => call.redirect === "manual")).toBe(true);

    const storageText = await readStorageText(storageDir);
    expect(storageText).not.toContain(refreshToken);
    expect(storageText).not.toContain(authorizationAccessToken);
    expect(storageText).not.toContain(connected.started.value.browserNonce);
  });

  it("rejects callback replay and a different browser", async () => {
    const provider = createProviderFetch();
    const service = new GwsOAuthService(oauthEnv(), {
      fetch: provider.fetch,
      now: () => nowMs,
      authorizationEndpoint: "https://provider.example.test/auth",
      tokenEndpoint: "https://provider.example.test/token",
      userInfoEndpoint: "https://provider.example.test/userinfo",
    });
    const request = service.createConnectionRequest(ownerInput());
    if (!request.ok) throw request.error;
    const started = service.beginAuthorization(request.value.requestId, expectedGoogleEmail);
    if (!started.ok) throw started.error;
    const state = new URL(started.value.authorizationUrl).searchParams.get("state")!;

    const wrongBrowser = await service.completeAuthorization({
      state,
      code: "fixture-code",
      browserNonce: "different-browser-nonce-value",
    });
    expect(wrongBrowser).toMatchObject({ ok: false, error: { code: "browser_mismatch" } });

    const completed = await service.completeAuthorization({
      state,
      code: "fixture-code",
      browserNonce: started.value.browserNonce,
    });
    expect(completed.ok).toBe(true);
    const replay = await service.completeAuthorization({
      state,
      code: "fixture-code",
      browserNonce: started.value.browserNonce,
    });
    expect(replay).toMatchObject({ ok: false });
  });

  it("rejects a Vouch or Google identity mismatch", async () => {
    const mismatchedProvider = createProviderFetch({ userEmail: "other@example.com" });
    const service = new GwsOAuthService(oauthEnv(), {
      fetch: mismatchedProvider.fetch,
      now: () => nowMs,
      authorizationEndpoint: "https://provider.example.test/auth",
      tokenEndpoint: "https://provider.example.test/token",
      userInfoEndpoint: "https://provider.example.test/userinfo",
    });
    const request = service.createConnectionRequest(ownerInput());
    if (!request.ok) throw request.error;
    expect(service.beginAuthorization(request.value.requestId, "other@example.com")).toMatchObject({
      ok: false,
      error: { code: "identity_mismatch" },
    });
    const started = service.beginAuthorization(request.value.requestId, expectedGoogleEmail);
    if (!started.ok) throw started.error;
    const state = new URL(started.value.authorizationUrl).searchParams.get("state")!;
    const result = await service.completeAuthorization({
      state,
      code: "fixture-code",
      browserNonce: started.value.browserNonce,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
  });

  it("expires links and rejects OAuth redirects", async () => {
    const provider = createProviderFetch({ tokenStatus: 302 });
    const service = new GwsOAuthService(oauthEnv(), {
      fetch: provider.fetch,
      now: () => nowMs,
      authorizationEndpoint: "https://provider.example.test/auth",
      tokenEndpoint: "https://provider.example.test/token",
      userInfoEndpoint: "https://provider.example.test/userinfo",
    });
    const expiredRequest = service.createConnectionRequest(ownerInput());
    if (!expiredRequest.ok) throw expiredRequest.error;
    nowMs += 11 * 60 * 1000;
    expect(
      service.beginAuthorization(expiredRequest.value.requestId, expectedGoogleEmail),
    ).toMatchObject({ ok: false, error: { code: "expired" } });

    nowMs = Date.parse("2026-09-29T00:00:00.000Z");
    const request = service.createConnectionRequest(ownerInput());
    if (!request.ok) throw request.error;
    const started = service.beginAuthorization(request.value.requestId, expectedGoogleEmail);
    if (!started.ok) throw started.error;
    const state = new URL(started.value.authorizationUrl).searchParams.get("state")!;
    const result = await service.completeAuthorization({
      state,
      code: "fixture-code",
      browserNonce: started.value.browserNonce,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "provider_rejected", httpStatus: 302 },
    });
  });

  it("creates a stable keyed command binding without embedding argv", () => {
    const service = new GwsOAuthService(oauthEnv(), { now: () => nowMs });
    const first = service.fingerprintCommand(["drive", "files", "get", "private-file-id"]);
    const same = service.fingerprintCommand(["drive", "files", "get", "private-file-id"]);
    const changed = service.fingerprintCommand(["drive", "files", "get", "other-file-id"]);
    expect(first.ok).toBe(true);
    expect(same).toEqual(first);
    expect(changed.ok).toBe(true);
    if (!first.ok || !changed.ok) throw new Error("fixture fingerprint unavailable");
    expect(first.value).toMatch(/^[a-f0-9]{64}$/);
    expect(first.value).not.toContain("private-file-id");
    expect(changed.value).not.toBe(first.value);
  });

  it("prunes expired encrypted command payloads", () => {
    const service = new GwsOAuthService(oauthEnv(), { now: () => nowMs });
    const actionId = "019d0000-0000-7000-8000-000000000004";
    expect(
      service.storePendingCommand({
        ...ownerInput(),
        actionId,
        args: ["docs", "documents", "create", "--json", '{"title":"private"}'],
      }),
    ).toEqual({ ok: true, value: undefined });
    nowMs += 31 * 60 * 1000;
    expect(service.createConnectionRequest(ownerInput()).ok).toBe(true);
    expect(service.consumePendingCommand(actionId, slackUserId)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("allows only the bound Slack user to consume a command once", () => {
    const service = new GwsOAuthService(oauthEnv(), { now: () => nowMs });
    const stored = service.storePendingCommand({
      ...ownerInput(),
      actionId: "019d0000-0000-7000-8000-000000000003",
      args: ["drive", "files", "update", "--json", '{"name":"changed"}'],
    });
    expect(stored.ok).toBe(true);
    expect(
      service.consumePendingCommand("019d0000-0000-7000-8000-000000000003", "U999"),
    ).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    const consumed = service.consumePendingCommand(
      "019d0000-0000-7000-8000-000000000003",
      slackUserId,
    );
    expect(consumed).toMatchObject({ ok: true, value: { reviewer: slackUserId } });
    expect(
      service.consumePendingCommand("019d0000-0000-7000-8000-000000000003", slackUserId),
    ).toMatchObject({ ok: false, error: { code: "already_used" } });

    const storedResult = service.storeCommandResult("019d0000-0000-7000-8000-000000000003", {
      stdout: "private result",
      stderr: "",
      exitCode: 0,
    });
    expect(storedResult.ok).toBe(true);
    if (!storedResult.ok) throw storedResult.error;
    expect(
      service.readCommandResult(
        "019d0000-0000-7000-8000-000000000003",
        "wrong-capability-value-that-is-long-enough",
      ),
    ).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    expect(
      service.readCommandResult("019d0000-0000-7000-8000-000000000003", storedResult.value),
    ).toEqual({
      ok: true,
      value: { stdout: "private result", stderr: "", exitCode: 0 },
    });
    expect(
      service.readCommandResult("019d0000-0000-7000-8000-000000000003", storedResult.value),
    ).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
  });
});
