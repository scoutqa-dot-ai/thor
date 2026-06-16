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

vi.mock("./metabase.ts", () => ({
  listSchemas: vi.fn(),
  listTables: listTablesMock,
  getColumns: vi.fn(),
  executeQuery: executeQueryMock,
  getQuestion: vi.fn(),
}));

import { createRemoteCliApp, isMetabaseUserFailure } from "./index.ts";

describe("metabase failure classification", () => {
  it("classifies bounded user/query failures only", () => {
    expect(isMetabaseUserFailure("query", "Query failed: syntax error at or near SELECT")).toBe(
      true,
    );
    expect(
      isMetabaseUserFailure("tables", "Metabase GET /api/database/1/schema/missing → 404: nope"),
    ).toBe(true);
    expect(isMetabaseUserFailure("query", "Metabase POST /api/dataset → 401: Unauthorized")).toBe(
      false,
    );
    expect(isMetabaseUserFailure("query", "fetch failed")).toBe(false);
  });
});

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

  it("returns a normal tool failure for bad SQL without error logging", async () => {
    executeQueryMock.mockRejectedValue(new Error("Query failed: syntax error at or near FROM"));

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
    executeQueryMock.mockRejectedValue(new Error("Metabase POST /api/dataset → 401: Unauthorized"));

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
