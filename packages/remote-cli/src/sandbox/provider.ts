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

export interface SessionExecResult {
  commandId: string;
  exitCode?: number;
  output?: string;
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

  createSession(sandboxId: string, sessionId: string): Promise<void>;

  execSessionCommand(
    sandboxId: string,
    sessionId: string,
    command: string,
  ): Promise<SessionExecResult>;

  getSessionCommandLogs(
    sandboxId: string,
    sessionId: string,
    commandId: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<void>;

  uploadFile(sandboxId: string, remotePath: string, data: Buffer): Promise<void>;

  downloadFile(sandboxId: string, remotePath: string): Promise<Buffer>;

  executeCommand(
    sandboxId: string,
    command: string,
    cwd?: string,
  ): Promise<{ exitCode: number; result: string }>;

  /** Get the exit code of a completed session command. */
  getSessionCommandExitCode(
    sandboxId: string,
    sessionId: string,
    commandId: string,
  ): Promise<number | undefined>;
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

  async createSession(sandboxId: string, sessionId: string): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    await sandbox.process.createSession(sessionId);
  }

  async execSessionCommand(
    sandboxId: string,
    sessionId: string,
    command: string,
  ): Promise<SessionExecResult> {
    const sandbox = await this.getSandbox(sandboxId);
    const result = await sandbox.process.executeSessionCommand(sessionId, {
      command,
      async: true, // run asynchronously so we can stream logs
    });
    return {
      commandId: result.cmdId,
      exitCode: result.exitCode,
      output: result.output ?? result.stdout,
    };
  }

  async getSessionCommandLogs(
    sandboxId: string,
    sessionId: string,
    commandId: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);
    await sandbox.process.getSessionCommandLogs(sessionId, commandId, onStdout, onStderr);
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

  async getSessionCommandExitCode(
    sandboxId: string,
    sessionId: string,
    commandId: string,
  ): Promise<number | undefined> {
    const sandbox = await this.getSandbox(sandboxId);
    const cmd = await sandbox.process.getSessionCommand(sessionId, commandId);
    return cmd.exitCode;
  }
}
