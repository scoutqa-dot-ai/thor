/**
 * SandboxProvider interface and Daytona implementation.
 *
 * The interface enables mocking in tests and swapping providers without
 * touching the manager or sync logic. See plan decision D6.
 */

import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { createLogger, logInfo } from "@thor/common";

const log = createLogger("sandbox-provider");

/** Base image for creating snapshots — should have Node.js + opencode + git pre-installed. */
const SNAPSHOT_BASE_IMAGE = process.env.SANDBOX_SNAPSHOT_IMAGE || "node:22-slim";

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

  /** Create a named snapshot from an existing sandbox (for warm starts). */
  createSnapshot(sandboxId: string, name: string): Promise<string>;

  /** Check if a snapshot exists by name. */
  getSnapshot(name: string): Promise<string | null>;

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
}

// ── Daytona implementation ──────────────────────────────────────────────────

export class DaytonaSandboxProvider implements SandboxProvider {
  private client: Daytona;
  /** Cache sandbox instances to avoid repeated API calls within a session. */
  private sandboxCache = new Map<string, Sandbox>();

  constructor(config?: { apiKey?: string; apiUrl?: string; target?: string }) {
    this.client = new Daytona(config);
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
    const createOpts: Record<string, unknown> = {
      labels: opts.labels,
      envVars: opts.envVars,
      autoStopInterval: opts.autoStopInterval ?? 3600, // 1h default (D13)
    };
    if (opts.snapshot) {
      createOpts.snapshot = opts.snapshot;
    } else {
      createOpts.image = opts.image || "node:22-slim";
    }
    const sandbox = await this.client.create(createOpts);
    this.sandboxCache.set(sandbox.id, sandbox);
    return sandbox.id;
  }

  async createSnapshot(_sandboxId: string, name: string): Promise<string> {
    logInfo(log, "snapshot_create", { name, image: SNAPSHOT_BASE_IMAGE });
    await this.client.snapshot.create({ name, image: SNAPSHOT_BASE_IMAGE });
    return name;
  }

  async getSnapshot(name: string): Promise<string | null> {
    try {
      const snapshot = await this.client.snapshot.get(name);
      return snapshot?.name ?? null;
    } catch {
      return null;
    }
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
}
