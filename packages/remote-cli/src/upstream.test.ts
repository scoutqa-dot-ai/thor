import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { connectUpstream } from "./upstream.ts";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/stdio-mcp-server.mjs", import.meta.url));

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

describe("connectUpstream (stdio transport)", () => {
  afterEach(() => {
    delete process.env.THOR_SECRET_LEAK;
  });

  it("spawns the child, lists its tools, passes config.env, and does not leak parent secrets", async () => {
    // Tripwire for the env-scrub the Grafana sandbox depends on: a secret on
    // remote-cli's own process env must not reach the child (it is not in the
    // SDK's inherited allowlist and not in config.env). If an SDK bump ever
    // widened that allowlist to forward arbitrary parent env, this fails.
    process.env.THOR_SECRET_LEAK = "should-not-leak";

    const { client, tools } = await connectUpstream("stdio-test", {
      kind: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: { THOR_STDIO_TOOL: "custom_tool" },
    });

    try {
      const toolNames = tools.map((tool) => tool.name);
      expect(toolNames).toContain("custom_tool"); // config.env reached the child
      expect(toolNames).not.toContain("LEAKED"); // parent-process secret did not
    } finally {
      await client.close();
    }
  });

  it("closes the child when tool listing fails during setup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thor-stdio-cleanup-"));
    const exitMarker = join(dir, "exited");

    try {
      await expect(
        connectUpstream("stdio-fail", {
          kind: "stdio",
          command: process.execPath,
          args: [FIXTURE],
          env: {
            THOR_STDIO_FAIL_LIST_TOOLS: "1",
            THOR_STDIO_EXIT_MARKER: exitMarker,
          },
        }),
      ).rejects.toThrow(/failed to list tools/i);

      await waitFor(() => existsSync(exitMarker));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
