import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { basename, join, posix, resolve } from "node:path";
import { promisify } from "node:util";

import { Daytona } from "@daytonaio/sdk";

import type {
  SandboxExecEvent,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxExportResult,
  SandboxIdentity,
  SandboxMaterializeRequest,
  SandboxPreview,
  SandboxProvider,
  SandboxRecord,
  SandboxStatus,
} from "./sandboxes.js";

const execFileAsync = promisify(execFile);

const MATERIALIZE_EXCLUDES = [
  ".git",
  ".context",
  "node_modules",
  "dist",
  "coverage",
  ".next",
  ".turbo",
];
const LOCAL_SYNC_EXCLUDES = new Set([".git", ".context"]);
const DEFAULT_PREVIEW_EXPIRES_IN_SECONDS = 300;
const DEFAULT_AUTOSTOP_MINUTES = 30;
const DEFAULT_NETWORK_BLOCK_ALL = true;
const DEFAULT_SANDBOX_LANGUAGE = "python";

export interface DaytonaSandboxProviderOptions {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  snapshot?: string;
  language?: string;
  autoStopIntervalMinutes?: number;
  networkBlockAll?: boolean;
  previewExpiresInSeconds?: number;
  createClient?: () => DaytonaClient;
}

interface DaytonaClient {
  list(
    labels?: Record<string, string>,
    page?: number,
    limit?: number,
  ): Promise<{ items: DaytonaSandbox[] }>;
  create(
    params?: {
      snapshot?: string;
      language?: string;
      labels?: Record<string, string>;
      public?: boolean;
      autoStopInterval?: number;
      networkBlockAll?: boolean;
    },
    options?: { timeout?: number },
  ): Promise<DaytonaSandbox>;
  get(sandboxIdOrName: string): Promise<DaytonaSandbox>;
}

interface DaytonaSandbox {
  id: string;
  labels: Record<string, string>;
  state?: string;
  errorReason?: string;
  createdAt?: string;
  updatedAt?: string;
  start(timeout?: number): Promise<void>;
  stop(timeout?: number): Promise<void>;
  delete(timeout?: number): Promise<void>;
  fs: {
    uploadFile(localPath: string, remotePath: string, timeout?: number): Promise<void>;
    downloadFile(remotePath: string, localPath: string, timeout?: number): Promise<void>;
  };
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode: number; result: string }>;
    createSession(sessionId: string): Promise<void>;
    executeSessionCommand(
      sessionId: string,
      request: { command: string; runAsync?: boolean },
      timeout?: number,
    ): Promise<{ cmdId?: string | null }>;
    getSessionCommandLogs(
      sessionId: string,
      commandId: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ): Promise<void>;
    getSessionCommand(sessionId: string, commandId: string): Promise<{ exitCode?: number | null }>;
  };
  getSignedPreviewUrl(port: number, expiresInSeconds?: number): Promise<{ url: string }>;
}

export function createDaytonaSandboxProvider(
  options: DaytonaSandboxProviderOptions = {},
): SandboxProvider {
  const createClient =
    options.createClient ??
    (() =>
      new Daytona({
        apiKey: options.apiKey ?? process.env.DAYTONA_API_KEY,
        ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
        ...(options.target ? { target: options.target } : {}),
      }) as DaytonaClient);

  return {
    providerName: "daytona",
    async findByWorktree(identity) {
      const client = createClient();
      const result = await client.list(
        { "thor-worktree-id": getSandboxWorktreeId(identity.worktreePath) },
        1,
        10,
      );
      if (result.items.length > 1) {
        throw new Error(
          `Expected one Daytona sandbox for ${identity.worktreePath}, found ${result.items.length}`,
        );
      }

      return result.items[0] ? toSandboxRecord(result.items[0], identity) : undefined;
    },
    async create(identity) {
      const client = createClient();
      const createParams = {
        ...(options.snapshot
          ? { snapshot: options.snapshot }
          : { language: options.language ?? DEFAULT_SANDBOX_LANGUAGE }),
        labels: buildDaytonaLabels(identity),
        public: false,
        autoStopInterval: options.autoStopIntervalMinutes ?? DEFAULT_AUTOSTOP_MINUTES,
        networkBlockAll: options.networkBlockAll ?? DEFAULT_NETWORK_BLOCK_ALL,
      };
      const sandbox = await client.create(createParams, { timeout: 120 });

      return toSandboxRecord(sandbox, identity);
    },
    async get(sandboxId) {
      const sandbox = await getSandbox(createClient, sandboxId);
      return sandbox ? toSandboxRecord(sandbox) : undefined;
    },
    async stop(sandboxId) {
      const sandbox = await requireSandbox(createClient, sandboxId);
      await sandbox.stop(120);
    },
    async resume(sandboxId) {
      const sandbox = await requireSandbox(createClient, sandboxId);
      if (sandbox.state !== "started") {
        await sandbox.start(120);
      }

      return toSandboxRecord(sandbox);
    },
    async destroy(sandboxId) {
      const sandbox = await getSandbox(createClient, sandboxId);
      if (!sandbox) {
        return;
      }

      await sandbox.delete(120);
    },
    async exec(sandboxId, request, onEvent) {
      const sandbox = await requireSandbox(createClient, sandboxId);
      if (sandbox.state !== "started") {
        onEvent?.({ type: "status", data: "starting" });
        await sandbox.start(120);
      }

      const wrappedCommand = buildSandboxCommand(request);

      if (!onEvent) {
        const response = await sandbox.process.executeCommand(
          wrappedCommand,
          undefined,
          undefined,
          toDaytonaTimeoutSeconds(request.timeoutMs),
        );
        return { exitCode: response.exitCode, output: response.result };
      }

      onEvent({ type: "status", data: "running" });

      const sessionId = `thor-sandbox-${randomUUID().slice(0, 8)}`;
      await sandbox.process.createSession(sessionId);
      const started = await sandbox.process.executeSessionCommand(
        sessionId,
        { command: wrappedCommand, runAsync: true },
        toDaytonaTimeoutSeconds(request.timeoutMs),
      );

      if (!started.cmdId) {
        throw new Error("Daytona exec did not return a command id");
      }

      await sandbox.process.getSessionCommandLogs(
        sessionId,
        started.cmdId,
        (chunk) => onEvent({ type: "stdout", data: chunk }),
        (chunk) => onEvent({ type: "stderr", data: chunk }),
      );

      const completed = await sandbox.process.getSessionCommand(sessionId, started.cmdId);
      const exitCode = completed.exitCode ?? 1;
      onEvent({ type: "status", data: `completed:${exitCode}` });
      return { exitCode };
    },
    async materializeWorkspace(sandboxId, request) {
      const sandbox = await requireSandbox(createClient, sandboxId);
      if (sandbox.state !== "started") {
        await sandbox.start(120);
      }

      const archive = await createWorktreeArchive(request.worktreePath);
      const remoteArchivePath = posix.join(
        "/tmp",
        `thor-materialize-${getSandboxWorktreeId(request.worktreePath)}.tgz`,
      );

      try {
        await sandbox.fs.uploadFile(archive.archivePath, remoteArchivePath, 300);
        const extract = await sandbox.process.executeCommand(
          extractArchiveCommand(remoteArchivePath, getRemoteWorkspaceDir(request.worktreePath)),
          undefined,
          undefined,
          300,
        );

        if (extract.exitCode !== 0) {
          throw new Error(`Daytona materialization failed: ${extract.result}`);
        }
      } finally {
        await rm(archive.tempDir, { recursive: true, force: true });
      }
    },
    async exportWorkspace(sandboxId, worktreePath) {
      const sandbox = await requireSandbox(createClient, sandboxId);
      if (sandbox.state !== "started") {
        await sandbox.start(120);
      }

      const tempDir = await mkdtemp(join(tmpdir(), "thor-daytona-export-"));
      const archivePath = join(tempDir, "workspace.tgz");
      const extractDir = join(tempDir, "extract");
      const remoteArchivePath = posix.join(
        "/tmp",
        `thor-export-${getSandboxWorktreeId(worktreePath)}.tgz`,
      );

      try {
        const packageResult = await sandbox.process.executeCommand(
          createExportArchiveCommand(getRemoteWorkspaceDir(worktreePath), remoteArchivePath),
          undefined,
          undefined,
          300,
        );

        if (packageResult.exitCode !== 0) {
          throw new Error(`Daytona export packaging failed: ${packageResult.result}`);
        }

        await sandbox.fs.downloadFile(remoteArchivePath, archivePath, 300);
        await mkdir(extractDir, { recursive: true });
        await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir], {
          maxBuffer: 1024 * 1024 * 16,
        });

        const syncResult = await syncLocalDirectory(extractDir, worktreePath);
        return {
          filesChanged: syncResult.filesChanged,
          filesDeleted: syncResult.filesDeleted,
          artifactPaths: [],
        };
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    async getPreview(sandboxId, port) {
      const sandbox = await requireSandbox(createClient, sandboxId);
      const expiresInSeconds =
        options.previewExpiresInSeconds ?? DEFAULT_PREVIEW_EXPIRES_IN_SECONDS;
      const preview = await sandbox.getSignedPreviewUrl(port, expiresInSeconds);
      return {
        url: preview.url,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    },
  };
}

export function getSandboxWorktreeId(worktreePath: string): string {
  return createHash("sha256")
    .update(normalizeWorktreePath(worktreePath))
    .digest("hex")
    .slice(0, 24);
}

export function getRemoteWorkspaceDir(worktreePath: string): string {
  return posix.join(
    "/tmp",
    `thor-worktree-${slugify(basename(normalizeWorktreePath(worktreePath))) || "repo"}-${getSandboxWorktreeId(worktreePath)}`,
  );
}

export function buildSandboxCommand(request: SandboxExecRequest): string {
  const lines: string[] = [];

  if (request.cwd) {
    lines.push(`cd ${shellQuote(request.cwd)}`);
  }

  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }

    lines.push(`export ${key}=${shellQuote(value)}`);
  }

  lines.push(request.command);
  return wrapForPosixShell(lines.join("\n"));
}

export async function syncLocalDirectory(
  sourceDir: string,
  targetDir: string,
): Promise<{ filesChanged: number; filesDeleted: number }> {
  await mkdir(targetDir, { recursive: true });

  const sourceEntries = await readDirectoryMap(sourceDir);
  const targetEntries = await readDirectoryMap(targetDir);
  let filesChanged = 0;
  let filesDeleted = 0;

  for (const [name, targetEntry] of targetEntries.entries()) {
    if (LOCAL_SYNC_EXCLUDES.has(name) || sourceEntries.has(name)) {
      continue;
    }

    const targetPath = join(targetDir, name);
    filesDeleted += await countManagedEntries(targetPath);
    await rm(targetPath, { recursive: true, force: true });
  }

  for (const [name, sourceEntry] of sourceEntries.entries()) {
    const sourcePath = join(sourceDir, name);
    const targetPath = join(targetDir, name);
    const targetEntry = targetEntries.get(name);

    if (sourceEntry.isDirectory()) {
      if (targetEntry && !targetEntry.isDirectory()) {
        filesDeleted += await countManagedEntries(targetPath);
        await rm(targetPath, { recursive: true, force: true });
      }

      await mkdir(targetPath, { recursive: true });
      const nested = await syncLocalDirectory(sourcePath, targetPath);
      filesChanged += nested.filesChanged;
      filesDeleted += nested.filesDeleted;
      continue;
    }

    if (sourceEntry.isSymbolicLink()) {
      const sourceLink = await readlink(sourcePath);
      if (targetEntry) {
        const targetStats = await lstat(targetPath);
        if (targetStats.isSymbolicLink() && (await readlink(targetPath)) === sourceLink) {
          continue;
        }

        filesDeleted += await countManagedEntries(targetPath);
        await rm(targetPath, { recursive: true, force: true });
      }

      await symlink(sourceLink, targetPath);
      filesChanged += 1;
      continue;
    }

    if (targetEntry) {
      const sourceStats = await lstat(sourcePath);
      const targetStats = await lstat(targetPath);
      if (targetStats.isFile() && sourceStats.isFile()) {
        const [sourceContent, targetContent] = await Promise.all([
          readFile(sourcePath),
          readFile(targetPath),
        ]);
        if (sourceContent.equals(targetContent)) {
          continue;
        }
      }

      await rm(targetPath, { recursive: true, force: true });
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    filesChanged += 1;
  }

  return { filesChanged, filesDeleted };
}

function buildDaytonaLabels(identity: SandboxIdentity): Record<string, string> {
  return {
    "thor-worktree-id": getSandboxWorktreeId(identity.worktreePath),
    "thor-worktree-path-b64": encodeWorktreePath(identity.worktreePath),
    ...(identity.repo ? { "thor-repo-b64": encodeLabelValue(identity.repo) } : {}),
    ...(identity.branch ? { "thor-branch-b64": encodeLabelValue(identity.branch) } : {}),
    "thor-repo": slugify(identity.repo ?? basename(identity.worktreePath)) || "repo",
    ...(identity.branch ? { "thor-branch": slugify(identity.branch) || "branch" } : {}),
  };
}

function toSandboxRecord(sandbox: DaytonaSandbox, identity?: SandboxIdentity): SandboxRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    provider: "daytona",
    sandboxId: sandbox.id,
    identity: identity ?? identityFromLabels(sandbox.labels),
    status: toSandboxStatus(sandbox.state, sandbox.errorReason),
    createdAt: sandbox.createdAt ?? now,
    updatedAt: sandbox.updatedAt ?? sandbox.createdAt ?? now,
    metadata: sandbox.labels ?? {},
    ...(sandbox.errorReason ? { lastError: sandbox.errorReason } : {}),
  };
}

function identityFromLabels(labels: Record<string, string> | undefined): SandboxIdentity {
  return {
    worktreePath:
      decodeWorktreePath(labels?.["thor-worktree-path-b64"]) ??
      `/sandbox/${labels?.["thor-worktree-id"] ?? "unknown"}`,
    ...(decodeLabelValue(labels?.["thor-repo-b64"]) || labels?.["thor-repo"]
      ? { repo: decodeLabelValue(labels?.["thor-repo-b64"]) ?? labels?.["thor-repo"] }
      : {}),
    ...(decodeLabelValue(labels?.["thor-branch-b64"]) || labels?.["thor-branch"]
      ? { branch: decodeLabelValue(labels?.["thor-branch-b64"]) ?? labels?.["thor-branch"] }
      : {}),
  };
}

function toSandboxStatus(state: string | undefined, errorReason?: string): SandboxStatus {
  if (errorReason) {
    return "error";
  }

  switch (state) {
    case "started":
      return "ready";
    case "stopped":
      return "stopped";
    case "creating":
    case "building":
    case "starting":
    case "restoring":
      return "creating";
    case "deleting":
    case "destroying":
      return "destroying";
    case "error":
      return "error";
    default:
      return "busy";
  }
}

async function getSandbox(
  createClient: () => DaytonaClient,
  sandboxId: string,
): Promise<DaytonaSandbox | undefined> {
  try {
    const client = createClient();
    return await client.get(sandboxId);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function requireSandbox(
  createClient: () => DaytonaClient,
  sandboxId: string,
): Promise<DaytonaSandbox> {
  const sandbox = await getSandbox(createClient, sandboxId);
  if (!sandbox) {
    throw new Error(`Daytona sandbox not found: ${sandboxId}`);
  }

  return sandbox;
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "DaytonaNotFoundError" || error.message.includes("404");
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function wrapForPosixShell(command: string): string {
  return `sh -lc ${shellQuote(command)}`;
}

function slugify(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function encodeWorktreePath(worktreePath: string): string {
  return Buffer.from(normalizeWorktreePath(worktreePath)).toString("base64url");
}

function decodeWorktreePath(value: string | undefined): string | undefined {
  return decodeLabelValue(value);
}

function encodeLabelValue(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function decodeLabelValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function normalizeWorktreePath(worktreePath: string): string {
  try {
    return realpathSync(resolve(worktreePath));
  } catch {
    return resolve(worktreePath);
  }
}

function toDaytonaTimeoutSeconds(timeoutMs?: number): number | undefined {
  return timeoutMs ? Math.max(1, Math.ceil(timeoutMs / 1000)) : undefined;
}

async function createWorktreeArchive(
  worktreePath: string,
): Promise<{ tempDir: string; archivePath: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "thor-daytona-materialize-"));
  const archivePath = join(tempDir, "worktree.tgz");
  const args = ["-czf", archivePath];

  for (const pattern of MATERIALIZE_EXCLUDES) {
    args.push("--exclude", pattern);
  }

  args.push("-C", worktreePath, ".");

  await execFileAsync("tar", args, {
    env: {
      ...process.env,
      COPYFILE_DISABLE: "1",
      COPY_EXTENDED_ATTRIBUTES_DISABLE: "1",
    },
    maxBuffer: 1024 * 1024 * 16,
  });

  return { tempDir, archivePath };
}

function extractArchiveCommand(remoteArchivePath: string, remoteWorkspaceDir: string): string {
  return [
    `rm -rf ${shellQuote(remoteWorkspaceDir)}`,
    `mkdir -p ${shellQuote(remoteWorkspaceDir)}`,
    `tar -xzf ${shellQuote(remoteArchivePath)} -C ${shellQuote(remoteWorkspaceDir)}`,
  ].join("\n");
}

function createExportArchiveCommand(remoteWorkspaceDir: string, remoteArchivePath: string): string {
  return [
    `rm -f ${shellQuote(remoteArchivePath)}`,
    `tar -czf ${shellQuote(remoteArchivePath)} -C ${shellQuote(remoteWorkspaceDir)} .`,
  ].join("\n");
}

async function readDirectoryMap(
  directory: string,
): Promise<Map<string, Awaited<ReturnType<typeof lstat>>>> {
  const map = new Map<string, Awaited<ReturnType<typeof lstat>>>();

  for (const entry of await readdir(directory)) {
    if (LOCAL_SYNC_EXCLUDES.has(entry)) {
      continue;
    }

    map.set(entry, await lstat(join(directory, entry)));
  }

  return map;
}

async function countManagedEntries(entryPath: string): Promise<number> {
  const stats = await lstat(entryPath);
  if (!stats.isDirectory()) {
    return 1;
  }

  let count = 0;
  for (const entry of await readdir(entryPath)) {
    if (LOCAL_SYNC_EXCLUDES.has(entry)) {
      continue;
    }

    count += await countManagedEntries(join(entryPath, entry));
  }

  return count;
}
