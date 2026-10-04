import { pathToFileURL } from "node:url";
import { createLogger, loadRunnerEnv, logInfo, logError } from "@thor/common";
import { createLegacyRunnerViewer } from "./legacy-runner-viewer.js";
import { createSlackProgressTransport } from "./slack-progress.js";

const log = createLogger("runner");
const config = loadRunnerEnv();
const PORT = config.port;
const OPENCODE_URL = config.opencodeUrl;

// --- Startup ---

/** Select one execution runtime; Pi loads only read-only legacy viewing, never OpenCode execution. */
export async function startRunner(): Promise<void> {
  if (process.env.THOR_RUNTIME === "pi") {
    const { parsePiRunnerConfig } = await import("./pi-runner-config.js");
    const parsed = parsePiRunnerConfig(process.env);
    if (!parsed.ok) {
      logError(log, "pi_startup_failed", parsed.error);
      process.exitCode = 1;
      return;
    }
    const { createPiRunnerApp } = await import("./pi-runner.js");
    const runner = await createPiRunnerApp(parsed.value, {
      legacyViewerApp: createLegacyRunnerViewer(),
      progressTransport: createSlackProgressTransport({
        token: config.slackBotToken,
        slackApiUrl: config.slackApiBaseUrl,
      }),
    });
    if (!runner.ok) {
      logError(log, "pi_startup_failed", runner.error);
      process.exitCode = 1;
      return;
    }
    const server = runner.app.listen(PORT, () =>
      logInfo(log, "runner_started", { port: PORT, runtime: "pi" }),
    );
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close();
      await runner.close();
      server.closeAllConnections();
    };
    const stopPiRunner = () => {
      void shutdown().catch(() => logError(log, "pi_shutdown_failed", "Pi storage close failed"));
    };
    process.on("SIGTERM", stopPiRunner);
    process.on("SIGINT", stopPiRunner);
    return;
  }
  if (process.env.THOR_RUNTIME && process.env.THOR_RUNTIME !== "opencode") {
    logError(log, "runner_startup_failed", "Unsupported runtime");
    process.exitCode = 1;
    return;
  }
  const { createRunnerApp, flushInflightTriggersOnShutdown } = await import("./legacy-runner.js");
  const app = createRunnerApp();
  const server = app.listen(PORT, () => {
    logInfo(log, "runner_started", {
      port: PORT,
      opencodeUrl: OPENCODE_URL,
    });
  });

  const shutdown = (signal: string) => {
    logInfo(log, "runner_shutting_down", { signal });
    flushInflightTriggersOnShutdown();
    server.close(() => process.exit(0));
    // Hard exit if server.close hangs.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startRunner().catch(() => {
    logError(log, "runner_startup_failed", "Runner startup unavailable");
    process.exitCode = 1;
  });
}
