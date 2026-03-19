/**
 * SandboxProvider interface and Daytona implementation.
 *
 * The interface enables mocking in tests and swapping providers without
 * touching the manager or sync logic. See plan decision D6.
 */

import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { createLogger, logInfo } from "@thor/common";

const log = createLogger("sandbox-provider");

// ── Provider interface ──────────────────────────────────────────────────────

export interface SandboxInfo {
  id: string;
  labels: Record<string, string>;
}

export interface AgentStreamResult {
  exitCode: number;
  /** OpenCode session ID extracted from JSON output (for --session continuity). */
  opencodeSessionId?: string;
}

export interface SandboxProvider {
  create(opts: {
    image?: string;
    snapshot?: string;
    labels: Record<string, string>;
    envVars?: Record<string, string>;
    autoStopInterval?: number;
  }): Promise<string>;

  destroy(sandboxId: string): Promise<void>;

  list(labels: Record<string, string>): Promise<SandboxInfo[]>;

  uploadFile(sandboxId: string, remotePath: string, data: Buffer): Promise<void>;

  downloadFile(sandboxId: string, remotePath: string): Promise<Buffer>;

  executeCommand(
    sandboxId: string,
    command: string,
    cwd?: string,
  ): Promise<{ exitCode: number; result: string }>;

  /**
   * Run an agent command via PTY with real-time streaming.
   * Uses createPty for streaming output, detects completion via step_finish event.
   */
  runAgentStreaming(
    sandboxId: string,
    command: string,
    cwd: string,
    onData: (jsonLine: string) => void,
  ): Promise<AgentStreamResult>;
}

// ── Daytona implementation ──────────────────────────────────────────────────

export class DaytonaSandboxProvider implements SandboxProvider {
  private client: Daytona;
  /** Cache sandbox instances to avoid repeated API calls within a session. */
  private sandboxCache = new Map<string, Sandbox>();

  constructor(apiKey: string) {
    this.client = new Daytona({ apiKey });
  }

  private async getSandbox(sandboxId: string): Promise<Sandbox> {
    let sandbox = this.sandboxCache.get(sandboxId);
    if (!sandbox) {
      sandbox = await this.client.get(sandboxId);
      this.sandboxCache.set(sandboxId, sandbox);
    }
    return sandbox;
  }

  async create(opts: {
    image?: string;
    snapshot?: string;
    labels: Record<string, string>;
    envVars?: Record<string, string>;
    autoStopInterval?: number;
  }): Promise<string> {
    logInfo(log, "sandbox_create", { labels: opts.labels, snapshot: opts.snapshot });
    const sandbox = await this.client.create({
      ...(opts.snapshot ? { snapshot: opts.snapshot } : { image: opts.image || "node:22-slim" }),
      labels: opts.labels,
      envVars: opts.envVars,
      autoStopInterval: opts.autoStopInterval ?? 3600, // 1h default (D13)
    });
    this.sandboxCache.set(sandbox.id, sandbox);
    return sandbox.id;
  }

  async destroy(sandboxId: string): Promise<void> {
    logInfo(log, "sandbox_destroy", { sandboxId });
    const sandbox = await this.getSandbox(sandboxId);
    await this.client.delete(sandbox);
    this.sandboxCache.delete(sandboxId);
  }

  async list(labels: Record<string, string>): Promise<SandboxInfo[]> {
    const result = await this.client.list(labels);
    return result.items.map((s) => ({ id: s.id, labels: s.labels }));
  }

  async uploadFile(sandboxId: string, remotePath: string, data: Buffer): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    await sandbox.fs.uploadFile(data, remotePath);
  }

  async downloadFile(sandboxId: string, remotePath: string): Promise<Buffer> {
    const sandbox = await this.getSandbox(sandboxId);
    return sandbox.fs.downloadFile(remotePath);
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    cwd?: string,
  ): Promise<{ exitCode: number; result: string }> {
    const sandbox = await this.getSandbox(sandboxId);
    const result = await sandbox.process.executeCommand(command, cwd);
    return { exitCode: result.exitCode, result: result.result };
  }

  async runAgentStreaming(
    sandboxId: string,
    command: string,
    cwd: string,
    onData: (jsonLine: string) => void,
  ): Promise<AgentStreamResult> {
    const sandbox = await this.getSandbox(sandboxId);
    const ptyId = `agent-${Date.now()}`;

    let opencodeSessionId: string | undefined;
    let buffer = "";
    let done = false;

    logInfo(log, "agent_pty_start", { sandboxId, ptyId, command });

    const pty = await sandbox.process.createPty({
      id: ptyId,
      cwd,
      cols: 200,
      rows: 50,
      onData: (data) => {
        const text = new TextDecoder().decode(data);
        buffer += text;

        // Extract complete lines and parse JSON
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep incomplete last line in buffer

        for (const rawLine of lines) {
          const clean = stripAnsi(rawLine).trim();
          if (!clean || !clean.startsWith("{")) continue;

          try {
            const parsed = JSON.parse(clean);
            onData(clean);

            // Extract opencode session ID from first event
            if (!opencodeSessionId && parsed.sessionID) {
              opencodeSessionId = parsed.sessionID;
            }

            // Detect agent completion
            if (parsed.type === "step_finish") {
              done = true;
            }
          } catch {
            // Not valid JSON — skip (shell prompts, INFO lines, etc.)
          }
        }
      },
    });

    await pty.waitForConnection();

    // Send the command
    await pty.sendInput(`${command}\n`);

    // Poll for completion — PTY stays open as a shell, so we detect via step_finish
    const startTime = Date.now();
    const TIMEOUT_MS = 3600_000; // 1 hour max
    const POLL_MS = 500;

    while (!done && Date.now() - startTime < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    // Give a brief moment for any trailing output to arrive
    await new Promise((r) => setTimeout(r, 200));

    // Kill the PTY shell
    await pty.kill();
    const result = await pty.wait();

    logInfo(log, "agent_pty_done", {
      sandboxId,
      ptyId,
      opencodeSessionId,
      timedOut: !done,
      durationMs: Date.now() - startTime,
    });

    return {
      exitCode: done ? 0 : 124, // 124 = timeout convention
      opencodeSessionId,
    };
  }
}

/** Strip ANSI escape sequences from PTY output. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\].*?\x07|\x1b\(B/g, "");
}
