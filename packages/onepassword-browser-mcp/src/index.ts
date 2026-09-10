import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PlaywrightBrowserLogin } from "./browser-login.ts";
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
  const broker = new CredentialBroker({
    policy: parsedEnvironment.value.policy,
    credentialReader: new OnePasswordLoginCredentialReader(
      parsedEnvironment.value.serviceAccountToken,
    ),
    browserLogin: new PlaywrightBrowserLogin(),
    auditSink: new StderrBrokerAuditSink(),
  });
  const server = createBrokerMcpServer(broker);
  await server.connect(new StdioServerTransport());
}
