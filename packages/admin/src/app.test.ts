import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { appendAlias, sessionLogPath } from "@thor/common";
import { createAdminApp } from "./app.js";

const anchor = "00000000-0000-7000-8000-0000000000c1";
const anchorBad = "00000000-0000-7000-8000-0000000000c2";
const trigger = "00000000-0000-7000-8000-0000000000d1";

describe("admin app sessions dashboard", () => {
  const originalWorklogDir = process.env.WORKLOG_DIR;
  let dir = "";
  let server: Server | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "thor-admin-"));
    process.env.WORKLOG_DIR = dir;
    writeFileSync(join(dir, "config.json"), "{}\n");
    const app = createAdminApp({ configPath: join(dir, "config.json"), auditLogPath: join(dir, "audit.jsonl") });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (address && typeof address === "object") baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    if (originalWorklogDir === undefined) delete process.env.WORKLOG_DIR;
    else process.env.WORKLOG_DIR = originalWorklogDir;
  });

  it("renders config nav and preserves catch-all redirect", async () => {
    const config = await fetch(`${baseUrl}/admin/config`, { headers: { "X-Vouch-User": "ops@example.com" } });
    const html = await config.text();
    expect(html).toContain('href="/admin/sessions"');
    expect(html).toContain("Signed in: ops@example.com");

    const redirected = await fetch(`${baseUrl}/admin/nope`, { redirect: "manual" });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe("/admin/config");
  });

  it("renders full sessions page and htmx fragment", async () => {
    appendAlias({ aliasType: "opencode.session", aliasValue: "s1", anchorId: anchor });
    appendAlias({ aliasType: "git.branch", aliasValue: "feature/<unsafe>", anchorId: anchor });
    writeSession("s1", [
      { ts: "2026-05-14T12:00:00.000Z", type: "trigger_start", triggerId: trigger },
    ]);

    const page = await fetch(`${baseUrl}/admin/sessions`, { headers: { "X-Vouch-User": "ops@example.com" } });
    const html = await page.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('href="/admin/config"');
    expect(html).toContain("Sessions");
    expect(html).toContain("feature/&lt;unsafe&gt;");
    expect(html).toContain(`/runner/v/${anchor}/${trigger}`);

    const fragment = await fetch(`${baseUrl}/admin/sessions/fragment`);
    const fragHtml = await fragment.text();
    expect(fragHtml).toContain('id="sessions-panel"');
    expect(fragHtml).not.toContain("<!doctype html>");
    expect(fragHtml).toContain("badge");
  });

  it("preserves valid session rows when another alias has an unsafe session id", async () => {
    appendAlias({ aliasType: "opencode.session", aliasValue: "safe-session", anchorId: anchor });
    appendAlias({ aliasType: "opencode.session", aliasValue: "unsafe/session", anchorId: anchorBad });
    writeSession("safe-session", [
      { ts: "2026-05-14T12:00:00.000Z", type: "trigger_start", triggerId: trigger },
    ]);

    const page = await fetch(`${baseUrl}/admin/sessions`);
    const html = await page.text();
    expect(html).toContain(`/runner/v/${anchor}/${trigger}`);
    expect(html).toContain("unsafe/session: Invalid session id");
    expect(html).toContain("unknown");
  });
});

function writeSession(sessionId: string, records: Array<Record<string, unknown>>): void {
  mkdirSync(join(process.env.WORKLOG_DIR ?? "", "sessions"), { recursive: true });
  writeFileSync(
    sessionLogPath(sessionId),
    records.map((record) => JSON.stringify({ schemaVersion: 1, ...record })).join("\n") + "\n",
  );
}
