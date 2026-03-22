import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayApp } from "./app.js";
import type { EventQueue } from "./queue.js";

async function withServer<T>(
  fetchImpl: typeof fetch,
  opts: { cronSecret?: string },
  run: (baseUrl: string, queue: EventQueue) => Promise<T>,
): Promise<T> {
  const queueDir = mkdtempSync(join(tmpdir(), "gateway-cron-test-"));
  const { app, queue } = createGatewayApp({
    signingSecret: "signing-secret",
    slackMcpUrl: "http://slack-mcp.test",
    runnerUrl: "http://runner.test",
    fetchImpl,
    queueDir,
    disableQueueInterval: true,
    cronSecret: opts.cronSecret,
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine server address");
  }

  try {
    return await run(`http://127.0.0.1:${address.port}`, queue);
  } finally {
    queue.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(queueDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /cron", () => {
  it("enqueues a cron event with derived correlation key", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(fetchImpl, { cronSecret: "s3cret" }, async (baseUrl, queue) => {
      const response = await fetch(`${baseUrl}/cron`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer s3cret",
        },
        body: JSON.stringify({ prompt: "Do the thing", directory: "/workspace/repos/test-repo" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.correlationKey).toMatch(/^cron:[a-f0-9]{32}:\d+$/);

      await queue.flush();

      const triggerCall = fetchImpl.mock.calls.find((c) => c[0] === "http://runner.test/trigger");
      expect(triggerCall).toBeDefined();
      const triggerBody = JSON.parse(String(triggerCall![1]?.body));
      expect(triggerBody.prompt).toBe("Do the thing");
      expect(triggerBody.correlationKey).toMatch(/^cron:/);
      expect(triggerBody.directory).toBe("/workspace/repos/test-repo");
    });
  });

  it("uses provided correlationKey instead of deriving one", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await withServer(fetchImpl, { cronSecret: "s3cret" }, async (baseUrl, queue) => {
      const response = await fetch(`${baseUrl}/cron`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer s3cret",
        },
        body: JSON.stringify({
          prompt: "Reminder: check deployment",
          correlationKey: "slack:C06ABC:1710600000",
          directory: "/workspace/repos/test-repo",
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.correlationKey).toBe("slack:C06ABC:1710600000");

      await queue.flush();

      const triggerCall = fetchImpl.mock.calls.find((c) => c[0] === "http://runner.test/trigger");
      expect(triggerCall).toBeDefined();
      const triggerBody = JSON.parse(String(triggerCall![1]?.body));
      expect(triggerBody.prompt).toBe("Reminder: check deployment");
      expect(triggerBody.correlationKey).toBe("slack:C06ABC:1710600000");
    });
  });

  it("returns 400 for missing prompt", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, { cronSecret: "s3cret" }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/cron`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer s3cret",
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("returns 401 when CRON_SECRET is not configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, {}, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Do the thing" }),
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("CRON_SECRET not configured");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("returns 401 when auth is wrong", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, { cronSecret: "my-secret" }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/cron`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-secret",
        },
        body: JSON.stringify({ prompt: "Do the thing" }),
      });

      expect(response.status).toBe(401);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("returns 401 when auth header is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await withServer(fetchImpl, { cronSecret: "my-secret" }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Do the thing" }),
      });

      expect(response.status).toBe(401);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
