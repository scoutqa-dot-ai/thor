import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { WorkspaceConfig } from "@thor/common";

const { execCommandMock, logErrorMock } = vi.hoisted(() => ({
  execCommandMock: vi.fn(),
  logErrorMock: vi.fn(),
}));

vi.mock("@thor/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@thor/common")>();
  return { ...actual, logError: logErrorMock };
});

// Keep parsePsqlInvocation + the rest of policy real; only stub cwd validation
// so the test does not depend on /workspace paths existing on the test host.
vi.mock("./policy.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./policy.ts")>();
  return { ...actual, validateCwd: () => null };
});

vi.mock("./exec.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exec.ts")>();
  return { ...actual, execCommand: execCommandMock };
});

import { createRemoteCliApp } from "./index.ts";

const commerce = {
  host: "qa-commerce.cluster-abc.us-east-1.rds.amazonaws.com",
  port: 5432,
  database: "commerce",
  username: "thor_ro",
  password: "s3cret",
  sslmode: "require",
};

describe("remote-cli psql endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let closeRemoteCli: () => Promise<void>;

  beforeEach(async () => {
    execCommandMock.mockReset();
    execCommandMock.mockResolvedValue({ stdout: "ok\n", stderr: "", exitCode: 0 });
    logErrorMock.mockReset();
    process.env.PSQL_DATABASES = JSON.stringify({ commerce });

    const config: WorkspaceConfig = {} as WorkspaceConfig;
    const remoteCli = createRemoteCliApp({
      appEnv: { thorInternalSecret: "test-secret", isProduction: false },
      configLoader: () => config,
    });
    closeRemoteCli = remoteCli.close;

    server = createServer(remoteCli.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    delete process.env.PSQL_DATABASES;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closeRemoteCli();
  });

  const postPsql = (args: string[]) =>
    fetch(`${baseUrl}/exec/psql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args, cwd: "/workspace/repos/thor" }),
    });

  it("resolves the alias and injects credentials via env, never argv", async () => {
    const response = await postPsql(["commerce", "-c", "select 1"]);
    expect(response.status).toBe(200);

    expect(execCommandMock).toHaveBeenCalledTimes(1);
    const [binary, args, cwd, options] = execCommandMock.mock.calls[0];
    expect(binary).toBe("psql");
    // Alias is stripped; read-only flags are prepended; query is forwarded.
    expect(args).toEqual(["-X", "-w", "-v", "ON_ERROR_STOP=1", "-c", "select 1"]);
    expect(cwd).toBe("/workspace/repos/thor");

    // Credentials only in env, and read-only is enforced at connection.
    expect(options.env).toMatchObject({
      PGHOST: commerce.host,
      PGPORT: "5432",
      PGDATABASE: "commerce",
      PGUSER: "thor_ro",
      PGPASSWORD: "s3cret",
      PGSSLMODE: "require",
      PGOPTIONS: "-c default_transaction_read_only=on",
    });
    expect(JSON.stringify(args)).not.toContain("s3cret");
  });

  it("returns the available aliases for an unknown alias and does not exec", async () => {
    const response = await postPsql(["nope", "-c", "select 1"]);
    const body = (await response.json()) as { stderr: string; exitCode: number };
    expect(response.status).toBe(400);
    expect(body.stderr).toContain('unknown database alias "nope"');
    expect(body.stderr).toContain("Available: commerce");
    expect(execCommandMock).not.toHaveBeenCalled();
  });

  it("rejects a connection-control flag before reaching psql", async () => {
    const response = await postPsql(["commerce", "-h", "evil-host"]);
    const body = (await response.json()) as { stderr: string };
    expect(response.status).toBe(400);
    expect(body.stderr).toMatch(/is not allowed/);
    expect(execCommandMock).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed operator bundle without leaking values", async () => {
    process.env.PSQL_DATABASES = "{not json";
    const response = await postPsql(["commerce"]);
    const body = (await response.json()) as { stderr: string };
    expect(response.status).toBe(400);
    expect(body.stderr).toContain("psql configuration error");
    expect(execCommandMock).not.toHaveBeenCalled();
  });
});
