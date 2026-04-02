/**
 * Test script for the MCP Policy Proxy (sessionless endpoints).
 *
 * Tests:
 * 1. POST /tools — list upstreams for a repo
 * 2. POST /:upstream/tools — list tools on an upstream
 * 3. POST /:upstream/tools/call (allowed) — forwards to upstream
 * 4. POST /:upstream/tools/call (hidden) — rejected as unknown
 * 5. GET /approval/:id — approval status lookup
 *
 * Prerequisites:
 *   - Proxy running on http://localhost:3001  (or PROXY_URL override)
 *   - config.json with at least one repo + upstream configured
 *
 * Usage:
 *   npx tsx scripts/test-proxy.ts
 *   PROXY_URL=http://localhost:3001 CWD=/workspace/repos/acme-app npx tsx scripts/test-proxy.ts
 */

const PROXY_URL = process.env.PROXY_URL || "http://localhost:3001";
const CWD = process.env.CWD || "/workspace/repos/acme-app";

// ── Helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${PROXY_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function get(path: string): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${PROXY_URL}${path}`);
  return { status: res.status, data: await res.json() };
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function testListUpstreams(): Promise<string> {
  console.log("\n── Test: POST /tools (list upstreams) ──");

  const { status, data } = await post("/tools", { cwd: CWD });
  const body = data as {
    upstreams?: Array<{ name: string; toolCount: number; connected: boolean }>;
  };

  assert(status === 200, `Status 200 (got ${status})`);
  assert(Array.isArray(body.upstreams), "Response has upstreams array");
  assert(body.upstreams!.length > 0, `Found ${body.upstreams!.length} upstream(s)`);

  const upstream = body.upstreams![0].name;
  console.log(`  Upstreams: ${body.upstreams!.map((u) => u.name).join(", ")}`);

  return upstream;
}

async function testListTools(upstream: string): Promise<string[]> {
  console.log(`\n── Test: POST /${upstream}/tools (list tools) ──`);

  const { status, data } = await post(`/${upstream}/tools`, { cwd: CWD });
  const body = data as {
    tools?: Array<{ name: string; description?: string; classification: string }>;
  };

  assert(status === 200, `Status 200 (got ${status})`);
  assert(Array.isArray(body.tools), "Response has tools array");
  assert(body.tools!.length > 0, `Found ${body.tools!.length} tool(s)`);

  console.log(
    `  Tools (first 5): ${body
      .tools!.slice(0, 5)
      .map((t) => t.name)
      .join(", ")}`,
  );

  return body.tools!.map((t) => t.name);
}

async function testAllowedToolCall(upstream: string, tools: string[]): Promise<void> {
  console.log(`\n── Test: POST /${upstream}/tools/call (allowed) ──`);

  const tool = tools[0];
  if (!tool) {
    console.error("  ✗ No tool found to test");
    failed++;
    return;
  }

  console.log(`  Calling: ${tool}`);

  const { status, data } = await post(`/${upstream}/tools/call`, {
    name: tool,
    arguments: {},
    cwd: CWD,
  });
  const body = data as { content?: Array<{ type: string; text: string }>; isError?: boolean };

  assert(status === 200 || status === 502, `Status 200 or 502 (got ${status})`);
  assert(body.content !== undefined, "Response has content");

  if (body.content && body.content.length > 0) {
    const text = body.content[0].text || "";
    assert(!text.includes("Unknown tool"), "Not an unknown-tool error");
    console.log(`  Response preview: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
  }
}

async function testHiddenToolCall(upstream: string): Promise<void> {
  console.log(`\n── Test: POST /${upstream}/tools/call (hidden) ──`);

  const { data } = await post(`/${upstream}/tools/call`, {
    name: "fake_write_tool",
    arguments: {},
    cwd: CWD,
  });
  const body = data as { content?: Array<{ type: string; text: string }>; isError?: boolean };

  assert(body.isError === true, "Call returned isError: true");
  const text = body.content?.[0]?.text || "";
  assert(text.includes("Unknown tool"), `Error message: "${text}"`);
}

async function testApprovalLookup(): Promise<void> {
  console.log("\n── Test: GET /approval/:id (not found) ──");

  const { status, data } = await get("/approval/00000000-0000-0000-0000-000000000000");
  const body = data as { error?: string };

  assert(status === 404, `Status 404 (got ${status})`);
  assert(body.error?.includes("No approval action found") === true, "Error message is correct");
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("MCP Policy Proxy — Sessionless Endpoint Tests");
  console.log(`Target: ${PROXY_URL}`);
  console.log(`CWD: ${CWD}`);

  try {
    const upstream = await testListUpstreams();
    const tools = await testListTools(upstream);
    await testAllowedToolCall(upstream, tools);
    await testHiddenToolCall(upstream);
    await testApprovalLookup();
  } catch (err) {
    console.error("\nFatal error:", err);
    failed++;
  }

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
