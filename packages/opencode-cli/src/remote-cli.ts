/**
 * Shared HTTP client for remote-cli wrapper scripts.
 *
 * Usage: node remote-cli.mjs <endpoint> [args...]
 *
 * Env:
 *   THOR_REMOTE_CLI_URL — base URL of the remote-cli service
 */

import { ExecResultSchema, ExecStreamEventSchema, type ExecStreamEvent } from "@thor/common";
import { fileURLToPath } from "node:url";

export const GH_BODY_STDIN_ERROR = `gh body must be piped via stdin. Use --body-file - fed by a quoted heredoc, e.g.:
  gh pr create --title "..." --body-file - <<'EOF'
  ...markdown body...
  EOF
Use the quoted delimiter <<'EOF' (NOT <<EOF) so backticks and $() are not interpolated.
Do not embed prose in shell arguments.
`;

function hasGhStdinBody(args: string[]): boolean {
  return args.some((arg, index) => {
    if (arg === "--body-file") return args[index + 1] === "-";
    return arg === "--body-file=-";
  });
}

function isGhProseWriteCommand(args: string[]): boolean {
  return (
    (args[0] === "pr" && ["create", "comment", "review"].includes(args[1] ?? "")) ||
    (args[0] === "issue" && ["create", "comment"].includes(args[1] ?? ""))
  );
}

export function validateGhBodyTransport(args: string[]): string | null {
  const proseWrite = isGhProseWriteCommand(args);
  const ghApi = args[0] === "api";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (
      arg === "--body" ||
      arg === "-b" ||
      arg.startsWith("--body=") ||
      arg.startsWith("-b=") ||
      (proseWrite && /^-b.+/.test(arg))
    ) {
      return GH_BODY_STDIN_ERROR;
    }
    if (arg === "--body-file") {
      if (args[i + 1] !== "-") return GH_BODY_STDIN_ERROR;
      i += 1;
      continue;
    }
    if (arg.startsWith("--body-file=") && arg !== "--body-file=-") return GH_BODY_STDIN_ERROR;
    if (proseWrite && arg === "-F") return GH_BODY_STDIN_ERROR;
    if (ghApi && (arg === "-f" || arg === "-F") && args[i + 1]?.startsWith("body=")) {
      return GH_BODY_STDIN_ERROR;
    }
    if (
      ghApi &&
      (arg.startsWith("-fbody=") || arg.startsWith("-Fbody=")) &&
      arg.length > 7
    ) {
      return GH_BODY_STDIN_ERROR;
    }
    if (ghApi && (arg.startsWith("--raw-field=body=") || arg.startsWith("--field=body="))) {
      return GH_BODY_STDIN_ERROR;
    }
    if (
      ghApi &&
      (arg === "--raw-field" || arg === "--field") &&
      args[i + 1]?.startsWith("body=")
    ) {
      return GH_BODY_STDIN_ERROR;
    }
  }
  return null;
}

async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runRemoteCli(options: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: NodeJS.ReadableStream;
  fetchImpl: typeof fetch;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  exit: (code: number) => never;
}): Promise<void> {
  const { argv, env, cwd, stdin, fetchImpl, stdout, stderr, exit } = options;
  const [endpoint, ...args] = argv;

  if (!endpoint) {
    stderr.write("Usage: remote-cli.mjs <endpoint> [args...]\n");
    exit(1);
  }

  const baseUrl = env.THOR_REMOTE_CLI_URL;
  if (!baseUrl) {
    stderr.write("THOR_REMOTE_CLI_URL is not set\n");
    exit(1);
  }

  if (endpoint === "gh") {
    const ghBodyError = validateGhBodyTransport(args);
    if (ghBodyError) {
      stderr.write(ghBodyError);
      exit(1);
    }
  }

  const url = `${baseUrl}/exec/${endpoint}`;
  const sessionId = env.THOR_OPENCODE_SESSION_ID || "";
  const callId = env.THOR_OPENCODE_CALL_ID || "";
  const body: Record<string, unknown> = { args, cwd };

  if (endpoint === "slack-post-message" || (endpoint === "gh" && hasGhStdinBody(args))) {
    body.stdin = await readStdin(stdin);
  }

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sessionId && { "x-thor-session-id": sessionId }),
        ...(callId && { "x-thor-call-id": callId }),
      },
      body: JSON.stringify(body),
    });

    const contentType = res.headers.get("content-type") || "";

    // NDJSON streaming response (scoutqa)
    if (contentType.includes("application/x-ndjson")) {
      let exitCode = 1;
      const decoder = new TextDecoder();
      let buffer = "";

      const handleEvent = (msg: ExecStreamEvent) => {
        switch (msg.type) {
          case "stdout":
            stdout.write(msg.data);
            break;
          case "stderr":
            stderr.write(msg.data);
            break;
          case "exit":
            exitCode = msg.exitCode;
            break;
          case "heartbeat":
            break;
        }
      };

      for await (const chunk of res.body!) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!; // keep incomplete line in buffer
        for (const line of lines) {
          if (!line) continue;
          handleEvent(ExecStreamEventSchema.parse(JSON.parse(line)));
        }
      }
      // flush remaining buffer
      if (buffer.trim()) {
        handleEvent(ExecStreamEventSchema.parse(JSON.parse(buffer)));
      }
      exit(exitCode);
    }

    // Buffered JSON response (git/gh)
    if (!res.ok && contentType.includes("application/json")) {
      const result = ExecResultSchema.parse(await res.json());
      if (result.stderr) stderr.write(result.stderr);
      if (result.stdout) stdout.write(result.stdout);
      exit(result.exitCode ?? 1);
    }

    if (!res.ok) {
      stderr.write(`HTTP ${res.status}: ${await res.text()}\n`);
      exit(1);
    }

    const result = ExecResultSchema.parse(await res.json());
    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);

    exit(result.exitCode ?? 0);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("exit ")) throw err;
    stderr.write(`Failed to reach remote-cli: ${(err as Error).message}\n`);
    exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runRemoteCli({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stdin: process.stdin,
    fetchImpl: fetch,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code) => process.exit(code),
  });
}
