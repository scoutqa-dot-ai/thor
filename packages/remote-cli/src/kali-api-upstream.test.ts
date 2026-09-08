import { afterEach, describe, expect, it, vi } from "vitest";
import { createKaliApiMcpClient, KALI_API_TOOLS } from "./kali-api-upstream.js";

describe("Kali API MCP bridge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes the official mcp-kali-server tool inventory", () => {
    expect(KALI_API_TOOLS.map((tool) => tool.name)).toEqual([
      "nmap_scan",
      "gobuster_scan",
      "dirb_scan",
      "nikto_scan",
      "sqlmap_scan",
      "metasploit_run",
      "hydra_attack",
      "john_crack",
      "wpscan_analyze",
      "enum4linux_scan",
      "server_health",
      "execute_command",
    ]);
  });

  it("checks health on connect and maps tool calls to the Kali HTTP API", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url) === "https://kali.example.com/base/health") {
        return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
      }
      if (String(url) === "https://kali.example.com/base/api/tools/nmap") {
        return new Response(JSON.stringify({ stdout: "nmap result", success: true }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });

    const client = await createKaliApiMcpClient({
      baseUrl: "https://kali.example.com/base/",
      fetchImpl,
    });
    const result = await client.callTool({
      name: "nmap_scan",
      arguments: { target: "scanme.example", scan_type: "-sV" },
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://kali.example.com/base/health",
      "https://kali.example.com/base/api/tools/nmap",
    ]);
    expect(requests[1]!.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "scanme.example", scan_type: "-sV" }),
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ stdout: "nmap result", success: true }, null, 2),
        },
      ],
    });
  });

  it("maps server_health to GET /health", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
    });

    const client = await createKaliApiMcpClient({
      baseUrl: "http://kali.local:5000",
      fetchImpl,
    });
    await client.callTool({ name: "server_health", arguments: {} });

    expect(calls).toEqual([
      { url: "http://kali.local:5000/health", method: undefined },
      { url: "http://kali.local:5000/health", method: "GET" },
    ]);
  });

  it("fails fast when the Kali API URL is missing", async () => {
    await expect(createKaliApiMcpClient({ baseUrl: "" })).rejects.toThrow(
      "Kali API base URL is not configured",
    );
  });
});
