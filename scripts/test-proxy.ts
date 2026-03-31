/**
 * Test script for the MCP Policy Proxy.
 *
 * Tests three exit criteria:
 * 1. tools/list — returns only the curated (allowed) tools
 * 2. tools/call (allowed) — forwards to upstream and returns result
 * 3. tools/call (hidden) — non-exposed tool is rejected as unknown
 *
 * Prerequisites:
 *   - Proxy running on http://localhost:3010  (or PROXY_URL override)
 *
 * Usage:
 *   npx tsx scripts/test-proxy.ts
 */

const PROXY_URL = process.env.PROXY_URL || "http://localhost:3010/mcp";

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

let requestId = 0;
function nextId(): number {
  return ++requestId;
}

/**
 * Send a JSON-RPC request to the proxy over Streamable HTTP.
 * Handles session ID propagation.
 */
let sessionId: string | null = null;

async function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const body = {
    jsonrpc: "2.0",
    id: nextId(),
    method,
    ...(params !== undefined ? { params } : {}),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // Capture session ID from response
  const sid = res.headers.get("mcp-session-id");
  if (sid) {
    sessionId = sid;
  }

  const contentType = res.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    // Parse SSE response — collect all data events
    const text = await res.text();
    const lines = text.split("\n");
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      }
    }
    // Return the last JSON-RPC response found
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(dataLines[i]);
        if (parsed.id !== undefined || parsed.method !== undefined) {
          return parsed;
        }
      } catch {
        // skip non-JSON lines
      }
    }
    throw new Error(`No valid JSON-RPC response found in SSE stream:\n${text}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function testInitialize(): Promise<void> {
  console.log("\n── Test: Initialize session ──");

  const result = (await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-script", version: "0.0.1" },
  })) as { result?: { serverInfo?: { name: string } } };

  assert(sessionId !== null, "Session ID received");
  assert(result?.result?.serverInfo?.name === "thor-proxy", "Server identifies as thor-proxy");
}

async function testToolsList(): Promise<string[]> {
  console.log("\n── Test: tools/list ──");

  // Send initialized notification first (required by MCP protocol)
  await rpc("notifications/initialized");

  const result = (await rpc("tools/list", {})) as {
    result?: { tools?: Array<{ name: string; description?: string }> };
  };

  const tools = result?.result?.tools || [];

  assert(tools.length > 0, `Received ${tools.length} tools from proxy`);

  // With single-upstream proxy, tools are NOT prefixed
  const noPrefixed = tools.every((t) => !t.name.includes("__"));
  assert(noPrefixed, "Tool names have no upstream prefix (single-upstream mode)");

  // Log first few tool names
  console.log(
    `  Tools (first 5): ${tools
      .slice(0, 5)
      .map((t) => t.name)
      .join(", ")}`,
  );

  return tools.map((t) => t.name);
}

async function testAllowedToolCall(tools: string[]): Promise<void> {
  console.log("\n── Test: tools/call (allowed) ──");

  const allowedTool = tools[0];

  if (!allowedTool) {
    console.error("  ✗ No tool found to test");
    failed++;
    return;
  }

  console.log(`  Calling: ${allowedTool}`);

  // Try calling with empty/minimal args — we expect it to succeed (or fail at upstream level, not at proxy level)
  const result = (await rpc("tools/call", {
    name: allowedTool,
    arguments: {},
  })) as {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  };

  assert(result?.result !== undefined, "Received a result (tool call was forwarded)");

  const content = result?.result?.content;
  if (content && content.length > 0) {
    const text = content[0].text || "";
    assert(!text.includes("Unknown tool"), "Response is NOT an unknown-tool error");
    console.log(`  Response preview: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
  }
}

async function testHiddenToolCall(): Promise<void> {
  console.log("\n── Test: tools/call (hidden) ──");

  // Call a tool name that is not in the curated allow list
  const result = (await rpc("tools/call", {
    name: "fake_write_tool",
    arguments: {},
  })) as {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  };

  assert(result?.result?.isError === true, "Call returned an error");
  const text = result?.result?.content?.[0]?.text || "";
  assert(text.includes("Unknown tool"), `Error message: "${text}"`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("MCP Policy Proxy — Test Script");
  console.log(`Target: ${PROXY_URL}`);

  try {
    await testInitialize();
    const tools = await testToolsList();
    await testAllowedToolCall(tools);
    await testHiddenToolCall();
  } catch (err) {
    console.error("\nFatal error:", err);
    failed++;
  }

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
