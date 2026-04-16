/**
 * Test script for remote-cli MCP endpoints.
 *
 * Usage:
 *   npx tsx scripts/test-mcp.ts
 *   REMOTE_CLI_URL=http://localhost:3004 CWD=/workspace/repos/acme-app npx tsx scripts/test-mcp.ts
 */

const REMOTE_CLI_URL = process.env.REMOTE_CLI_URL || "http://localhost:3004";
const CWD = process.env.CWD || "/workspace/repos/acme-app";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed += 1;
  } else {
    console.error(`  ✗ ${message}`);
    failed += 1;
  }
}

async function post(
  path: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${REMOTE_CLI_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function testListUpstreams(): Promise<string> {
  console.log("\n── Test: POST /exec/mcp (list upstreams) ──");

  const { status, data } = await post("/exec/mcp", { args: [], cwd: CWD, directory: CWD });
  const body = data as { stdout?: string };
  const parsed = JSON.parse(body.stdout || "{}") as {
    upstreams?: Array<{ name: string; toolCount: number; connected: boolean }>;
  };

  assert(status === 200, `Status 200 (got ${status})`);
  assert(Array.isArray(parsed.upstreams), "Response contains upstreams array");
  assert((parsed.upstreams?.length || 0) > 0, `Found ${parsed.upstreams?.length || 0} upstream(s)`);

  const upstream = parsed.upstreams?.[0]?.name || "";
  console.log(`  Upstreams: ${(parsed.upstreams || []).map((entry) => entry.name).join(", ")}`);

  return upstream;
}

async function testListTools(upstream: string): Promise<string[]> {
  console.log(`\n── Test: POST /exec/mcp (${upstream} tools) ──`);

  const { status, data } = await post("/exec/mcp", {
    args: [upstream],
    cwd: CWD,
    directory: CWD,
  });
  const body = data as { stdout?: string };
  const tools = (body.stdout || "")
    .split("\n")
    .map((tool) => tool.trim())
    .filter(Boolean);

  assert(status === 200, `Status 200 (got ${status})`);
  assert(tools.length > 0, `Found ${tools.length} tool(s)`);
  console.log(`  Tools (first 5): ${tools.slice(0, 5).join(", ")}`);

  return tools;
}

async function testToolHelp(upstream: string, tool: string): Promise<void> {
  console.log(`\n── Test: POST /exec/mcp (${upstream}/${tool} --help) ──`);

  const { status, data } = await post("/exec/mcp", {
    args: [upstream, tool, "--help"],
    cwd: CWD,
    directory: CWD,
  });
  const body = data as { stdout?: string };
  const parsed = JSON.parse(body.stdout || "{}") as { name?: string };

  assert(status === 200, `Status 200 (got ${status})`);
  assert(parsed.name === tool, `Schema returned for ${tool}`);
}

async function testApprovalList(): Promise<void> {
  console.log("\n── Test: POST /exec/approval (list) ──");

  const { status, data } = await post("/exec/approval", { args: ["list"] });
  const body = data as { stdout?: string };
  const parsed = JSON.parse(body.stdout || "{}") as { approvals?: unknown[] };

  assert(status === 200, `Status 200 (got ${status})`);
  assert(Array.isArray(parsed.approvals), "Response contains approvals array");
}

async function main(): Promise<void> {
  console.log("remote-cli MCP endpoint tests");
  console.log(`Target: ${REMOTE_CLI_URL}`);
  console.log(`CWD: ${CWD}`);

  try {
    const upstream = await testListUpstreams();
    const tools = await testListTools(upstream);
    if (tools[0]) {
      await testToolHelp(upstream, tools[0]);
    }
    await testApprovalList();
  } catch (err) {
    console.error("\nFatal error:", err);
    failed += 1;
  }

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
