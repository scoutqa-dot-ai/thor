import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { appendAlias, sessionLogPath } from "@thor/common";
import { createAdminApp } from "./app.js";
import type { Express } from "express";

const anchor = "00000000-0000-7000-8000-0000000000c1";
const anchorBad = "00000000-0000-7000-8000-0000000000c2";
const trigger = "00000000-0000-7000-8000-0000000000d1";

describe("admin app sessions dashboard", () => {
  const originalWorklogDir = process.env.WORKLOG_DIR;
  let dir = "";
  let app: Express;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "thor-admin-"));
    process.env.WORKLOG_DIR = dir;
    writeFileSync(join(dir, "config.json"), "{}\n");
    app = createAdminApp({
      configPath: join(dir, "config.json"),
      auditLogPath: join(dir, "audit.jsonl"),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalWorklogDir === undefined) delete process.env.WORKLOG_DIR;
    else process.env.WORKLOG_DIR = originalWorklogDir;
  });

  it("renders config nav and preserves catch-all redirect", async () => {
    const config = await request(app, "/admin/config", {
      headers: { "X-Vouch-User": "ops@example.com" },
    });
    const html = config.text;
    expect(html).toContain('href="/admin/sessions"');
    expect(html).toContain("Signed in: ops@example.com");

    const redirected = await request(app, "/admin/nope");
    expect(redirected.status).toBe(302);
    expect(redirected.headers.location).toBe("/admin/config");
  });

  it("renders full sessions page and htmx fragment", async () => {
    appendAlias({ aliasType: "opencode.session", aliasValue: "s1", anchorId: anchor });
    appendAlias({ aliasType: "git.branch", aliasValue: "feature/<unsafe>", anchorId: anchor });
    writeSession("s1", [
      { ts: "2026-05-14T12:00:00.000Z", type: "trigger_start", triggerId: trigger },
    ]);

    const page = await request(app, "/admin/sessions", {
      headers: { "X-Vouch-User": "ops@example.com" },
    });
    const html = page.text;
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('href="/admin/config"');
    expect(html).toContain("Sessions");
    expect(html).toContain("feature/&lt;unsafe&gt;");
    expect(html).toContain(`/runner/v/${anchor}/${trigger}`);

    const fragment = await request(app, "/admin/sessions/fragment");
    const fragHtml = fragment.text;
    expect(fragHtml).toContain('id="sessions-panel"');
    expect(fragHtml).not.toContain("<!doctype html>");
    expect(fragHtml).toContain("badge");
  });

  it("preserves valid session rows when another alias has an unsafe session id", async () => {
    appendAlias({ aliasType: "opencode.session", aliasValue: "safe-session", anchorId: anchor });
    appendAlias({
      aliasType: "opencode.session",
      aliasValue: "unsafe/session",
      anchorId: anchorBad,
    });
    writeSession("safe-session", [
      { ts: "2026-05-14T12:00:00.000Z", type: "trigger_start", triggerId: trigger },
    ]);

    const page = await request(app, "/admin/sessions");
    const html = page.text;
    expect(html).toContain(`/runner/v/${anchor}/${trigger}`);
    expect(html).toContain("unsafe/session: Invalid session id");
    expect(html).toContain("unknown");
  });
});

class MockSocket extends Duplex {
  _read(): void {}

  _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

async function request(
  app: Express,
  path: string,
  options: { headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  // Keep route tests socket-free so they run in restricted local sandboxes.
  const socket = new MockSocket();
  const req = new IncomingMessage(socket);
  req.method = "GET";
  req.url = path;
  req.headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );

  const res = new ServerResponse(req);
  res.assignSocket(socket);

  const chunks: Buffer[] = [];
  const write = res.write.bind(res);
  res.write = (
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error) => void),
    callback?: (error?: Error) => void,
  ) => {
    if (chunk !== undefined) chunks.push(toBuffer(chunk, encodingOrCallback));
    return typeof encodingOrCallback === "function"
      ? write(chunk, encodingOrCallback)
      : write(chunk, encodingOrCallback, callback);
  };

  const end = res.end.bind(res);
  res.end = (
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    if (chunk !== undefined) chunks.push(toBuffer(chunk, encodingOrCallback));
    return typeof encodingOrCallback === "function"
      ? end(chunk, encodingOrCallback)
      : end(chunk, encodingOrCallback, callback);
  };

  await new Promise<void>((resolve, reject) => {
    res.on("finish", resolve);
    res.on("error", reject);
    app.handle(req, res, reject);
  });

  return {
    status: res.statusCode,
    headers: Object.fromEntries(
      Object.entries(res.getHeaders()).map(([key, value]) => [key.toLowerCase(), String(value)]),
    ),
    text: Buffer.concat(chunks).toString("utf-8"),
  };
}

function toBuffer(
  chunk: unknown,
  encodingOrCallback?: BufferEncoding | ((error?: Error) => void) | (() => void),
): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
  return Buffer.from(String(chunk), encoding);
}

function writeSession(sessionId: string, records: Array<Record<string, unknown>>): void {
  mkdirSync(join(process.env.WORKLOG_DIR ?? "", "sessions"), { recursive: true });
  writeFileSync(
    sessionLogPath(sessionId),
    records.map((record) => JSON.stringify({ schemaVersion: 1, ...record })).join("\n") + "\n",
  );
}
