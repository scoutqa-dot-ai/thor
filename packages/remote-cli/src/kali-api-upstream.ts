import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const KALI_API_TOOLS: Tool[] = [
  {
    name: "nmap_scan",
    description: "Execute an Nmap scan against an authorized target.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        scan_type: { type: "string", default: "-sV" },
        ports: { type: "string", default: "" },
        additional_args: { type: "string", default: "" },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
  {
    name: "gobuster_scan",
    description: "Execute Gobuster against an authorized web, DNS, fuzz, or vhost target.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        mode: { type: "string", enum: ["dir", "dns", "fuzz", "vhost"], default: "dir" },
        wordlist: { type: "string", default: "/usr/share/wordlists/dirb/common.txt" },
        additional_args: { type: "string", default: "" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "dirb_scan",
    description: "Execute Dirb web content scanning against an authorized URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        wordlist: { type: "string", default: "/usr/share/wordlists/dirb/common.txt" },
        additional_args: { type: "string", default: "" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "nikto_scan",
    description: "Execute Nikto web server scanning against an authorized target.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        additional_args: { type: "string", default: "" },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
  {
    name: "sqlmap_scan",
    description: "Execute SQLmap against an authorized URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        data: { type: "string", default: "" },
        additional_args: { type: "string", default: "" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "metasploit_run",
    description: "Execute a Metasploit module against authorized targets.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string" },
        options: { type: "object", additionalProperties: true, default: {} },
      },
      required: ["module"],
      additionalProperties: false,
    },
  },
  {
    name: "hydra_attack",
    description: "Execute Hydra password testing against an authorized target and service.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        service: { type: "string" },
        username: { type: "string", default: "" },
        username_file: { type: "string", default: "" },
        password: { type: "string", default: "" },
        password_file: { type: "string", default: "" },
        additional_args: { type: "string", default: "" },
      },
      required: ["target", "service"],
      additionalProperties: false,
    },
  },
  {
    name: "john_crack",
    description: "Execute John the Ripper against an authorized hash file on the Kali host.",
    inputSchema: {
      type: "object",
      properties: {
        hash_file: { type: "string" },
        wordlist: { type: "string", default: "/usr/share/wordlists/rockyou.txt" },
        format_type: { type: "string", default: "" },
        additional_args: { type: "string", default: "" },
      },
      required: ["hash_file"],
      additionalProperties: false,
    },
  },
  {
    name: "wpscan_analyze",
    description: "Execute WPScan against an authorized WordPress URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        additional_args: { type: "string", default: "" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "enum4linux_scan",
    description: "Execute enum4linux against an authorized target.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        additional_args: { type: "string", default: "-a" },
      },
      required: ["target"],
      additionalProperties: false,
    },
  },
  {
    name: "server_health",
    description: "Check health and available tool status for the Kali API server.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "execute_command",
    description:
      "Execute an arbitrary command on the operator-hosted Kali server for authorized testing only.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

const KALI_TOOL_ENDPOINTS: Record<string, { method: "GET" | "POST"; path: string }> = {
  nmap_scan: { method: "POST", path: "api/tools/nmap" },
  gobuster_scan: { method: "POST", path: "api/tools/gobuster" },
  dirb_scan: { method: "POST", path: "api/tools/dirb" },
  nikto_scan: { method: "POST", path: "api/tools/nikto" },
  sqlmap_scan: { method: "POST", path: "api/tools/sqlmap" },
  metasploit_run: { method: "POST", path: "api/tools/metasploit" },
  hydra_attack: { method: "POST", path: "api/tools/hydra" },
  john_crack: { method: "POST", path: "api/tools/john" },
  wpscan_analyze: { method: "POST", path: "api/tools/wpscan" },
  enum4linux_scan: { method: "POST", path: "api/tools/enum4linux" },
  server_health: { method: "GET", path: "health" },
  execute_command: { method: "POST", path: "api/command" },
};

export interface KaliApiClientConfig {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface KaliApiMcpClient {
  callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

function normalizeBaseUrl(baseUrl: string): URL {
  if (!baseUrl.trim()) {
    throw new Error("Kali API base URL is not configured");
  }
  const normalized = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return new URL(normalized);
}

function buildUrl(baseUrl: URL, path: string): URL {
  return new URL(`${baseUrl.pathname.replace(/\/$/, "")}/${path}`, baseUrl);
}

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text, success: false };
  }
}

export async function createKaliApiMcpClient(
  config: KaliApiClientConfig,
): Promise<KaliApiMcpClient> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  const healthUrl = buildUrl(baseUrl, "health");
  const healthResponse = await fetchImpl(healthUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!healthResponse.ok) {
    const body = await healthResponse.text();
    throw new Error(`Kali API health check failed with HTTP ${healthResponse.status}: ${body}`);
  }

  return {
    async callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown> {
      const endpoint = KALI_TOOL_ENDPOINTS[input.name];
      if (!endpoint) {
        throw new Error(`Unknown Kali API tool: ${input.name}`);
      }

      const response = await fetchImpl(buildUrl(baseUrl, endpoint.path), {
        method: endpoint.method,
        headers: endpoint.method === "POST" ? { "content-type": "application/json" } : undefined,
        body: endpoint.method === "POST" ? JSON.stringify(input.arguments ?? {}) : undefined,
        signal: AbortSignal.timeout(config.timeoutMs ?? 300_000),
      });
      const payload = await readResponseJson(response);
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    },

    async close(): Promise<void> {
      // The Kali API bridge is stateless per request.
    },
  };
}
