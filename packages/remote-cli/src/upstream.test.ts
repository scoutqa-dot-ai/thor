import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { connectUpstream } from "./upstream.ts";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/stdio-mcp-server.mjs", import.meta.url));

describe("connectUpstream (stdio transport)", () => {
  afterEach(() => {
    delete process.env.THOR_SECRET_LEAK;
  });

  it("spawns the child, lists its tools, passes config.env, and does not leak parent secrets", async () => {
    // A secret on remote-cli's own process env must not reach the child: it is
    // not in the SDK's inherited allowlist and is not in config.env.
    process.env.THOR_SECRET_LEAK = "should-not-leak";

    const { client, tools } = await connectUpstream("stdio-test", {
      kind: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: { THOR_STDIO_TOOL: "custom_tool" },
    });

    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("custom_tool"); // config.env reached the child
    expect(toolNames).not.toContain("LEAKED"); // parent-process secret did not

    await client.close();
  });
});
