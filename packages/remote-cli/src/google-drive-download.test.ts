import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES,
  GoogleDriveDownloadExecResultSchema,
  GoogleDriveDownloadNameSchema,
  GoogleWorkspaceExecResultSchema,
  appendAlias,
  appendSessionEvent,
} from "@thor/common";
import { GwsService } from "./gws.js";
import { GwsOAuthService, type GwsAccessToken } from "./gws-oauth.js";
import { createRemoteCliApp } from "./index.js";

const dummyToken = "dummy-requester-token-never-render";
const token: GwsAccessToken = {
  connectionId: "019d0000-0000-7000-8000-000000000001",
  googleEmail: "dummy@example.test",
  googleSubject: "dummy-google-subject",
  reveal: () => dummyToken,
};
const folderMime = "application/vnd.google-apps.folder";
const shortcutMime = "application/vnd.google-apps.shortcut";
function metadata(id: string, name: string, mimeType = "application/octet-stream", size?: number) {
  return {
    id,
    name,
    mimeType,
    trashed: false,
    ...(size === undefined ? {} : { size: String(size) }),
  };
}

// Faithful Fetch/Response fixture: all production URLs, query encoding, streaming and redirect options remain intact.
function driveFixture(handler: (url: URL) => Response | Promise<Response>) {
  const requests: URL[] = [];
  const driveFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe("https://www.googleapis.com");
    expect(url.pathname).toMatch(/^\/drive\/v3\/files(?:\/|$)/);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${dummyToken}`);
    requests.push(url);
    return handler(url);
  };
  const service = new GwsService(
    { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "/dummy-private-unused" },
    { driveFetch },
  );
  return {
    requests,
    service,
    download: (id = "root-id") => service.execute(["drive", "+download", "--file-id", id], token),
  };
}
function assertNoPartial(response: Awaited<ReturnType<GwsService["execute"]>>, reason?: string) {
  expect(response.status).toBe(200);
  expect(response.result).toMatchObject({ stdout: "", exitCode: 1 });
  expect(response.result).not.toHaveProperty("driveDownload");
  expect(response.result.stderr).toContain("No files were returned.");
  expect(JSON.stringify(response)).not.toContain(dummyToken);
  expect(JSON.stringify(response)).not.toContain("private-provider-name");
  if (reason) expect(response.result.stderr).toContain(reason);
}

function chunkedBytes(chunks: Uint8Array[], cancelled?: () => void) {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel: cancelled,
    }),
  );
}

describe("Google Drive bounded download through GwsService", () => {
  it("returns exact binary bytes and a dedicated manifest, never stdout or broker paths", async () => {
    const binary = Buffer.from([0, 255, 128, 13, 10, 1]);
    const fixture = driveFixture((url) =>
      url.searchParams.get("alt") === "media"
        ? chunkedBytes([binary.subarray(0, 2), binary.subarray(2)])
        : Response.json(
            metadata("root-id", "photo.bin", "application/octet-stream", binary.length),
          ),
    );
    const response = await fixture.download();
    expect(response).toMatchObject({
      status: 200,
      result: { stdout: "", stderr: "", exitCode: 0 },
    });
    const manifest = GoogleDriveDownloadExecResultSchema.parse(response.result).driveDownload;
    expect(manifest).toEqual({
      version: 1,
      rootName: "photo.bin",
      skipped: [],
      entries: [
        {
          kind: "file",
          path: ["photo.bin"],
          mimeType: "application/octet-stream",
          size: binary.length,
          sha256: createHash("sha256").update(binary).digest("hex"),
          dataBase64: binary.toString("base64"),
        },
      ],
    });
    expect(fixture.requests).toHaveLength(2);
    expect(
      fixture.requests.every((url) => url.searchParams.get("supportsAllDrives") === "true"),
    ).toBe(true);
  });

  it("preserves paginated shared-drive folders, empty directories, collisions and export extensions", async () => {
    const fixture = driveFixture((url) => {
      if (url.pathname === "/drive/v3/files/root-id")
        return Response.json(metadata("root-id", "../Team\\Files", folderMime));
      if (url.pathname.endsWith("/export")) {
        expect(url.searchParams.get("mimeType")).toBe("text/plain");
        return new Response("exported document");
      }
      if (url.searchParams.get("alt") === "media") return new Response("ordinary file");
      expect(url.pathname).toBe("/drive/v3/files");
      expect(url.searchParams.get("supportsAllDrives")).toBe("true");
      expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
      const q = url.searchParams.get("q");
      if (q?.startsWith("'empty'")) return Response.json({ files: [] });
      if (q?.startsWith("'nested'"))
        return Response.json({ files: [metadata("binary", "payload.bin")] });
      expect(q).toBe("'root-id' in parents and trashed = false");
      if (url.searchParams.has("pageToken")) {
        expect(url.searchParams.get("pageToken")).toBe("dummy-next-page/+=");
        return Response.json({
          files: [
            metadata("doc", "Report", "application/vnd.google-apps.document"),
            metadata("shortcut", "link", shortcutMime),
            metadata("nested", "nested", folderMime),
          ],
        });
      }
      return Response.json({
        nextPageToken: "dummy-next-page/+=",
        files: [metadata("ordinary", "report.txt"), metadata("empty", "empty", folderMime)],
      });
    });
    const response = await fixture.download();
    expect(response.result.exitCode).toBe(0);
    const manifest = response.result.driveDownload;
    expect(manifest?.entries.map((entry) => entry.path)).toEqual([
      [".._Team_Files"],
      [".._Team_Files", "report.txt"],
      [".._Team_Files", "empty"],
      [".._Team_Files", "Report (2).txt"],
      [".._Team_Files", "nested"],
      [".._Team_Files", "nested", "payload.bin"],
    ]);
    expect(manifest?.skipped).toEqual([{ fileId: "shortcut", name: "link", reason: "shortcut" }]);
    expect(fixture.requests.some((url) => url.pathname.includes("shortcut"))).toBe(false);
  });

  it.each([
    ["document", "text/plain", ".txt"],
    ["spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
    [
      "presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".pptx",
    ],
    ["drawing", "application/pdf", ".pdf"],
  ])("exports native %s in the selected usable format", async (nativeType, mimeType, extension) => {
    const fixture = driveFixture((url) => {
      if (url.pathname.endsWith("/export")) {
        expect(url.searchParams.get("mimeType")).toBe(mimeType);
        expect(url.searchParams.has("alt")).toBe(false);
        return chunkedBytes([Buffer.from([0, 255, 200])]);
      }
      return Response.json(
        metadata("root-id", "Workspace", `application/vnd.google-apps.${nativeType}`),
      );
    });
    const response = await fixture.download();
    expect(response.result.driveDownload?.entries[0]).toMatchObject({
      kind: "file",
      path: [`Workspace${extension}`],
      mimeType,
      dataBase64: "AP/I",
    });
  });

  it("sanitizes traversal, control characters, reserved names, long UTF-8 and Unicode/case aliases", async () => {
    const names = [
      ".",
      "..",
      "/etc/passwd",
      "a\\b",
      "\0name\n",
      "CON.txt",
      "COM¹.txt",
      "x".repeat(400),
      "界".repeat(180),
      "Same",
      "same",
      "Straße",
      "STRASSE",
      "é",
      "e\u0301",
      "trailing. ",
    ];
    const fixture = driveFixture((url) => {
      if (url.pathname.endsWith("/root-id"))
        return Response.json(metadata("root-id", "root folder", folderMime));
      if (url.searchParams.get("alt") === "media") return new Response("");
      return Response.json({ files: names.map((name, index) => metadata(`child-${index}`, name)) });
    });
    const response = await fixture.download();
    expect(response.result.exitCode).toBe(0);
    const paths = response.result.driveDownload?.entries.map((entry) => entry.path) ?? [];
    expect(paths).toHaveLength(names.length + 1);
    for (const path of paths)
      for (const segment of path)
        expect(GoogleDriveDownloadNameSchema.safeParse(segment).success).toBe(true);
    expect(paths).toContainEqual(["root folder", "same (2)"]);
    expect(paths).toContainEqual(["root folder", "STRASSE (2)"]);
    expect(paths).toContainEqual(["root folder", "é (2)"]);
  });

  it.each([302, 401, 403, 404, 500])(
    "returns no manifest or provider details for HTTP %s",
    async (status) => {
      const fixture = driveFixture(
        () =>
          new Response(`private-provider-name ${dummyToken}`, {
            status,
            headers: { location: "https://attacker.example.test/token" },
          }),
      );
      assertNoPartial(await fixture.download());
      expect(fixture.requests).toHaveLength(1);
    },
  );

  it("fails atomically after a sibling was acquired, including stream read errors", async () => {
    const fixture = driveFixture((url) => {
      if (url.pathname.endsWith("/root-id"))
        return Response.json(metadata("root-id", "folder", folderMime));
      if (url.pathname.endsWith("/good")) return new Response("already acquired");
      if (url.pathname.endsWith("/bad"))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`private-provider-name ${dummyToken}`));
            },
          }),
        );
      return Response.json({ files: [metadata("good", "one"), metadata("bad", "two")] });
    });
    assertNoPartial(await fixture.download());
    expect(fixture.requests.some((url) => url.pathname.endsWith("/good"))).toBe(true);
  });

  it("translates network exceptions without rejection or credential leaks", async () => {
    const fixture = driveFixture(() => {
      throw new Error(`private-provider-name ${dummyToken}`);
    });
    assertNoPartial(await fixture.download());
  });

  it.each(["application/vnd.google-apps.form", shortcutMime])(
    "fails on unsupported root %s",
    async (mimeType) => {
      const fixture = driveFixture(() =>
        Response.json(metadata("root-id", "private-provider-name", mimeType)),
      );
      assertNoPartial(await fixture.download(), "unsupported");
      expect(fixture.requests).toHaveLength(1);
    },
  );

  it.each([
    { id: "root-id", name: "private-provider-name", mimeType: "text/plain", trashed: true },
    { id: "other-id", name: "private-provider-name", mimeType: "text/plain" },
    { id: "root-id", name: "private-provider-name", mimeType: "text/plain", size: "-1" },
    { id: "root-id", name: "private-provider-name" },
  ])("denies invalid or trashed metadata before media acquisition", async (root) => {
    const fixture = driveFixture(() => Response.json(root));
    assertNoPartial(await fixture.download(), "invalid");
    expect(fixture.requests).toHaveLength(1);
  });

  it.each(["cycle", "page-loop", "incomplete"])(
    "rejects inconsistent folder listings: %s",
    async (mode) => {
      const fixture = driveFixture((url) =>
        url.pathname.endsWith("/root-id")
          ? Response.json(metadata("root-id", "folder", folderMime))
          : Response.json({
              files: mode === "cycle" ? [metadata("root-id", "cycle", folderMime)] : [],
              ...(mode === "page-loop" ? { nextPageToken: "dummy-repeat" } : {}),
              ...(mode === "incomplete" ? { incompleteSearch: true } : {}),
            }),
      );
      assertNoPartial(await fixture.download(), "invalid");
      expect(fixture.requests.length).toBeLessThanOrEqual(3);
    },
  );

  it("denies declared oversize before reading media and independently bounds unknown-length streams", async () => {
    const declared = driveFixture(() =>
      Response.json(
        metadata("root-id", "large", "text/plain", GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES + 1),
      ),
    );
    assertNoPartial(await declared.download(), "smaller");
    expect(declared.requests).toHaveLength(1);
    let cancelled = false;
    const streamed = driveFixture((url) =>
      url.searchParams.get("alt") === "media"
        ? chunkedBytes(
            Array.from({ length: 52 }, () => Buffer.alloc(1024 * 1024)),
            () => {
              cancelled = true;
            },
          )
        : Response.json(metadata("root-id", "large")),
    );
    assertNoPartial(await streamed.download(), "smaller");
    expect(cancelled).toBe(true);
    const header = driveFixture((url) =>
      url.searchParams.get("alt") === "media"
        ? new Response("tiny", {
            headers: { "content-length": String(GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES + 1) },
          })
        : Response.json(metadata("root-id", "large")),
    );
    assertNoPartial(await header.download(), "smaller");
  });

  it("accepts exactly 50 MiB without a large regex stack or binary corruption", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 255);
    const fixture = driveFixture((url) =>
      url.searchParams.get("alt") === "media"
        ? chunkedBytes(Array.from({ length: 50 }, () => chunk))
        : Response.json(
            metadata(
              "root-id",
              "boundary.bin",
              "application/octet-stream",
              GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES,
            ),
          ),
    );
    const response = await fixture.download();
    expect(response.result.exitCode).toBe(0);
    const entry = response.result.driveDownload?.entries[0];
    if (!entry || entry.kind !== "file") throw new Error("Drive download boundary file missing");
    expect(entry.size).toBe(GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES);
    const bytes = Buffer.from(entry.dataBase64, "base64");
    expect(bytes.length).toBe(GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES);
    expect(bytes[0]).toBe(255);
    expect(bytes[bytes.length - 1]).toBe(255);
    expect(entry.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("bounds aggregate bytes, not just each individual file", async () => {
    const fixture = driveFixture((url) => {
      if (url.pathname.endsWith("/root-id"))
        return Response.json(metadata("root-id", "folder", folderMime));
      if (url.searchParams.get("alt") === "media")
        return chunkedBytes(Array.from({ length: 26 }, () => Buffer.alloc(1024 * 1024)));
      return Response.json({ files: [metadata("first", "first"), metadata("second", "second")] });
    });
    assertNoPartial(await fixture.download(), "smaller");
  });

  it.each(["entries", "depth"])("denies excessive %s including directories", async (mode) => {
    const fixture = driveFixture((url) => {
      if (url.pathname.endsWith("/root-id"))
        return Response.json(metadata("root-id", "folder", folderMime));
      const parent = url.searchParams.get("q")?.match(/^'([^']+)'/)?.[1];
      if (mode === "depth") {
        const depth = parent === "root-id" ? 1 : Number(parent?.slice(6));
        return Response.json({ files: [metadata(`depth-${depth + 1}`, "nested", folderMime)] });
      }
      if (parent !== "root-id") return Response.json({ files: [] });
      const page = Number(url.searchParams.get("pageToken") ?? "0");
      return Response.json({
        nextPageToken: String(page + 1),
        files: Array.from({ length: 100 }, (_, index) =>
          metadata(`child-${page * 100 + index}`, "empty", folderMime),
        ),
      });
    });
    assertNoPartial(await fixture.download(), "smaller");
  });

  it.each(["entries", "depth"])("accepts the exact %s ceiling", async (mode) => {
    const fixture = driveFixture((url) => {
      if (url.pathname.endsWith("/root-id"))
        return Response.json(metadata("root-id", "folder", folderMime));
      const parent = url.searchParams.get("q")?.match(/^'([^']+)'/)?.[1];
      if (mode === "depth") {
        const depth = parent === "root-id" ? 1 : Number(parent?.slice(6));
        return Response.json({
          files: depth === 32 ? [] : [metadata(`depth-${depth + 1}`, "nested", folderMime)],
        });
      }
      if (parent !== "root-id") return Response.json({ files: [] });
      const page = Number(url.searchParams.get("pageToken") ?? "0");
      return Response.json({
        ...(page < 9 ? { nextPageToken: String(page + 1) } : {}),
        files: Array.from({ length: page === 9 ? 99 : 100 }, (_, index) =>
          metadata(`child-${page * 100 + index}`, "empty", folderMime),
        ),
      });
    });
    const response = await fixture.download();
    expect(response.result.exitCode).toBe(0);
    expect(response.result.driveDownload?.entries).toHaveLength(mode === "entries" ? 1000 : 32);
  });

  it("bounds metadata responses and detects declared media size inconsistency", async () => {
    const oversized = driveFixture(() => new Response(" ".repeat(1024 * 1024 + 1)));
    assertNoPartial(await oversized.download(), "smaller");
    const mismatch = driveFixture((url) =>
      url.searchParams.get("alt") === "media"
        ? new Response("short")
        : Response.json(metadata("root-id", "file", "text/plain", 20)),
    );
    assertNoPartial(await mismatch.download(), "invalid");
  });

  it("keeps invalid configuration unavailable before any transfer", async () => {
    let calls = 0;
    const service = new GwsService(
      { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "relative-path" },
      {
        driveFetch: async () => {
          calls++;
          return new Response("");
        },
      },
    );
    expect(await service.execute(["drive", "+download", "--file-id", "id"], token)).toMatchObject({
      status: 503,
      result: { stdout: "", exitCode: 2 },
    });
    expect(calls).toBe(0);
  });
});

it("retains the exact download argv through private OAuth and transfers only with the active requester's grant through HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "neo-drive-download-http-"));
  vi.stubEnv("WORKLOG_DIR", join(root, "worklogs"));
  vi.stubEnv("THOR_INTERNAL_SECRET", "dummy-internal-secret");
  const owner = {
    slackUserId: "U123",
    sessionId: "drive-download-session",
    anchorId: "019d0000-0000-7000-8000-000000000001",
    triggerId: "019d0000-0000-7000-8000-000000000002",
  };
  const googleEmail = "dummy@example.test";
  const oauth = new GwsOAuthService(
    {
      GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "dummy-client-id",
      GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "dummy-client-secret",
      GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL: "https://neo.example.test",
      GOOGLE_WORKSPACE_OAUTH_SCOPES: "https://www.googleapis.com/auth/drive",
      GOOGLE_WORKSPACE_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString("base64"),
      GOOGLE_WORKSPACE_OAUTH_STORAGE_DIR: join(root, "oauth"),
      SLACK_TEAM_ID: "T123",
    },
    {
      fetch: async (input, init) => {
        if (String(input).endsWith("/userinfo"))
          return Response.json({ sub: "dummy-subject", email: googleEmail, email_verified: true });
        const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
        return Response.json({
          access_token: dummyToken,
          expires_in: 3600,
          ...(body.get("grant_type") === "authorization_code"
            ? { refresh_token: "dummy-refresh-token" }
            : {}),
        });
      },
      authorizationEndpoint: "https://google.example.test/auth",
      tokenEndpoint: "https://google.example.test/token",
      userInfoEndpoint: "https://google.example.test/userinfo",
    },
  );
  const fixture = driveFixture((url) =>
    url.searchParams.get("alt") === "media"
      ? new Response("download through HTTP")
      : Response.json(metadata("root-id", "file.txt", "text/plain")),
  );
  const messages: unknown[] = [];
  const remote = createRemoteCliApp({
    gws: fixture.service,
    gwsOAuth: oauth,
    configLoader: () => ({
      users: [{ email: googleEmail, slack: owner.slackUserId, name: "Dummy Person" }],
    }),
    mcp: {
      approvalsDir: join(root, "approvals"),
      writeToolCallLogFn: () => {},
      slack: { botToken: "dummy-slack-token", apiBaseUrl: "https://slack.example.test/api" },
      fetchImpl: async (_input, init) => {
        messages.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, channel: "D123", ts: "1710000000.100" });
      },
    },
  });
  const server = createServer(remote.app);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Drive download HTTP fixture unavailable");
    const url = `http://127.0.0.1:${address.port}/exec/gws`;
    const args = ["drive", "+download", "--file-id", "root-id"];
    const post = () =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-thor-session-id": owner.sessionId },
        body: JSON.stringify({ args }),
      });
    expect((await post()).status).toBe(403);
    expect(fixture.requests).toHaveLength(0);
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
    const waiting = await post();
    expect(waiting.status).toBe(428);
    const wait = GoogleWorkspaceExecResultSchema.parse(await waiting.json()).authWait;
    if (!wait) throw new Error("Drive download fixture auth wait missing");
    expect(fixture.requests).toHaveLength(0);
    expect(messages).toHaveLength(1);
    const preview = oauth.previewAuthorization(wait.id, googleEmail);
    if (!preview.ok) throw preview.error;
    const authorization = oauth.beginAuthorization(
      wait.id,
      googleEmail,
      preview.value.confirmationToken,
    );
    if (!authorization.ok) throw authorization.error;
    const state = new URL(authorization.value.authorizationUrl).searchParams.get("state");
    if (!state) throw new Error("Drive download fixture state missing");
    const completion = await oauth.completeAuthorization({
      state,
      code: "dummy-code",
      browserNonce: authorization.value.browserNonce,
    });
    if (!completion.ok) throw completion.error;
    const ready = oauth.listReadyContinuations();
    if (!ready.ok) throw ready.error;
    expect(ready.value.map((continuation) => continuation.args)).toEqual([args]);
    expect(fixture.requests).toHaveLength(0);
    const success = await post();
    expect(success.status).toBe(200);
    const result = GoogleDriveDownloadExecResultSchema.parse(await success.json());
    expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
    expect(result.driveDownload?.entries[0]).toMatchObject({
      kind: "file",
      path: ["file.txt"],
      dataBase64: Buffer.from("download through HTTP").toString("base64"),
    });
    expect(JSON.stringify(result)).not.toContain(dummyToken);
    expect(fixture.requests).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await remote.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
