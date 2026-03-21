#!/usr/bin/env node

const [subcommand, ...args] = process.argv.slice(2);

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (subcommand !== "run") {
  emit({
    type: "error",
    message: "Usage: coder run [--prompt <text>]",
  });
  process.exit(1);
}

const baseUrl = process.env.THOR_SANDBOXD_URL;
if (!baseUrl) {
  emit({
    type: "error",
    message: "THOR_SANDBOXD_URL is not set",
  });
  process.exit(1);
}

let prompt;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if (arg === "--prompt") {
    prompt = args[index + 1];
    index += 1;
    continue;
  }

  if (arg.startsWith("--prompt=")) {
    prompt = arg.slice("--prompt=".length);
    continue;
  }

  emit({
    type: "error",
    message: `Unknown argument: ${arg}`,
  });
  process.exit(1);
}

if (!prompt) {
  prompt = await readStdin();
}

if (!prompt || !prompt.trim()) {
  emit({
    type: "error",
    message: "coder run requires --prompt or stdin",
  });
  process.exit(1);
}

try {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/coder/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: process.cwd(),
      prompt,
    }),
  });

  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/x-ndjson")) {
    const exitCode = await streamNdjson(response);
    process.exit(exitCode);
  }

  if (contentType.includes("application/json")) {
    const body = await response.json();
    emit(body);
    process.exit(response.ok ? 0 : 1);
  }

  emit({
    type: "error",
    message: `Unexpected response: HTTP ${response.status}`,
    body: await response.text(),
  });
  process.exit(1);
} catch (error) {
  emit({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))).toString("utf8");
}

async function streamNdjson(response) {
  // Default to failure — only a terminal "result" event overrides to success.
  // This ensures truncated streams (sandboxd crash, network drop) fail closed.
  let exitCode = response.ok ? 1 : 1;
  let sawTerminalEvent = false;
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) {
        continue;
      }

      process.stdout.write(`${line}\n`);
      const updated = updateExitCode(exitCode, line);
      if (updated !== exitCode || isTerminalEvent(line)) {
        sawTerminalEvent = true;
      }
      exitCode = updated;
    }
  }

  if (buffer.trim()) {
    process.stdout.write(`${buffer}\n`);
    const updated = updateExitCode(exitCode, buffer);
    if (updated !== exitCode || isTerminalEvent(buffer)) {
      sawTerminalEvent = true;
    }
    exitCode = updated;
  }

  // If no result/error event arrived, the stream was truncated
  if (!sawTerminalEvent) {
    process.stderr.write("coder: stream ended without a terminal event\n");
    return 1;
  }

  return exitCode;
}

function isTerminalEvent(line) {
  try {
    const event = JSON.parse(line);
    return event.type === "result" || event.type === "error";
  } catch {
    return false;
  }
}

function updateExitCode(currentExitCode, line) {
  try {
    const event = JSON.parse(line);

    if (event.type === "result") {
      return typeof event.exitCode === "number" ? event.exitCode : currentExitCode;
    }

    if (event.type === "error") {
      return 1;
    }
  } catch {
    return 1;
  }

  return currentExitCode;
}
