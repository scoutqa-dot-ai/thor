import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PlaywrightAuthenticatedBrowserSessions } from "./authenticated-browser.ts";
import { CredentialBroker, StderrBrokerAuditSink } from "./broker.ts";
import { parseBrokerEnvironment } from "./config.ts";
import { OnePasswordLoginCredentialReader } from "./credential-reader.ts";
import { createBrokerMcpServer } from "./mcp-server.ts";

const parsedEnvironment = parseBrokerEnvironment(process.env);
if (parsedEnvironment._tag === "err") {
  process.stderr.write(
    `${JSON.stringify({
      type: "onepassword_browser_startup",
      outcome: "failed",
      error_code: parsedEnvironment.error.code,
    })}\n`,
  );
  process.exitCode = 1;
} else {
  const browserSessions = new PlaywrightAuthenticatedBrowserSessions();
  const broker = new CredentialBroker({
    vaultId: parsedEnvironment.value.vaultId,
    credentialReader: new OnePasswordLoginCredentialReader(
      parsedEnvironment.value.vaultId,
      parsedEnvironment.value.serviceAccountToken,
    ),
    browserSessions,
    auditSink: new StderrBrokerAuditSink(),
  });
  const server = createBrokerMcpServer(broker);
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await broker.closeAllBrowsers();
    await server.close().catch(() => undefined);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await server.connect(new StdioServerTransport());
}
