import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { BrowserLoginOutput, ICredentialBroker, LoginMetadataOutput } from "./broker.ts";
import type { BrokerError } from "./errors.ts";
import { createBrokerMcpServer } from "./mcp-server.ts";
import { ok, type Result } from "./result.ts";

const ITEM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const VAULT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORIGIN = "https://accounts.lambdatest.com";

class RecordingBroker implements ICredentialBroker {
  metadataInputs: Array<{ readonly itemId: string; readonly sessionId?: string }> = [];
  loginInputs: Array<{
    readonly itemId: string;
    readonly expectedOrigin: string;
    readonly sessionId?: string;
  }> = [];

  async getLoginMetadata(input: {
    readonly itemId: string;
    readonly sessionId?: string;
  }): Promise<Result<LoginMetadataOutput, BrokerError>> {
    this.metadataInputs.push(input);
    return ok({
      item_id: ITEM_ID,
      vault_id: VAULT_ID,
      title: "TestMu audit",
      approved_origin: ORIGIN,
      fields: [
        { name: "username", type: "Text" },
        { name: "password", type: "Concealed" },
      ],
    });
  }

  async browserLogin(input: {
    readonly itemId: string;
    readonly expectedOrigin: string;
    readonly sessionId?: string;
  }): Promise<Result<BrowserLoginOutput, BrokerError>> {
    this.loginInputs.push(input);
    return ok({
      status: "authenticated",
      item_id: ITEM_ID,
      vault_id: VAULT_ID,
      origin: ORIGIN,
    });
  }
}

async function withClient(
  run: (client: Client, broker: RecordingBroker) => Promise<void>,
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const broker = new RecordingBroker();
  const server = createBrokerMcpServer(broker);
  const client = new Client({ name: "broker-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client, broker);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

describe("1Password browser MCP public interface", () => {
  it("lists only metadata and approved browser-login tools without internal context fields", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["get_login_metadata", "browser_login"]);
      expect(JSON.stringify(tools)).not.toContain("_thor_session_id");
      expect(JSON.stringify(tools)).not.toContain("read_secret");
      expect(JSON.stringify(tools)).not.toContain("vault");
    });
  });

  it("passes server-injected session context without returning credential material", async () => {
    await withClient(async (client, broker) => {
      const result = await client.callTool({
        name: "browser_login",
        arguments: {
          item_id: ITEM_ID,
          expected_origin: ORIGIN,
          _thor_session_id: "ses_123",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(broker.loginInputs).toEqual([
        { itemId: ITEM_ID, expectedOrigin: ORIGIN, sessionId: "ses_123" },
      ]);
      expect(JSON.stringify(result)).not.toContain("password");
      expect(JSON.stringify(result)).not.toContain("cookie");
    });
  });

  it("rejects malformed or extra arguments without echoing them or invoking the broker", async () => {
    await withClient(async (client, broker) => {
      const secret = "must-not-be-echoed";
      const result = await client.callTool({
        name: "get_login_metadata",
        arguments: { item_id: "bad", injected_secret: secret },
      });

      expect(result.isError).toBe(true);
      expect(broker.metadataInputs).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).toContain("invalid_request");
    });
  });
});
