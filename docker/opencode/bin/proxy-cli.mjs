#!/usr/bin/env node
/**
 * HTTP client for mcp/approval CLI wrappers.
 * Talks to the proxy service (not remote-cli).
 *
 * Usage:
 *   node proxy-cli.mjs mcp                                    # list upstreams
 *   node proxy-cli.mjs mcp <upstream>                          # list tools
 *   node proxy-cli.mjs mcp <upstream> <tool> --help            # tool schema
 *   node proxy-cli.mjs mcp <upstream> <tool> '{"arg":"val"}'   # call tool
 *   node proxy-cli.mjs approval status <id>                    # check approval
 *   node proxy-cli.mjs approval list                           # list pending
 *
 * Env:
 *   THOR_PROXY_URL — base URL of the proxy (e.g. http://proxy:3001)
 */

const [command, ...args] = process.argv.slice(2);

if (!command || (command !== "mcp" && command !== "approval")) {
  process.stderr.write("Usage: proxy-cli.mjs <mcp|approval> [args...]\n");
  process.exit(1);
}

const proxyUrl = process.env.THOR_PROXY_URL;
if (!proxyUrl) {
  process.stderr.write("THOR_PROXY_URL is not set\n");
  process.exit(1);
}

const directory = process.env.THOR_OPENCODE_DIRECTORY;
if (!directory) {
  process.stderr.write("THOR_OPENCODE_DIRECTORY is not set — shell.env plugin may not be loaded\n");
  process.exit(1);
}

const sessionId = process.env.THOR_OPENCODE_SESSION_ID || "";
const callId = process.env.THOR_OPENCODE_CALL_ID || "";
const thorHeaders = {
  "x-thor-directory": directory,
  ...(sessionId && { "x-thor-session-id": sessionId }),
  ...(callId && { "x-thor-call-id": callId }),
};

// --- HTTP helpers ---

async function jsonGet(url) {
  const res = await fetch(url, { headers: thorHeaders, signal: AbortSignal.timeout(120_000) });
  return { res, body: await res.json() };
}

async function jsonPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...thorHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  return { res, body: await res.json() };
}

// --- Fuzzy matching (substring) ---

function fuzzyMatch(input, candidates) {
  const lower = input.toLowerCase();
  return candidates.filter((c) => c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase()));
}

function suggestMatch(input, candidates) {
  const matches = fuzzyMatch(input, candidates);
  if (matches.length > 0) {
    return `Did you mean "${matches[0]}"? `;
  }
  return "";
}

// --- Upstream list cache (for fuzzy suggestions) ---

let cachedUpstreams = null;

async function getUpstreamNames() {
  if (cachedUpstreams) return cachedUpstreams;
  try {
    const { res, body } = await jsonGet(`${proxyUrl}/upstreams`);
    if (res.ok && body.upstreams) {
      cachedUpstreams = body.upstreams.map((u) => u.name);
      return cachedUpstreams;
    }
  } catch {}
  return [];
}

// --- Main ---

try {
  if (command === "mcp") {
    await handleMcp(args);
  } else {
    await handleApproval(args);
  }
} catch (err) {
  if (err.name === "TimeoutError") {
    process.stderr.write(`Timeout reaching proxy at ${proxyUrl} (120s)\n`);
  } else {
    process.stderr.write(`Failed to reach proxy at ${proxyUrl}: ${err.message}\n`);
  }
  process.exit(1);
}

async function handleMcp(args) {
  // mcp (no args) — list upstreams
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    const { res, body } = await jsonGet(`${proxyUrl}/upstreams`);
    if (!res.ok) {
      process.stderr.write(`${body.error || JSON.stringify(body)}\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }

  const upstream = args[0];

  // Fetch tools for this upstream (shared across subcommands)
  async function fetchTools() {
    const { res, body } = await jsonGet(`${proxyUrl}/${upstream}/tools`);
    if (!res.ok) {
      if (res.status === 403 || res.status === 404) {
        const upstreams = await getUpstreamNames();
        const suggestion = suggestMatch(upstream, upstreams);
        process.stderr.write(
          `Unknown upstream "${upstream}". ${suggestion}Available upstreams: ${upstreams.join(", ") || "(none)"}\n`,
        );
        process.exit(1);
      }
      process.stderr.write(`${body.error || JSON.stringify(body)}\n`);
      process.exit(1);
    }
    return body.tools ?? [];
  }

  // Resolve a tool by name (exact or fuzzy). Exits on no match.
  function resolveTool(tools, name) {
    const exact = tools.find((t) => t.name === name);
    if (exact) return exact;

    const matches = fuzzyMatch(name, tools.map((t) => t.name));
    if (matches.length === 1) {
      return tools.find((t) => t.name === matches[0]);
    }

    const suggestion = suggestMatch(name, tools.map((t) => t.name));
    process.stderr.write(
      `Unknown tool "${name}" on upstream "${upstream}". ${suggestion}Available tools: ${tools.map((t) => t.name).join(", ")}\n`,
    );
    process.exit(1);
  }

  // mcp <upstream> — list tool names only
  if (args.length === 1) {
    const tools = await fetchTools();
    for (const t of tools) process.stdout.write(`${t.name}\n`);
    return;
  }

  const tool = args[1];

  // mcp <upstream> <tool> --help — show tool schema
  if (args.length === 3 && args[2] === "--help") {
    const tools = await fetchTools();
    const toolInfo = resolveTool(tools, tool);
    process.stdout.write(JSON.stringify(toolInfo, null, 2) + "\n");
    return;
  }

  // mcp <upstream> <tool> ['<json>'] — call tool
  // Accept JSON from positional arg OR stdin (heredoc/pipe avoids shell quoting issues).
  let jsonArg = args[2];
  if (!jsonArg) {
    // No positional arg — try stdin (supports heredoc and pipe)
    if (process.stdin.isTTY) {
      // Interactive terminal with no arg — show help
      const tools = await fetchTools();
      const toolInfo = resolveTool(tools, tool);
      process.stdout.write(JSON.stringify(toolInfo, null, 2) + "\n");
      return;
    }
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    jsonArg = Buffer.concat(chunks).toString().trim();
    if (!jsonArg) {
      process.stderr.write(`Usage: mcp ${upstream} ${tool} <<'EOF'\n{"arg":"val"}\nEOF\n`);
      process.exit(1);
    }
  }
  let toolArgs;
  try {
    toolArgs = JSON.parse(jsonArg);
  } catch {
    // Invalid JSON — show error with schema hint
    process.stderr.write(`Invalid JSON argument: ${jsonArg}\n`);
    try {
      const tools = await fetchTools();
      const toolInfo = resolveTool(tools, tool);
      if (toolInfo.inputSchema) {
        process.stderr.write(
          `\n[hint] Input schema for "${toolInfo.name}":\n${JSON.stringify(toolInfo.inputSchema, null, 2)}\n`,
        );
      }
    } catch {
      // Best-effort hint
    }
    process.exit(1);
  }

  const { res, body } = await jsonPost(`${proxyUrl}/${upstream}/tools/call`, {
    name: tool,
    arguments: toolArgs,
  });

  if (!res.ok && !body.stdout) {
    process.stderr.write(`${body.error || JSON.stringify(body)}\n`);
    process.exit(1);
  }

  if (body.stdout) process.stdout.write(body.stdout + "\n");
  if (body.stderr) process.stderr.write(body.stderr);
  process.exit(body.exitCode ?? (res.ok ? 0 : 1));
}

async function handleApproval(args) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stderr.write("Usage:\n  approval status <action-id>\n  approval list\n");
    process.exit(1);
  }

  const subcommand = args[0];

  if (subcommand === "status") {
    if (!args[1]) {
      process.stderr.write("Usage: approval status <action-id>\n");
      process.exit(1);
    }
    const { res, body } = await jsonGet(`${proxyUrl}/approval/${args[1]}`);
    if (!res.ok) {
      process.stderr.write(`${body.error || JSON.stringify(body)}\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }

  if (subcommand === "list") {
    const { res, body } = await jsonGet(`${proxyUrl}/approvals`);
    if (!res.ok) {
      process.stderr.write(`${body.error || JSON.stringify(body)}\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }

  process.stderr.write(
    `Unknown subcommand: ${subcommand}\nUsage:\n  approval status <action-id>\n  approval list\n`,
  );
  process.exit(1);
}
