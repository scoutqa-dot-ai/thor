#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path, { basename, posix, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { Daytona } from "@daytonaio/sdk";
import { Sandbox as E2BSandbox } from "e2b";

const execFileAsync = promisify(execFile);

const DEFAULT_PREVIEW_PORT = 3210;
const DEFAULT_SANDBOX_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const TAR_EXCLUDES = [".git", ".context", "node_modules", "dist", "coverage", ".next", ".turbo"];

class UsageError extends Error {}

function usage() {
  return `Hosted sandbox spike

Usage:
  node scripts/sandbox-spike.mjs --provider=daytona [--worktree=.]
  node scripts/sandbox-spike.mjs --provider=e2b [--worktree=.]

Options:
  --provider <daytona|e2b>  Required provider to spike
  --worktree <path>         Worktree path to materialize (defaults to cwd)
  --port <number>           Preview port to probe (defaults to 3210)
  --keep                    Keep the sandbox instead of destroying it
  --recreate                Destroy any existing sandbox for the worktree first
  --allow-internet          Skip the egress lockdown probe
  --help                    Show this message
`;
}

function parseArgs(argv) {
  const options = {
    worktree: process.cwd(),
    keep: false,
    recreate: false,
    allowInternet: false,
    port: DEFAULT_PREVIEW_PORT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--keep") {
      options.keep = true;
      continue;
    }

    if (arg === "--recreate") {
      options.recreate = true;
      continue;
    }

    if (arg === "--allow-internet") {
      options.allowInternet = true;
      continue;
    }

    if (arg.startsWith("--provider=")) {
      options.provider = arg.slice("--provider=".length);
      continue;
    }

    if (arg === "--provider") {
      options.provider = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--worktree=")) {
      options.worktree = arg.slice("--worktree=".length);
      continue;
    }

    if (arg === "--worktree") {
      options.worktree = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      options.port = Number(arg.slice("--port=".length));
      continue;
    }

    if (arg === "--port") {
      options.port = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    throw new UsageError(`Unknown argument: ${arg}`);
  }

  return options;
}

function logStep(message) {
  console.error(`\n== ${message}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function wrapForPosixShell(command) {
  return `sh -lc ${shellQuote(command)}`;
}

async function runLocal(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    maxBuffer: 1024 * 1024 * 16,
    ...options,
  });

  return result.stdout.trim();
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function resolveWorktreeIdentity(worktreePath) {
  const absoluteWorktreePath = realpathSync(resolve(worktreePath));
  let repoRoot = absoluteWorktreePath;
  let branch;

  try {
    repoRoot = await runLocal("git", ["-C", absoluteWorktreePath, "rev-parse", "--show-toplevel"]);
  } catch {
    repoRoot = absoluteWorktreePath;
  }

  try {
    branch = await runLocal("git", ["-C", absoluteWorktreePath, "branch", "--show-current"]);
  } catch {
    branch = undefined;
  }

  const worktreeId = createHash("sha256").update(absoluteWorktreePath).digest("hex").slice(0, 24);

  const repoName = basename(repoRoot);
  const repoSlug = slugify(repoName) || "repo";
  const remoteWorkspaceDir = posix.join("/tmp", `thor-worktree-${repoSlug}-${worktreeId}`);

  return {
    worktreeId,
    worktreePath: absoluteWorktreePath,
    repoName,
    repoSlug,
    branch,
    remoteWorkspaceDir,
  };
}

async function createWorktreeArchive(worktreePath) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "thor-sandbox-spike-"));
  const archivePath = path.join(tempDir, "worktree.tgz");
  const args = ["-czf", archivePath];

  for (const pattern of TAR_EXCLUDES) {
    args.push("--exclude", pattern);
  }

  args.push("-C", worktreePath, ".");

  await execFileAsync("tar", args, { maxBuffer: 1024 * 1024 * 16 });

  return { tempDir, archivePath };
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createPythonRunner(script) {
  return [
    'PYTHON_BIN="$(command -v python3 || command -v python || true)"',
    'if [ -z "$PYTHON_BIN" ]; then',
    '  echo "python-not-found" >&2',
    "  exit 127",
    "fi",
    "$PYTHON_BIN - <<'PY'",
    script.trim(),
    "PY",
  ].join("\n");
}

function streamProbeCommand() {
  return ["printf '%s\\n' 'stdout-from-sandbox'", "printf '%s\\n' 'stderr-from-sandbox' >&2"].join(
    "\n",
  );
}

function previewServerCommand(previewDir, port, stateToken) {
  return [
    'PYTHON_BIN="$(command -v python3 || command -v python || true)"',
    'if [ -z "$PYTHON_BIN" ]; then',
    '  echo "python-not-found" >&2',
    "  exit 127",
    "fi",
    `mkdir -p ${shellQuote(previewDir)}`,
    `printf '%s\n' ${shellQuote(`preview:${stateToken}`)} > ${shellQuote(posix.join(previewDir, "index.html"))}`,
    `nohup "$PYTHON_BIN" -m http.server ${port} --bind 0.0.0.0 --directory ${shellQuote(previewDir)} >/tmp/thor-preview.log 2>&1 &`,
    "echo preview-server-started",
  ].join("\n");
}

function networkProbeCommand() {
  return createPythonRunner(`
import socket
import sys

try:
    socket.create_connection(("1.1.1.1", 443), timeout=5).close()
    print("internet-access-ok")
except Exception as exc:
    print(f"internet-access-blocked:{type(exc).__name__}:{exc}")
    sys.exit(17)
  `);
}

function extractArchiveCommand(remoteArchivePath, remoteWorkspaceDir) {
  return [
    `rm -rf ${shellQuote(remoteWorkspaceDir)}`,
    `mkdir -p ${shellQuote(remoteWorkspaceDir)}`,
    `tar -xzf ${shellQuote(remoteArchivePath)} -C ${shellQuote(remoteWorkspaceDir)}`,
    `find ${shellQuote(remoteWorkspaceDir)} -maxdepth 2 | sed -n '1,12p'`,
  ].join("\n");
}

function writeStateFileCommand(stateFilePath, stateToken) {
  return `printf '%s\n' ${shellQuote(stateToken)} > ${shellQuote(stateFilePath)}`;
}

function readStateFileCommand(stateFilePath) {
  return `cat ${shellQuote(stateFilePath)}`;
}

async function fetchStatus(url, headers = {}) {
  try {
    const response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    return response.status;
  } catch (error) {
    return `error:${error.message}`;
  }
}

async function fetchStatusWithRetry(
  url,
  headers = {},
  { attempts = 5, delayMs = 2_000, accept = (status) => typeof status === "number" } = {},
) {
  let lastStatus;

  for (let index = 0; index < attempts; index += 1) {
    lastStatus = await fetchStatus(url, headers);
    if (accept(lastStatus)) {
      return lastStatus;
    }

    if (index < attempts - 1) {
      await sleep(delayMs);
    }
  }

  return lastStatus;
}

function assertPreviewAuth(preview) {
  if (`${preview.unsignedStatus}` === "200") {
    throw new Error("Preview URL was reachable without authentication");
  }

  if (`${preview.tokenHeaderStatus}` !== "200") {
    throw new Error(
      `Preview URL did not become reachable with provider auth: ${preview.tokenHeaderStatus}`,
    );
  }

  if ("signedStatus" in preview && `${preview.signedStatus}` !== "200") {
    throw new Error(`Signed preview URL did not return 200: ${preview.signedStatus}`);
  }
}

function assertNetworkLock(network) {
  if (network?.error) {
    throw new Error(`Sandbox egress probe failed: ${network.error}`);
  }

  if (`${network?.exitCode}` === "0" || `${network?.stdout}`.includes("internet-access-ok")) {
    throw new Error("Sandbox egress remained open despite lockdown request");
  }
}

function assertReattach(summary) {
  if (summary.reattachedSandboxId !== summary.sandboxId) {
    throw new Error(
      `Sandbox reattach returned a different sandbox id (${summary.reattachedSandboxId})`,
    );
  }
}

function assertStatePersistence(statePersistence) {
  if (!statePersistence?.preserved) {
    throw new Error("Sandbox state did not survive the stop/resume cycle");
  }
}

function ensureRequiredEnv(provider, names) {
  const missing = names.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(
      `${provider} spike is missing required environment variables: ${missing.join(", ")}`,
    );
  }
}

function buildE2BMetadata(identity) {
  return {
    "thor-worktree-id": identity.worktreeId,
    "thor-repo": identity.repoName,
    ...(identity.branch ? { "thor-branch": identity.branch } : {}),
  };
}

function buildDaytonaLabels(identity) {
  return {
    "thor-worktree-id": identity.worktreeId,
    "thor-repo": slugify(identity.repoName) || "repo",
    ...(identity.branch ? { "thor-branch": slugify(identity.branch) || "branch" } : {}),
  };
}

function normalizeE2BCommandError(error) {
  if (error && error.name === "CommandExitError") {
    return {
      exitCode: error.exitCode,
      stdout: error.stdout,
      stderr: error.stderr,
      error: error.error,
    };
  }

  throw error;
}

function createDaytonaProvider(identity, options) {
  ensureRequiredEnv("Daytona", ["DAYTONA_API_KEY"]);

  const clientConfig = {
    apiKey: process.env.DAYTONA_API_KEY,
    ...(process.env.DAYTONA_API_URL ? { apiUrl: process.env.DAYTONA_API_URL } : {}),
    ...(process.env.DAYTONA_TARGET ? { target: process.env.DAYTONA_TARGET } : {}),
  };

  function createClient() {
    return new Daytona(clientConfig);
  }

  async function findExisting() {
    const client = createClient();
    const result = await client.list({ "thor-worktree-id": identity.worktreeId }, 1, 10);

    if (result.items.length > 1) {
      throw new Error(
        `Expected at most one Daytona sandbox for worktree ${identity.worktreeId}, found ${result.items.length}`,
      );
    }

    return result.items[0];
  }

  async function attachFromRecord(record) {
    const client = createClient();
    const sandbox = await client.get(record.id);

    if (sandbox.state !== "started") {
      await sandbox.start(120);
    }

    return sandbox;
  }

  return {
    providerName: "daytona",
    async findExisting() {
      return findExisting();
    },
    async create() {
      const client = createClient();
      return client.create(
        {
          language: "python",
          labels: buildDaytonaLabels(identity),
          public: false,
          autoStopInterval: 30,
          ...(options.allowInternet ? {} : { networkBlockAll: true }),
        },
        { timeout: 120 },
      );
    },
    async attach(existing) {
      return attachFromRecord(existing);
    },
    getSandboxId(sandbox) {
      return sandbox.id;
    },
    describeExisting(existing) {
      return {
        sandboxId: existing.id,
        state: existing.state,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
      };
    },
    async destroy(existing) {
      if (!existing) {
        return;
      }

      if (typeof existing.delete === "function") {
        await existing.delete(120);
        return;
      }

      const sandbox = await attachFromRecord(existing);
      await sandbox.delete(120);
    },
    async materializeWorkspace(sandbox, archivePath) {
      const remoteArchivePath = posix.join("/tmp", `thor-archive-${identity.worktreeId}.tgz`);
      await sandbox.fs.uploadFile(archivePath, remoteArchivePath, 300);
      const extract = await sandbox.process.executeCommand(
        extractArchiveCommand(remoteArchivePath, identity.remoteWorkspaceDir),
        undefined,
        undefined,
        300,
      );

      if (extract.exitCode !== 0) {
        throw new Error(`Daytona materialization failed: ${extract.result}`);
      }
    },
    async streamCommand(sandbox, command) {
      const sessionId = `thor-spike-${randomUUID().slice(0, 8)}`;
      await sandbox.process.createSession(sessionId);
      const started = await sandbox.process.executeSessionCommand(
        sessionId,
        {
          command: wrapForPosixShell(command),
          runAsync: true,
        },
        60,
      );

      if (!started.cmdId) {
        throw new Error("Daytona session command did not return a command id");
      }

      await sandbox.process.getSessionCommandLogs(
        sessionId,
        started.cmdId,
        (chunk) => process.stdout.write(`[daytona:stdout] ${chunk}`),
        (chunk) => process.stderr.write(`[daytona:stderr] ${chunk}`),
      );

      const completed = await sandbox.process.getSessionCommand(sessionId, started.cmdId);
      return {
        exitCode: completed.exitCode ?? 1,
        stdout: "",
        stderr: "",
      };
    },
    async writeState(sandbox, stateFilePath, stateToken) {
      const result = await sandbox.process.executeCommand(
        writeStateFileCommand(stateFilePath, stateToken),
        undefined,
        undefined,
        60,
      );

      if (result.exitCode !== 0) {
        throw new Error(`Failed to write Daytona state file: ${result.result}`);
      }
    },
    async readState(sandbox, stateFilePath) {
      const result = await sandbox.process.executeCommand(
        readStateFileCommand(stateFilePath),
        undefined,
        undefined,
        60,
      );

      if (result.exitCode !== 0) {
        throw new Error(`Failed to read Daytona state file: ${result.result}`);
      }

      return result.result.trim();
    },
    async startPreviewServer(sandbox, port, stateToken) {
      const previewDir = posix.join(identity.remoteWorkspaceDir, ".thor-preview");
      const result = await sandbox.process.executeCommand(
        previewServerCommand(previewDir, port, stateToken),
        undefined,
        undefined,
        60,
      );

      if (result.exitCode !== 0) {
        throw new Error(`Failed to start Daytona preview server: ${result.result}`);
      }
    },
    async probePreview(sandbox, port) {
      const preview = await sandbox.getPreviewLink(port);
      const signed = await sandbox.getSignedPreviewUrl(port, 300);

      return {
        url: preview.url,
        unsignedStatus: await fetchStatusWithRetry(preview.url),
        tokenHeaderStatus: preview.token
          ? await fetchStatusWithRetry(
              preview.url,
              {
                "x-daytona-preview-token": preview.token,
              },
              {
                accept: (status) => status === 200,
              },
            )
          : "no-token",
        signedUrl: signed.url,
        signedStatus: await fetchStatusWithRetry(
          signed.url,
          {},
          { accept: (status) => status === 200 },
        ),
      };
    },
    async probeNetwork(sandbox) {
      try {
        const result = await sandbox.process.executeCommand(
          networkProbeCommand(),
          undefined,
          undefined,
          30,
        );

        return {
          exitCode: result.exitCode,
          stdout: result.result.trim(),
        };
      } catch (error) {
        return {
          error: error.message,
        };
      }
    },
    async stopAndReattach(sandbox) {
      await sandbox.stop(120);
      return attachFromRecord({ id: sandbox.id });
    },
  };
}

function createE2BProvider(identity, options) {
  ensureRequiredEnv("E2B", ["E2B_API_KEY"]);

  async function findExisting() {
    const paginator = E2BSandbox.list({
      query: {
        metadata: {
          "thor-worktree-id": identity.worktreeId,
        },
      },
      limit: 10,
    });

    const sandboxes = [];
    while (paginator.hasNext && sandboxes.length < 2) {
      const items = await paginator.nextItems();
      sandboxes.push(...items);
    }

    if (sandboxes.length > 1) {
      throw new Error(
        `Expected at most one E2B sandbox for worktree ${identity.worktreeId}, found ${sandboxes.length}`,
      );
    }

    return sandboxes[0];
  }

  async function attachById(sandboxId) {
    return E2BSandbox.connect(sandboxId, {
      timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
    });
  }

  async function runCommand(sandbox, command, commandOptions = {}) {
    try {
      return await sandbox.commands.run(command, commandOptions);
    } catch (error) {
      return normalizeE2BCommandError(error);
    }
  }

  return {
    providerName: "e2b",
    async findExisting() {
      return findExisting();
    },
    async create() {
      return E2BSandbox.create({
        metadata: buildE2BMetadata(identity),
        timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
        secure: true,
        allowInternetAccess: options.allowInternet,
        network: {
          allowPublicTraffic: false,
          ...(options.allowInternet ? {} : { denyOut: ["0.0.0.0/0"] }),
        },
        lifecycle: {
          onTimeout: "pause",
        },
      });
    },
    async attach(existing) {
      return attachById(existing.sandboxId);
    },
    getSandboxId(sandbox) {
      return sandbox.sandboxId;
    },
    describeExisting(existing) {
      return {
        sandboxId: existing.sandboxId,
        state: existing.state,
        startedAt: existing.startedAt,
        endAt: existing.endAt,
      };
    },
    async destroy(existing) {
      if (!existing) {
        return;
      }

      if (typeof existing.kill === "function") {
        await existing.kill();
        return;
      }

      const sandbox = await attachById(existing.sandboxId);
      await sandbox.kill();
    },
    async materializeWorkspace(sandbox, archivePath) {
      const remoteArchivePath = posix.join("/tmp", `thor-archive-${identity.worktreeId}.tgz`);
      const archiveBytes = await readFile(archivePath);
      await sandbox.files.write(remoteArchivePath, new Blob([archiveBytes]));
      const extract = await runCommand(
        sandbox,
        extractArchiveCommand(remoteArchivePath, identity.remoteWorkspaceDir),
        {
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        },
      );

      if (extract.exitCode !== 0) {
        throw new Error(
          `E2B materialization failed: ${extract.stderr || extract.stdout || extract.error}`,
        );
      }
    },
    async streamCommand(sandbox, command) {
      return runCommand(sandbox, command, {
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        onStdout: (chunk) => process.stdout.write(`[e2b:stdout] ${chunk}`),
        onStderr: (chunk) => process.stderr.write(`[e2b:stderr] ${chunk}`),
      });
    },
    async writeState(sandbox, stateFilePath, stateToken) {
      const result = await runCommand(sandbox, writeStateFileCommand(stateFilePath, stateToken), {
        timeoutMs: 60_000,
      });

      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to write E2B state file: ${result.stderr || result.stdout || result.error}`,
        );
      }
    },
    async readState(sandbox, stateFilePath) {
      const result = await runCommand(sandbox, readStateFileCommand(stateFilePath), {
        timeoutMs: 60_000,
      });

      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to read E2B state file: ${result.stderr || result.stdout || result.error}`,
        );
      }

      return result.stdout.trim();
    },
    async startPreviewServer(sandbox, port, stateToken) {
      const previewDir = posix.join(identity.remoteWorkspaceDir, ".thor-preview");
      const result = await runCommand(sandbox, previewServerCommand(previewDir, port, stateToken), {
        timeoutMs: 60_000,
      });

      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to start E2B preview server: ${result.stderr || result.stdout || result.error}`,
        );
      }
    },
    async probePreview(sandbox, port) {
      const url = `https://${sandbox.getHost(port)}`;
      return {
        url,
        unsignedStatus: await fetchStatusWithRetry(url),
        tokenHeaderStatus: sandbox.trafficAccessToken
          ? await fetchStatusWithRetry(
              url,
              {
                "e2b-traffic-access-token": sandbox.trafficAccessToken,
              },
              {
                accept: (status) => status === 200,
              },
            )
          : "no-token",
      };
    },
    async probeNetwork(sandbox) {
      const result = await runCommand(sandbox, networkProbeCommand(), {
        timeoutMs: 30_000,
      });

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
    },
    async stopAndReattach(sandbox) {
      await sandbox.pause();
      return attachById(sandbox.sandboxId);
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  if (!options.provider || !["daytona", "e2b"].includes(options.provider)) {
    throw new UsageError("Missing or invalid --provider. Expected one of: daytona, e2b");
  }

  if (!Number.isInteger(options.port) || options.port <= 0) {
    throw new UsageError(`Invalid --port value: ${options.port}`);
  }

  const identity = await resolveWorktreeIdentity(options.worktree);
  const provider =
    options.provider === "daytona"
      ? createDaytonaProvider(identity, options)
      : createE2BProvider(identity, options);

  const summary = {
    provider: provider.providerName,
    worktreeId: identity.worktreeId,
    worktreePath: identity.worktreePath,
    remoteWorkspaceDir: identity.remoteWorkspaceDir,
    allowInternet: options.allowInternet,
    keep: options.keep,
  };

  let archive;
  let sandbox;
  let existing;

  try {
    logStep(`resolving worktree identity for ${identity.worktreePath}`);
    process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`);

    logStep("looking up existing sandbox by worktree metadata");
    existing = await provider.findExisting();
    if (existing) {
      process.stderr.write(`${JSON.stringify(provider.describeExisting(existing), null, 2)}\n`);
      if (options.recreate) {
        logStep("destroying existing sandbox because --recreate was requested");
        await provider.destroy(existing);
        existing = undefined;
      }
    } else {
      process.stderr.write("No existing sandbox found for this worktree.\n");
    }

    logStep(existing ? "attaching to existing sandbox" : "creating sandbox");
    sandbox = existing ? await provider.attach(existing) : await provider.create();
    summary.sandboxId = provider.getSandboxId(sandbox);

    logStep("creating local worktree archive");
    archive = await createWorktreeArchive(identity.worktreePath);

    logStep("materializing worktree into sandbox");
    await provider.materializeWorkspace(sandbox, archive.archivePath);

    logStep("running streaming exec probe");
    const streamResult = await provider.streamCommand(sandbox, streamProbeCommand());
    summary.exec = {
      exitCode: streamResult.exitCode,
      stdout: streamResult.stdout?.trim?.() ?? "",
      stderr: streamResult.stderr?.trim?.() ?? "",
    };

    const stateToken = `thor-state-${randomUUID().slice(0, 12)}`;
    const stateFilePath = posix.join(identity.remoteWorkspaceDir, ".thor-sandbox-state");

    logStep("writing state marker inside sandbox");
    await provider.writeState(sandbox, stateFilePath, stateToken);

    logStep("starting preview server");
    await provider.startPreviewServer(sandbox, options.port, stateToken);
    await sleep(3_000);

    logStep("probing preview authentication");
    summary.preview = await provider.probePreview(sandbox, options.port);
    assertPreviewAuth(summary.preview);

    if (options.allowInternet) {
      summary.network = {
        skipped: true,
        reason: "--allow-internet was set",
      };
    } else {
      logStep("probing outbound network lockdown");
      summary.network = await provider.probeNetwork(sandbox);
    }

    logStep("stopping and reattaching from a fresh provider client");
    sandbox = await provider.stopAndReattach(sandbox);
    summary.reattachedSandboxId = provider.getSandboxId(sandbox);
    assertReattach(summary);

    logStep("verifying state survived the stop/resume cycle");
    const observedStateToken = await provider.readState(sandbox, stateFilePath);
    summary.statePersistence = {
      expected: stateToken,
      observed: observedStateToken,
      preserved: observedStateToken === stateToken,
    };
    assertStatePersistence(summary.statePersistence);

    if (!options.allowInternet) {
      assertNetworkLock(summary.network);
    }

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    if (archive?.tempDir) {
      await rm(archive.tempDir, { recursive: true, force: true });
    }

    if (sandbox && !options.keep) {
      try {
        logStep("destroying sandbox");
        await provider.destroy(sandbox);
      } catch (error) {
        process.stderr.write(`Failed to destroy sandbox: ${error.message}\n`);
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);

  if (error instanceof UsageError) {
    process.stderr.write("\n");
    process.stderr.write(usage());
  }

  process.exitCode = 1;
});
