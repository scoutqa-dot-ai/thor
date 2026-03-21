import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import {
  createDaytonaSandboxProvider,
  ensureSandboxForWorktree,
  getRemoteWorkspaceDir,
  type EnsureSandboxResult,
  type SandboxExecEvent,
  type SandboxExportResult,
} from "@thor/common";
import { z } from "zod/v4";

import {
  HOSTED_CODER_AGENT_NAME,
  HOSTED_CODER_CONFIG,
  HOSTED_CODER_PROMPT,
} from "./hosted-coder-prompt.js";
import { resolveWorktreeContext } from "./worktree.js";

const DEFAULT_AUTH_PATH = process.env.OPENCODE_AUTH_PATH;
const DEFAULT_DAYTONA_SNAPSHOT = process.env.SANDBOXD_DAYTONA_SNAPSHOT || "daytona-medium";
const DEFAULT_AUTOSTOP_MINUTES = parseInteger(process.env.SANDBOXD_AUTO_STOP_MINUTES, 30);
const DEFAULT_NETWORK_BLOCK_ALL = parseBoolean(process.env.SANDBOXD_NETWORK_BLOCK_ALL, false);

export const CoderRunRequestSchema = z.object({
  cwd: z.string().min(1),
  prompt: z.string().min(1),
});

export type CoderRunRequest = z.infer<typeof CoderRunRequestSchema>;

type WriteEvent = (event: Record<string, unknown>) => void;

export async function runHostedCoder(
  request: CoderRunRequest,
  writeEvent: WriteEvent,
): Promise<number> {
  const context = resolveWorktreeContext(request.cwd);
  writeEvent({
    type: "status",
    phase: "resolve_worktree",
    cwd: context.cwd,
    worktreePath: context.worktreePath,
    focusPath: context.focusPath,
    repo: context.repo,
    branch: context.branch,
  });

  const provider = createDaytonaSandboxProvider({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET,
    snapshot: DEFAULT_DAYTONA_SNAPSHOT,
    autoStopIntervalMinutes: DEFAULT_AUTOSTOP_MINUTES,
    networkBlockAll: DEFAULT_NETWORK_BLOCK_ALL,
  });

  let ensured: EnsureSandboxResult | undefined;
  let exportResult: SandboxExportResult | undefined;

  try {
    writeEvent({ type: "status", phase: "ensure_sandbox" });
    ensured = await ensureSandboxForWorktree(
      provider,
      {
        worktreePath: context.worktreePath,
        repo: context.repo,
        branch: context.branch,
      },
      { materialize: "always" },
    );

    writeEvent({
      type: "status",
      phase: "sandbox_ready",
      sandboxId: ensured.record.sandboxId,
      action: ensured.action,
      materialized: ensured.materialized,
    });

    writeEvent({ type: "status", phase: "bootstrap_opencode" });
    const authJson = await readOptionalFile(DEFAULT_AUTH_PATH);
    const bootstrapResult = await execWithStreaming(
      provider,
      ensured.record.sandboxId,
      {
        command: buildBootstrapCommand(authJson),
      },
      "bootstrap_exec",
      writeEvent,
    );

    if (bootstrapResult.exitCode !== 0) {
      throw new Error(`sandbox bootstrap failed with exit code ${bootstrapResult.exitCode}`);
    }

    writeEvent({ type: "status", phase: "run_hosted_coder" });
    const remoteWorkspaceDir = getRemoteWorkspaceDir(context.worktreePath);
    const opencodeResult = await execWithStreaming(
      provider,
      ensured.record.sandboxId,
      {
        command: buildOpencodeRunCommand(
          buildDelegatedPrompt(request.prompt, context.focusPath),
          remoteWorkspaceDir,
        ),
      },
      "run_exec",
      writeEvent,
      { parseJsonStdout: true },
    );

    writeEvent({ type: "status", phase: "export_workspace" });
    exportResult = await provider.exportWorkspace(ensured.record.sandboxId, context.worktreePath);
    writeEvent({
      type: "result",
      status: opencodeResult.exitCode === 0 ? "completed" : "failed",
      exitCode: opencodeResult.exitCode,
      sandboxId: ensured.record.sandboxId,
      sandboxAction: ensured.action,
      filesChanged: exportResult.filesChanged,
      filesDeleted: exportResult.filesDeleted,
      artifactPaths: exportResult.artifactPaths,
    });
    return opencodeResult.exitCode;
  } catch (error) {
    if (ensured && !exportResult) {
      exportResult = await safeExport(provider, ensured.record.sandboxId, context.worktreePath);
    }

    writeEvent({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      sandboxId: ensured?.record.sandboxId,
      sandboxAction: ensured?.action,
      filesChanged: exportResult?.filesChanged,
      filesDeleted: exportResult?.filesDeleted,
      artifactPaths: exportResult?.artifactPaths,
    });
    return 1;
  }
}

function buildBootstrapCommand(authJson?: string): string {
  const lines = [
    ...buildRemoteEnvironmentSetup(),
    writeFileCommand('"$XDG_CONFIG_HOME/opencode/opencode.json"', HOSTED_CODER_CONFIG),
    writeFileCommand(
      `"$XDG_CONFIG_HOME/opencode/agents/${HOSTED_CODER_AGENT_NAME}.md"`,
      HOSTED_CODER_PROMPT,
    ),
    'if ! command -v git >/dev/null 2>&1; then echo "git is required in the Daytona snapshot" >&2; exit 1; fi',
    'if ! command -v opencode >/dev/null 2>&1; then echo "opencode is required in the Daytona snapshot" >&2; exit 1; fi',
    "opencode --version",
  ];

  if (authJson) {
    // Insert after env setup + config writes so XDG_DATA_HOME is already set
    const insertIndex = lines.indexOf(
      'if ! command -v git >/dev/null 2>&1; then echo "git is required in the Daytona snapshot" >&2; exit 1; fi',
    );
    lines.splice(insertIndex, 0, writeFileCommand('"$XDG_DATA_HOME/opencode/auth.json"', authJson));
  }

  return lines.join("\n");
}

function buildOpencodeRunCommand(prompt: string, remoteWorkspaceDir: string): string {
  return [
    ...buildRemoteEnvironmentSetup(),
    `cd ${shellQuote(remoteWorkspaceDir)}`,
    ...buildSyntheticGitBootstrap(),
    writeFileCommand(shellQuote("/tmp/thor-hosted-coder-prompt.txt"), prompt),
    [
      "opencode run",
      "--format json",
      "--print-logs",
      "--log-level INFO",
      `--agent ${shellQuote(HOSTED_CODER_AGENT_NAME)}`,
      '"$(cat /tmp/thor-hosted-coder-prompt.txt)"',
    ].join(" "),
  ].join("\n");
}

function buildRemoteEnvironmentSetup(): string[] {
  return [
    "set -euo pipefail",
    'export HOME="${HOME:-/home/daytona}"',
    'export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"',
    'export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"',
    'export PATH="/usr/local/share/nvm/current/bin:$HOME/.local/bin:$PATH"',
    "export OPENCODE_DISABLE_DEFAULT_PLUGINS=1",
    'mkdir -p "$XDG_CONFIG_HOME/opencode/agents" "$XDG_DATA_HOME/opencode"',
  ];
}

function buildSyntheticGitBootstrap(): string[] {
  return [
    "if [ ! -d .git ]; then",
    "  git init -q;",
    `  git config user.name ${shellQuote("Thor")};`,
    `  git config user.email ${shellQuote("thor@localhost")};`,
    "  git add -A;",
    "  if ! git diff --cached --quiet --ignore-submodules --; then",
    `    git commit -qm ${shellQuote("sandbox bootstrap")};`,
    "  fi;",
    "fi",
  ];
}

function buildDelegatedPrompt(prompt: string, focusPath?: string): string {
  if (!focusPath) {
    return prompt;
  }

  return [
    `Primary focus directory relative to the worktree root: ${focusPath}`,
    "If the task mentions bare filenames, prefer that directory unless the prompt specifies another path.",
    "",
    "Task:",
    prompt,
  ].join("\n");
}

async function execWithStreaming(
  provider: ReturnType<typeof createDaytonaSandboxProvider>,
  sandboxId: string,
  request: { command: string },
  phase: string,
  writeEvent: WriteEvent,
  options: { parseJsonStdout?: boolean } = {},
): Promise<{ exitCode: number }> {
  const stdoutBuffer = createLineBuffer((line) =>
    forwardExecLine(line, phase, "stdout", writeEvent, options),
  );
  const stderrBuffer = createLineBuffer((line) =>
    forwardExecLine(line, phase, "stderr", writeEvent, options),
  );

  try {
    return await provider.exec(sandboxId, request, (event) => {
      forwardExecEvent(event, phase, writeEvent, stdoutBuffer, stderrBuffer);
    });
  } finally {
    stdoutBuffer.flush();
    stderrBuffer.flush();
  }
}

function forwardExecEvent(
  event: SandboxExecEvent,
  phase: string,
  writeEvent: WriteEvent,
  stdoutBuffer: LineBuffer,
  stderrBuffer: LineBuffer,
): void {
  if (event.type === "status") {
    writeEvent({
      type: "status",
      phase,
      status: event.data,
    });
    return;
  }

  if (event.type === "stdout") {
    stdoutBuffer.push(event.data);
    return;
  }

  stderrBuffer.push(event.data);
}

function forwardExecLine(
  line: string,
  phase: string,
  stream: "stdout" | "stderr",
  writeEvent: WriteEvent,
  options: { parseJsonStdout?: boolean } = {},
): void {
  if (!line.trim()) {
    return;
  }

  if (stream === "stdout" && options.parseJsonStdout) {
    try {
      writeEvent({ type: "opencode", event: JSON.parse(line) });
      return;
    } catch {
      // fall through to raw log event
    }
  }

  writeEvent({
    type: "log",
    phase,
    stream,
    data: line,
  });
}

interface LineBuffer {
  push(chunk: string): void;
  flush(): void;
}

function createLineBuffer(onLine: (line: string) => void): LineBuffer {
  let buffer = "";

  return {
    push(chunk) {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        onLine(part);
      }
    },
    flush() {
      if (!buffer) {
        return;
      }

      onLine(buffer);
      buffer = "";
    },
  };
}

function writeFileCommand(shellPath: string, content: string): string {
  const marker = heredocMarker(shellPath, content);
  const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
  return `cat > ${shellPath} <<'${marker}'\n${normalizedContent}${marker}`;
}

function heredocMarker(shellPath: string, content: string): string {
  return `THOR_EOF_${createHash("sha1").update(`${shellPath}\n${content}`).digest("hex").slice(0, 16)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function safeExport(
  provider: ReturnType<typeof createDaytonaSandboxProvider>,
  sandboxId: string,
  worktreePath: string,
): Promise<SandboxExportResult | undefined> {
  try {
    return await provider.exportWorkspace(sandboxId, worktreePath);
  } catch {
    return undefined;
  }
}

async function readOptionalFile(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }

  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
