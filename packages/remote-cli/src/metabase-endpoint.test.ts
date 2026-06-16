import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const { executeQueryMock, listTablesMock, logErrorMock, logWarnMock } = vi.hoisted(() => ({
  executeQueryMock: vi.fn(),
  listTablesMock: vi.fn(),
  logErrorMock: vi.fn(),
  logWarnMock: vi.fn(),
}));

vi.mock("@thor/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@thor/common")>();
  return { ...actual, logError: logErrorMock, logWarn: logWarnMock };
});

// Preserve the real MetabaseError class so the endpoint can classify on type;
// only the network-backed client functions are replaced with mocks.
vi.mock("./metabase.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./metabase.ts")>();
  return {
    ...actual,
    listSchemas: vi.fn(),
    listTables: listTablesMock,
    getColumns: vi.fn(),
    executeQuery: executeQueryMock,
    getQuestion: vi.fn(),
  };
});

import { createRemoteCliApp } from "./index.ts";
import { MetabaseError } from "./metabase.ts";

describe("remote-cli metabase endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let closeRemoteCli: () => Promise<void>;

  beforeEach(async () => {
    executeQueryMock.mockReset();
    listTablesMock.mockReset();
    logErrorMock.mockReset();
    logWarnMock.mockReset();

    const remoteCli = createRemoteCliApp({
      appEnv: { thorInternalSecret: "test-secret", isProduction: false },
    });
    closeRemoteCli = remoteCli.close;

    server = createServer(remoteCli.app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closeRemoteCli();
  });

  it("returns a normal tool failure for user errors without error logging", async () => {
    executeQueryMock.mockRejectedValue(
      new MetabaseError("Query failed: syntax error at or near FROM", true),
    );

    const response = await postJson("/exec/metabase", { args: ["query", "select * from"] });
    const body = (await response.json()) as { stderr: string; exitCode: number };

    expect(response.status).toBe(200);
    expect(body.exitCode).toBe(1);
    expect(body.stderr).toContain("syntax error");
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.anything(),
      "exec_metabase_query_failure",
      expect.objectContaining({ category: "metabase_query_failure", subcommand: "query" }),
    );
    expect(logErrorMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "exec_metabase_error",
      expect.anything(),
      expect.anything(),
    );
  });

  it("keeps service/auth failures as HTTP 500 error logs", async () => {
    executeQueryMock.mockRejectedValue(
      new MetabaseError("Metabase POST /api/dataset → 401: Unauthorized", false, 401),
    );

    const response = await postJson("/exec/metabase", { args: ["query", "select 1"] });
    const body = (await response.json()) as { stderr: string; exitCode: number };

    expect(response.status).toBe(500);
    expect(body.exitCode).toBe(1);
    expect(body.stderr).toContain("Unauthorized");
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      "exec_metabase_error",
      expect.stringContaining("Unauthorized"),
      expect.objectContaining({ subcommand: "query" }),
    );
  });

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
});
