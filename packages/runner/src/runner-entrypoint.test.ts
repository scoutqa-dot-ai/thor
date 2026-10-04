import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Runner fixture listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

describe("runner production runtime selection", () => {
  it.each([undefined, "opencode"])(
    "retains OpenCode execution for runtime %s",
    async (runtime) => {
      const requests: string[] = [];
      const openCode = createServer((req, res) => {
        requests.push(req.url ?? "");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ healthy: true }));
      });
      const openCodeUrl = await listen(openCode);
      const reservation = createServer();
      const runnerUrl = await listen(reservation);
      await close(reservation);
      const tsxLoader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
      const entrypoint = new URL("./index.ts", import.meta.url).pathname;
      const child = spawn(process.execPath, ["--import", tsxLoader, entrypoint], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          PORT: new URL(runnerUrl).port,
          OPENCODE_URL: openCodeUrl,
          ...(runtime ? { THOR_RUNTIME: runtime } : {}),
        },
      });
      children.push(child);
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", (code) => resolve(code)),
      );
      try {
        await vi.waitFor(
          async () => {
            if (child.exitCode !== null) throw new Error(`Legacy entrypoint exited: ${output}`);
            const health = await fetch(`${runnerUrl}/health`);
            expect(await health.json()).toMatchObject({
              service: "runner",
              opencode: "connected",
              opencodeUrl: openCodeUrl,
            });
          },
          { timeout: 8000, interval: 25 },
        );
        expect(requests).toContain("/global/health");
        expect(
          (
            await fetch(`${runnerUrl}/trigger`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            })
          ).status,
        ).toBe(400);
        child.kill("SIGTERM");
        expect(await exited).toBe(0);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await exited;
        await close(openCode);
      }
    },
    15000,
  );
});
