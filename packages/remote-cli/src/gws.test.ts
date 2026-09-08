import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecResultSchema } from "@thor/common";
import { createRemoteCliApp } from "./index.ts";

describe("Google Workspace HTTP boundary with a real subprocess", () => {
  let root: string;
  let configDir: string;
  let credentialsFile: string;
  let server: Server | undefined;
  let close: (() => Promise<void>) | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "thor-gws-"));
    configDir = join(root, "private");
    credentialsFile = join(root, "credentials.json");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(credentialsFile, "fake credential fixture, never a real key");
    // A real executable at the external process boundary. Records invocation,
    // returns data/errors, and never contacts Google or reads credentials.
    await writeFile(
      join(bin, "gws"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify({args, cwd: process.cwd(), credentials: process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, envKeys: Object.keys(process.env)}) + '\\n');
if (args.includes('{"fileId":"missing"}')) {
  process.stderr.write('Google fixture: file not found');
  process.exit(1);
}
process.stdout.write(JSON.stringify({files: [{id: 'fixture-file', name: 'Report'}]}));
`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("GOOGLE_WORKSPACE_CLI_CONFIG_DIR", configDir);
    vi.stubEnv("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE", credentialsFile);
    vi.stubEnv("GOOGLE_WORKSPACE_CLI_TOKEN", "must-not-be-inherited");
    vi.stubEnv("SLACK_BOT_TOKEN", "must-not-be-inherited");
  });

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      );
    await close?.();
    server = undefined;
    close = undefined;
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function start() {
    const remoteCli = createRemoteCliApp();
    close = remoteCli.close;
    server = createServer(remoteCli.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function request(args: unknown, cwd = "/untrusted/repo") {
    const response = await fetch(`${baseUrl}/exec/gws`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args, cwd }),
    });
    return { status: response.status, result: ExecResultSchema.parse(await response.json()) };
  }

  it("runs reads in private storage, bounds pagination, and excludes unrelated secrets", async () => {
    await start();
    expect(await request(["drive", "files", "list", "--page-all"])).toEqual({
      status: 200,
      result: {
        stdout: '{"files":[{"id":"fixture-file","name":"Report"}]}',
        stderr: "",
        exitCode: 0,
      },
    });
    const record = await readFile(join(configDir, "calls.jsonl"), "utf8");
    expect(JSON.parse(record)).toEqual({
      args: ["drive", "files", "list", "--page-all", "--page-limit", "10", "--format", "json"],
      cwd: configDir,
      credentials: credentialsFile,
      envKeys: expect.arrayContaining([
        "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE",
        "GOOGLE_WORKSPACE_CLI_CONFIG_DIR",
      ]),
    });
    expect(record).not.toContain("SLACK_BOT_TOKEN");
    expect(record).not.toContain("GOOGLE_WORKSPACE_CLI_TOKEN");
    expect(record).not.toContain("/untrusted/repo");
  });

  it("rejects writes, file reads, and malformed requests before starting gws", async () => {
    await start();
    for (const args of [
      ["docs", "documents", "create"],
      ["drive", "files", "list", "--params", `@${credentialsFile}`],
      ["sheets", "+append", "--help"],
      null,
    ]) {
      expect(await request(args)).toMatchObject({
        status: 400,
        result: { stdout: "", exitCode: 1 },
      });
    }
    await expect(readFile(join(configDir, "calls.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("propagates upstream stderr and exit status without converting it into an HTTP failure", async () => {
    await start();
    expect(await request(["drive", "files", "get", "--params", '{"fileId":"missing"}'])).toEqual({
      status: 200,
      result: { stdout: "", stderr: "Google fixture: file not found", exitCode: 1 },
    });
  });

  it("allows discovery while unconfigured but fails API reads closed", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE", "");
    await start();
    expect(await request(["drive", "files", "list"])).toMatchObject({
      status: 503,
      result: { exitCode: 2, stderr: expect.stringContaining("not configured") },
    });
    await expect(readFile(join(configDir, "calls.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await request(["--help"])).toMatchObject({ status: 200, result: { exitCode: 0 } });
    expect(await request(["schema", "docs.documents.get"])).toMatchObject({
      status: 200,
      result: { exitCode: 0 },
    });
  });

  it.each(["missing", "directory", "relative"])(
    "fails closed for %s credential configuration",
    async (kind) => {
      if (kind === "missing") await rm(credentialsFile);
      if (kind === "directory") vi.stubEnv("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE", root);
      if (kind === "relative")
        vi.stubEnv("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE", "credentials.json");
      await start();
      expect(await request(["docs", "documents", "get"])).toMatchObject({
        status: 503,
        result: { stdout: "", exitCode: 2 },
      });
      await expect(readFile(join(configDir, "calls.jsonl"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
