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

const cwd = process.cwd();

async function jsonPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
}

async function jsonGet(url) {
  const res = await fetch(url);
  return { res, body: await res.json() };
}

try {
  if (command === "mcp") {
    await handleMcp(args);
  } else {
    await handleApproval(args);
  }
} catch (err) {
  process.stderr.write(`Failed to reach proxy at ${proxyUrl}: ${err.message}\n`);
  process.exit(1);
}

async function handleMcp(args) {
  // mcp (no args) — list upstreams
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    const { res, body } = await jsonPost(`${proxyUrl}/tools`, { cwd });
    if (!res.ok) {
      process.stderr.write(`${body.error || JSON.stringify(body)}\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }

  const upstream = args[0];

  // mcp <upstream> (or --help) — list tools
  if (args.length === 1 || args[1] === "--help") {
    const { res, body } = await jsonPost(`${proxyUrl}/${upstream}/tools`, { cwd });
    if (!res.ok) {
      process.stderr.write(`${body.error || JSON.stringify(body)}\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }

  const tool = args[1];

  // mcp <upstream> <tool> --help — tool schema
  if (args.length === 3 && args[2] === "--help") {
    const { res, body } = await jsonPost(`${proxyUrl}/${upstream}/tools`, { cwd });
    if (!res.ok) {
      process.stderr.write(`${body.error || JSON.stringify(body)}\n`);
      process.exit(1);
    }
    const toolInfo = body.tools?.find((t) => t.name === tool);
    if (!toolInfo) {
      process.stderr.write(`Unknown tool "${tool}" on upstream "${upstream}"\n`);
      if (body.tools?.length) {
        process.stderr.write(`Available tools: ${body.tools.map((t) => t.name).join(", ")}\n`);
      }
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(toolInfo, null, 2) + "\n");
    return;
  }

  // mcp <upstream> <tool> '<json>' — call tool
  const jsonArg = args[2];
  let toolArgs;
  try {
    toolArgs = JSON.parse(jsonArg);
  } catch {
    process.stderr.write(`Invalid JSON argument: ${jsonArg}\n`);
    process.exit(1);
  }

  const { res, body } = await jsonPost(`${proxyUrl}/${upstream}/tools/call`, {
    name: tool,
    arguments: toolArgs,
    cwd,
  });
  if (!res.ok) {
    process.stderr.write(`${body.error || JSON.stringify(body)}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(body) + "\n");
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

  process.stderr.write(`Unknown subcommand: ${subcommand}\nUsage:\n  approval status <action-id>\n  approval list\n`);
  process.exit(1);
}
