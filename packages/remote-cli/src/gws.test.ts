import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRemoteCliApp } from "./index.js";

import type { GwsAccessToken } from "./gws-oauth.js";
import { GwsService } from "./gws.js";

const CallSchema = z.object({
  args: z.array(z.string()),
  cwd: z.string(),
  token: z.string().optional(),
  credentials: z.string().optional(),
  envKeys: z.array(z.string()),
});

const accessToken = "fixture-short-lived-access-token";

describe("Google Workspace argument passthrough with a real inert subprocess", () => {
  let root: string;
  let configDir: string;
  let bin: string;
  let callsFile: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "thor-gws-"));
    configDir = join(root, "private");
    bin = join(root, "bin");
    callsFile = join(root, "calls.jsonl");
    await mkdir(bin);
    await writeFile(
      join(bin, "gws"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({args, cwd: process.cwd(), token: process.env.GOOGLE_WORKSPACE_CLI_TOKEN, credentials: process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, envKeys: Object.keys(process.env)}) + '\\n');
if (args.includes('{"fileId":"denied"}')) {
  process.stderr.write('Google fixture: permission denied');
  process.exit(1);
}
process.stdout.write('upstream output');
`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("GOOGLE_WORKSPACE_CLI_CONFIG_DIR", configDir);
    vi.stubEnv("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE", "must-not-be-inherited");
    vi.stubEnv("GOOGLE_WORKSPACE_CLI_TOKEN", "must-not-be-inherited");
    vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", "must-not-be-inherited");
    vi.stubEnv("SLACK_BOT_TOKEN", "must-not-be-inherited");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function token(): GwsAccessToken {
    return {
      connectionId: "019d0000-0000-7000-8000-000000000001",
      googleEmail: "person@example.com",
      googleSubject: "google-subject-123",
      reveal: () => accessToken,
    };
  }

  async function calls() {
    return (await readFile(callsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => CallSchema.parse(JSON.parse(line)));
  }

  it("passes commands unchanged with only the approved short-lived token", async () => {
    const service = new GwsService(process.env);
    const commands = [
      [],
      ["docs", "documents", "create", "--json", '{"title":"Report"}'],
      ["drive", "files", "list", "--page-all", "--page-limit", "50", "--format", "csv"],
      ["schema", "docs.documents.create"],
      ["future-service", "future-resource", "action", "--new-flag"],
    ];
    for (const args of commands) {
      const response = await service.execute(args, token());
      expect(response).toEqual({
        status: 200,
        result: { stdout: "upstream output", stderr: "", exitCode: 0 },
      });
    }

    const recorded = await calls();
    expect(recorded.map((call) => call.args)).toEqual(commands);
    for (const call of recorded) {
      expect(call.cwd).toMatch(new RegExp(`^${configDir}/execution-`));
      expect(call.token).toBe(accessToken);
      expect(call.credentials).toBeUndefined();
      expect(call.envKeys).not.toContain("SLACK_BOT_TOKEN");
      expect(call.envKeys).not.toContain("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET");
    }
  });

  it("serves public help/schema through HTTP without Google setup, actor, token or auth DM", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_ID", "");
    const service = new GwsService(process.env);
    const remote = createRemoteCliApp({ gws: service, configLoader: () => ({ users: [] }) });
    const server = createServer(remote.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Public GWS fixture unavailable");
    try {
      for (const args of [
        ["--help"],
        ["--version"],
        ["schema", "drive.files.get"],
        ["docs", "documents", "get", "--help"],
      ]) {
        const response = await fetch(`http://127.0.0.1:${address.port}/exec/gws`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ args }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          stdout: "upstream output",
          stderr: "",
          exitCode: 0,
        });
      }
      expect(await service.executePublicDiscovery(["drive", "files", "delete"])).toMatchObject({
        status: 503,
      });
      const recorded = await calls();
      expect(recorded).toHaveLength(4);
      for (const call of recorded) {
        expect(call.token).toBeUndefined();
        expect(call.credentials).toBeUndefined();
        expect(call.envKeys).not.toContain("SLACK_BOT_TOKEN");
        expect(call.envKeys).not.toContain("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await remote.close();
    }
  });

  it("propagates upstream permission denials and exit status", async () => {
    const service = new GwsService(process.env);
    expect(
      await service.execute(
        ["drive", "files", "delete", "--params", '{"fileId":"denied"}'],
        token(),
      ),
    ).toEqual({
      status: 200,
      result: { stdout: "", stderr: "Google fixture: permission denied", exitCode: 1 },
    });
    expect(await calls()).toHaveLength(1);
  });

  it("reports invalid private-directory configuration without spawning gws", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_CLI_CONFIG_DIR", "relative-directory");
    const service = new GwsService(process.env);
    expect(await service.execute(["--help"], token())).toMatchObject({
      status: 503,
      result: { stdout: "", exitCode: 2 },
    });
    await expect(readFile(callsFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
