/**
 * SandboxProvider interface and Daytona implementation.
 *
 * The interface enables mocking in tests and swapping providers without
 * touching the manager or sync logic. See plan decision D6.
 *
 * Sync (syncIn/syncOut) is a provider concern — each implementation syncs
 * however it wants. Daytona uses rsync over SSH (D27, D32).
 */

import { execFile } from "node:child_process";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { createLogger, logInfo, logWarn, logError } from "@thor/common";

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
  /** Last N lines of non-JSON output (stderr, stacktraces). Empty if agent completed normally. */
  stderrTail?: string;
}

export interface SyncOutResult {
  filesChanged: number;
  filesDeleted: number;
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

  executeCommand(
    sandboxId: string,
    command: string,
    cwd?: string,
  ): Promise<{ exitCode: number; result: string }>;

  /** Sync worktree files into the sandbox. Implementation-specific (D32). */
  syncIn(sandboxId: string, worktreePath: string): Promise<void>;

  /** Sync sandbox files back to the worktree. Implementation-specific (D32). */
  syncOut(sandboxId: string, worktreePath: string): Promise<SyncOutResult>;

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

const SANDBOX_WORKDIR = "/home/daytona/src";

/** SSH credentials for rsync, cached per sandbox. */
interface SshCredentials {
  token: string;
  host: string;
  expiresAt: Date;
}

export class DaytonaSandboxProvider implements SandboxProvider {
  private client: Daytona;
  /** Cache sandbox instances to avoid repeated API calls within a session. */
  private sandboxCache = new Map<string, Sandbox>();
  /** SSH credentials per sandbox for rsync (D30). */
  private sshCache = new Map<string, SshCredentials>();
  /** Track which sandboxes have had their first sync (need git init). */
  private syncedSandboxes = new Set<string>();

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

  async executeCommand(
    sandboxId: string,
    command: string,
    cwd?: string,
  ): Promise<{ exitCode: number; result: string }> {
    const sandbox = await this.getSandbox(sandboxId);
    const result = await sandbox.process.executeCommand(command, cwd);
    return { exitCode: result.exitCode, result: result.result };
  }

  // ── Sync via rsync over SSH (D27, D32) ────────────────────────────────────

  async syncIn(sandboxId: string, worktreePath: string): Promise<void> {
    logInfo(log, "sync_in", { sandboxId, worktreePath });
    const isFirstSync = !this.syncedSandboxes.has(sandboxId);

    // Ensure target directory exists before rsync
    if (isFirstSync) {
      await this.executeCommand(sandboxId, `mkdir -p ${SANDBOX_WORKDIR}`);
    }

    const ssh = await this.getSshCredentials(sandboxId);
    await this.rsync(worktreePath + "/", `${ssh.token}@${ssh.host}:${SANDBOX_WORKDIR}/`, [
      "--filter=:- .gitignore",
      "--exclude",
      ".git",
    ]);

    // First sync: init a standalone git repo so the agent has one to work with (D31)
    if (isFirstSync) {
      const { exitCode, result } = await this.executeCommand(
        sandboxId,
        `cd ${SANDBOX_WORKDIR} && git init && git add -A && git commit -m sync --allow-empty 2>&1`,
      );
      if (exitCode !== 0) {
        throw new Error(`git init failed in sandbox ${sandboxId} (exit ${exitCode}): ${result}`);
      }
      this.syncedSandboxes.add(sandboxId);
    }

    logInfo(log, "sync_in_done", { sandboxId, firstSync: isFirstSync });
  }

  async syncOut(sandboxId: string, worktreePath: string): Promise<SyncOutResult> {
    logInfo(log, "sync_out", { sandboxId, worktreePath });

    // Count files before sync to compute delta
    const { result: beforeOutput } = await this.executeCommand(
      sandboxId,
      `cd ${SANDBOX_WORKDIR} && git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null`,
    );
    const { result: statusOutput } = await this.executeCommand(
      sandboxId,
      `cd ${SANDBOX_WORKDIR} && git status --porcelain 2>/dev/null`,
    );

    const changedFiles = beforeOutput.split("\n").filter((f) => f.trim().length > 0);
    const deletedFiles = statusOutput
      .split("\n")
      .filter((line) => /^\s*D\s/.test(line) || /^D\s/.test(line))
      .map((line) => line.slice(3).trim())
      .filter((f) => f.length > 0);

    const ssh = await this.getSshCredentials(sandboxId);
    await this.rsync(`${ssh.token}@${ssh.host}:${SANDBOX_WORKDIR}/`, worktreePath + "/", [
      "--exclude",
      ".git",
    ]);

    const filesChanged = changedFiles.filter((f) => !deletedFiles.includes(f)).length;
    logInfo(log, "sync_out_done", { sandboxId, filesChanged, filesDeleted: deletedFiles.length });
    return { filesChanged, filesDeleted: deletedFiles.length };
  }

  /** Get or refresh SSH credentials for rsync (D30). */
  private async getSshCredentials(sandboxId: string): Promise<SshCredentials> {
    const cached = this.sshCache.get(sandboxId);
    // Refresh if missing or expiring within 5 minutes
    if (cached && cached.expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
      return cached;
    }

    const sandbox = await this.getSandbox(sandboxId);
    const sshAccess = await sandbox.createSshAccess(60);

    // Parse host from sshCommand (e.g. "ssh <token>@ssh.app.daytona.io") (D33)
    const match = sshAccess.sshCommand.match(/@(.+)$/);
    if (!match) {
      throw new Error(`Could not parse SSH host from sshCommand: ${sshAccess.sshCommand}`);
    }

    const creds: SshCredentials = {
      token: sshAccess.token,
      host: match[1],
      expiresAt: new Date(sshAccess.expiresAt),
    };
    this.sshCache.set(sandboxId, creds);
    logInfo(log, "ssh_credentials_created", { sandboxId, host: creds.host });
    return creds;
  }

  /** Run rsync between local and remote paths. */
  private rsync(src: string, dst: string, extraArgs: string[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        "-azq",
        "--delete",
        "-e",
        "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR",
        ...extraArgs,
        src,
        dst,
      ];
      logInfo(log, "rsync_start", {
        src: src.replace(/[^@]*@/, "<token>@"),
        dst: dst.replace(/[^@]*@/, "<token>@"),
      });
      execFile("rsync", args, { timeout: 300_000 }, (err, _stdout, stderr) => {
        if (err) {
          logError(log, "rsync_failed", { stderr, code: err.code });
          return reject(new Error(`rsync failed: ${stderr || err.message}`));
        }
        resolve();
      });
    });
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
    /** Capture non-JSON output (stderr, stacktraces, INFO lines) for diagnostics. */
    const stderrLines: string[] = [];
    /** Track last data timestamp to detect early process exit. */
    let lastDataAt = Date.now();
    /** Whether we've seen a shell prompt after our command (indicates process exited). */
    let shellPromptAfterStart = false;
    let commandSent = false;

    logInfo(log, "agent_pty_start", { sandboxId, ptyId, command });

    const pty = await sandbox.process.createPty({
      id: ptyId,
      cwd,
      cols: 200,
      rows: 50,
      onData: (data) => {
        const text = new TextDecoder().decode(data);
        buffer += text;
        lastDataAt = Date.now();

        // Extract complete lines and parse JSON
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep incomplete last line in buffer

        for (const rawLine of lines) {
          const clean = stripAnsi(rawLine).trim();
          if (!clean) continue;

          // Detect shell prompt returning after command was sent (process crashed/exited)
          if (commandSent && /^\$\s*$|^bash-.*\$|^daytona@/.test(clean)) {
            shellPromptAfterStart = true;
            continue;
          }

          if (!clean.startsWith("{")) {
            // Non-JSON: log as stderr (INFO lines, errors, stacktraces)
            stderrLines.push(clean);
            logWarn(log, "agent_pty_stderr", { sandboxId, ptyId, line: clean });
            continue;
          }

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
            // Looks like JSON but isn't — treat as stderr
            stderrLines.push(clean);
            logWarn(log, "agent_pty_stderr", { sandboxId, ptyId, line: clean });
          }
        }
      },
    });

    await pty.waitForConnection();

    // Send the command
    await pty.sendInput(`${command}\n`);
    commandSent = true;

    // Poll for completion — PTY stays open as a shell, so we detect via step_finish
    const startTime = Date.now();
    const TIMEOUT_MS = 3600_000; // 1 hour max
    const POLL_MS = 500;
    const IDLE_CRASH_MS = 10_000; // if no output for 10s after shell prompt, assume crash

    while (!done && Date.now() - startTime < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));

      // Detect early exit: shell prompt returned and no new data for IDLE_CRASH_MS
      if (shellPromptAfterStart && Date.now() - lastDataAt > IDLE_CRASH_MS) {
        logWarn(log, "agent_pty_early_exit", {
          sandboxId,
          ptyId,
          stderr: stderrLines.slice(-20).join("\n"),
        });
        break;
      }
    }

    // Give a brief moment for any trailing output to arrive
    await new Promise((r) => setTimeout(r, 200));

    // Kill the PTY shell
    await pty.kill();
    const result = await pty.wait();

    const timedOut = !done && !shellPromptAfterStart;
    const crashed = !done && shellPromptAfterStart;

    logInfo(log, "agent_pty_done", {
      sandboxId,
      ptyId,
      opencodeSessionId,
      timedOut,
      crashed,
      durationMs: Date.now() - startTime,
      stderrTail: stderrLines.slice(-10).join("\n"),
    });

    return {
      exitCode: done ? 0 : crashed ? 1 : 124, // 0=ok, 1=crash, 124=timeout
      opencodeSessionId,
      stderrTail: stderrLines.length > 0 ? stderrLines.slice(-20).join("\n") : undefined,
    };
  }
}

/** Strip ANSI escape sequences from PTY output. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\].*?\x07|\x1b\(B/g, "");
}
