import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPiExecutorService } from "./executor-service.js";
import { piExecFrameSchema } from "./execution-protocol.js";

let service: ReturnType<typeof createPiExecutorService>;
let cwd: string;
let url: string;
let priorSentinel: string | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-executor-test-"));
  priorSentinel = process.env.THOR_INTERNAL_SECRET;
  process.env.THOR_INTERNAL_SECRET = "poisoned-executor-credential-sentinel";
  const startup = join(cwd, "poisoned-startup.sh");
  await writeFile(startup, "printf startup-injection-sentinel\\n");
  service = createPiExecutorService({
    shellEnvironment: {
      ...process.env,
      BASH_ENV: startup,
      NODE_OPTIONS: "--bad-injection",
      SLACK_BOT_TOKEN: "slack-credential-sentinel",
    },
  });
  await new Promise<void>((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const address = service.server.address();
  if (!address || typeof address === "string") throw new Error("Pi executor test failed to listen");
  url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await service.dispose();
  service.server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    service.server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(cwd, { recursive: true, force: true });
  if (priorSentinel === undefined) delete process.env.THOR_INTERNAL_SECRET;
  else process.env.THOR_INTERNAL_SECRET = priorSentinel;
});

async function post(operation: unknown): Promise<Response> {
  return fetch(`${url}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: randomUUID(), cwd, operation }),
  });
}

describe("Pi executor private HTTP boundary", () => {
  it("exposes health without starting work and rejects arbitrary routes/dispatch", async () => {
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ ok: true });
    expect((await fetch(`${url}/execute`)).status).toBe(404);
    for (const operation of [
      { type: "constructor" },
      { type: "__proto__" },
      { type: "readTextFile", path: "x", unexpected: "poisoned-executor-credential-sentinel" },
    ]) {
      const response = await post(operation);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('{"error":"Pi executor invalid request"}');
    }
    const malformed = await fetch(`${url}/execute`, {
      method: "POST",
      body: "{bad-json-credential-sentinel",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain("sentinel");
  });

  it("never inherits poisoned process credentials or shell startup injection", async () => {
    const response = await post({
      type: "exec",
      command: "env; printf '\\nfinished\\n'",
      options: { env: { THOR_OPENCODE_CALL_ID: "test-call" } },
    });
    const output = await response.text();
    expect(output).toContain("PATH=");
    expect(output).toContain("THOR_OPENCODE_CALL_ID=test-call");
    expect(output).toContain("finished");
    expect(output).not.toContain("sentinel");
    expect(output).not.toContain("THOR_INTERNAL_SECRET");
    expect(output).not.toContain("SLACK_BOT_TOKEN");
    expect(output).not.toContain("NODE_OPTIONS");
    expect(output).not.toContain("BASH_ENV");
  });

  it.each([
    "THOR_INTERNAL_SECRET",
    "SLACK_BOT_TOKEN",
    "OPENAI_API_KEY",
    "BASH_ENV",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "THOR_OPENCODE_SECRET",
    "PATH",
  ])("rejects unapproved client environment name %s before shell execution", async (name) => {
    const response = await post({
      type: "exec",
      command: "touch forbidden",
      options: { env: { [name]: "credential-sentinel" } },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("credential-sentinel");
    expect(await (await post({ type: "exists", path: "forbidden" })).json()).toEqual({
      ok: true,
      value: false,
    });
  });

  it("sanitizes vendor errors rather than returning error causes or sensitive paths", async () => {
    const response = await post({ type: "readTextFile", path: "missing-credential-sentinel" });
    expect(await response.json()).toEqual({ ok: false, error: { code: "not_found" } });
    const exec = await post({
      type: "exec",
      command: "credential-sentinel",
      options: { cwd: "missing-credential-sentinel" },
    });
    expect(await exec.text()).toBe(
      '{"type":"result","result":{"ok":false,"error":{"code":"spawn_error"}}}\n',
    );
  });

  it("response disconnect cancels the Chord context and kills the vendor shell", async () => {
    const controller = new AbortController();
    const response = await fetch(`${url}/execute`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        sessionId: randomUUID(),
        cwd,
        operation: { type: "exec", command: "printf '%s\\n' \"$$\"; sleep 30; touch survived" },
      }),
    });
    if (!response.body) throw new Error("Pi executor test missing stream");
    const reader = response.body.getReader();
    const first = await reader.read();
    const frame: unknown = JSON.parse(new TextDecoder().decode(first.value).trim());
    const parsed = piExecFrameSchema.parse(frame);
    if (parsed.type !== "output") throw new Error("Pi executor test missing pid output");
    const pid = Number(parsed.text.trim());
    process.kill(pid, 0);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    expect(await (await post({ type: "exists", path: "survived" })).json()).toEqual({
      ok: true,
      value: false,
    });
  });
});
