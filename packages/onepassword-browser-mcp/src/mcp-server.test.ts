import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { ICredentialBroker } from "./broker.ts";
import { createBrokerMcpServer } from "./mcp-server.ts";
import { ok } from "./result.ts";

const ITEM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const VAULT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORIGIN = "https://accounts.example.com";
const BROWSER_SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";
const LOGIN_PLAN_ID = "00000000-0000-4000-8000-000000000003";

class RecordingBroker implements ICredentialBroker {
  readonly calls: Array<{ operation: string; input: unknown }> = [];

  async findLoginItems(input: { url: string; sessionId: string }) {
    this.calls.push({ operation: "find", input });
    return ok({
      login_plan_id: LOGIN_PLAN_ID,
      application_origin: ORIGIN,
      credential_origin: ORIGIN,
      callback_origin: ORIGIN,
      matches: [{ item_id: ITEM_ID, title: "Example audit", origin: ORIGIN }],
    });
  }

  async resolveLoginPlan(input: { loginPlanId: string; itemId: string; sessionId: string }) {
    this.calls.push({ operation: "resolve", input });
    return ok({
      login_plan_id: LOGIN_PLAN_ID,
      item_id: ITEM_ID,
      title: "Example audit",
      application_origin: ORIGIN,
      credential_origin: ORIGIN,
      callback_origin: ORIGIN,
    });
  }

  async openAuthenticatedBrowser(input: {
    loginPlanId: string;
    itemId: string;
    approvedTitle: string;
    automateTotp: boolean;
    sessionId: string;
  }) {
    this.calls.push({ operation: "open", input });
    return ok({
      status: "authenticated" as const,
      browser_session_id: BROWSER_SESSION_ID,
      item_id: ITEM_ID,
      vault_id: VAULT_ID,
      origin: ORIGIN,
    });
  }

  async snapshotBrowser(input: { browserSessionId: string; sessionId: string }) {
    this.calls.push({ operation: "snapshot", input });
    return ok({
      browser_session_id: BROWSER_SESSION_ID,
      snapshot_id: SNAPSHOT_ID,
      origin: ORIGIN,
      title: "Dashboard",
      accessibility: [{ role: "heading", name: "Dashboard", ref: "e1" }],
    });
  }

  async clickBrowser(input: {
    browserSessionId: string;
    snapshotId: string;
    ref: string;
    sessionId: string;
  }) {
    this.calls.push({ operation: "click", input });
    return ok({
      status: "ready" as const,
      browser_session_id: BROWSER_SESSION_ID,
      origin: ORIGIN,
    });
  }

  async typeInBrowser(input: {
    browserSessionId: string;
    snapshotId: string;
    ref: string;
    text: string;
    sessionId: string;
  }) {
    this.calls.push({ operation: "type", input });
    return ok({
      status: "ready" as const,
      browser_session_id: BROWSER_SESSION_ID,
      origin: ORIGIN,
    });
  }

  async navigateBrowser(input: { browserSessionId: string; url: string; sessionId: string }) {
    this.calls.push({ operation: "navigate", input });
    return ok({
      status: "ready" as const,
      browser_session_id: BROWSER_SESSION_ID,
      origin: ORIGIN,
    });
  }

  async closeBrowser(input: { browserSessionId: string; sessionId: string }) {
    this.calls.push({ operation: "close", input });
    return ok({ status: "closed" as const, browser_session_id: BROWSER_SESSION_ID });
  }

  async closeAllBrowsers(): Promise<void> {}
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

describe("1Password authenticated browser MCP public interface", () => {
  it("lists only safe discovery and restricted browser controls", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "find_login_items",
        "browser_open_authenticated",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_navigate",
        "browser_close",
      ]);
      const serialized = JSON.stringify(tools);
      const toolNames = tools.map((tool) => tool.name).join(" ");
      expect(serialized).not.toContain("_thor_session_id");
      expect(serialized).not.toContain("_approved_item_title");
      expect(serialized).not.toContain("read_secret");
      expect(toolNames).not.toContain("cookie");
      expect(toolNames).not.toContain("storage");
      expect(toolNames).not.toContain("javascript");
      expect(toolNames).not.toContain("cdp");
    });
  });

  it("keeps trusted login-plan resolution callable but absent from public discovery", async () => {
    await withClient(async (client, broker) => {
      const result = await client.callTool({
        name: "_resolve_login_plan",
        arguments: {
          login_plan_id: LOGIN_PLAN_ID,
          item_id: ITEM_ID,
          _thor_session_id: "parent-session",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(broker.calls).toEqual([
        {
          operation: "resolve",
          input: {
            loginPlanId: LOGIN_PLAN_ID,
            itemId: ITEM_ID,
            sessionId: "parent-session",
          },
        },
      ]);
    });
  });

  it("passes trusted approval metadata and session context without returning credentials", async () => {
    await withClient(async (client, broker) => {
      const result = await client.callTool({
        name: "browser_open_authenticated",
        arguments: {
          login_plan_id: LOGIN_PLAN_ID,
          item_id: ITEM_ID,
          _approved_item_title: "Example audit",
          _thor_session_id: "parent-session",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(broker.calls).toEqual([
        {
          operation: "open",
          input: {
            loginPlanId: LOGIN_PLAN_ID,
            itemId: ITEM_ID,
            approvedTitle: "Example audit",
            automateTotp: false,
            sessionId: "parent-session",
          },
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("password");
      expect(JSON.stringify(result)).not.toContain("cookie");
      const automatedTotp = await client.callTool({
        name: "browser_open_authenticated",
        arguments: {
          login_plan_id: LOGIN_PLAN_ID,
          item_id: ITEM_ID,
          automate_totp: true,
          _approved_item_title: "Example audit",
          _thor_session_id: "parent-session",
        },
      });
      expect(automatedTotp.isError).not.toBe(true);
      expect(broker.calls.at(-1)).toEqual({
        operation: "open",
        input: {
          loginPlanId: LOGIN_PLAN_ID,
          itemId: ITEM_ID,
          approvedTitle: "Example audit",
          automateTotp: true,
          sessionId: "parent-session",
        },
      });
    });
  });

  it("routes snapshot refs and non-secret typing through strict argument schemas", async () => {
    await withClient(async (client, broker) => {
      await client.callTool({
        name: "browser_snapshot",
        arguments: {
          browser_session_id: BROWSER_SESSION_ID,
          _thor_session_id: "parent-session",
        },
      });
      const typed = await client.callTool({
        name: "browser_type",
        arguments: {
          browser_session_id: BROWSER_SESSION_ID,
          snapshot_id: SNAPSHOT_ID,
          ref: "e1",
          text: "report title",
          _thor_session_id: "parent-session",
        },
      });

      expect(typed.isError).not.toBe(true);
      expect(broker.calls).toEqual([
        {
          operation: "snapshot",
          input: { browserSessionId: BROWSER_SESSION_ID, sessionId: "parent-session" },
        },
        {
          operation: "type",
          input: {
            browserSessionId: BROWSER_SESSION_ID,
            snapshotId: SNAPSHOT_ID,
            ref: "e1",
            text: "report title",
            sessionId: "parent-session",
          },
        },
      ]);
      expect(JSON.stringify(typed)).not.toContain("report title");
    });
  });

  it("rejects missing trusted context and extra arguments without echoing them", async () => {
    await withClient(async (client, broker) => {
      const secret = "must-not-be-echoed";
      const result = await client.callTool({
        name: "find_login_items",
        arguments: { url: `${ORIGIN}/`, injected_secret: secret },
      });

      expect(result.isError).toBe(true);
      expect(broker.calls).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).toContain("invalid_request");
    });
  });
});
