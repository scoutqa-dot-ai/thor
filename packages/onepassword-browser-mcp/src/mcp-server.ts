import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { browserTypeTextMaxChars } from "./authenticated-browser.ts";
import type { ICredentialBroker } from "./broker.ts";
import { onePasswordIdPattern } from "./config.ts";
import type { BrokerError } from "./errors.ts";
import type { Result } from "./result.ts";

const ThorSessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const BrowserSessionIdSchema = z.uuid();
const BrowserSnapshotIdSchema = z.uuid();
const BrowserRefPattern = /^(?:f[1-9][0-9]*)?e[1-9][0-9]*$/;
const BrowserRefSchema = z.string().regex(BrowserRefPattern);
const BrowserUrlSchema = z.string().trim().min(1).max(2_000);
const InternalContextSchema = z.object({
  _thor_session_id: ThorSessionIdSchema,
});
const FindLoginItemsInputSchema = InternalContextSchema.extend({
  url: BrowserUrlSchema,
}).strict();
const OpenAuthenticatedBrowserInputSchema = InternalContextSchema.extend({
  item_id: z.string().regex(onePasswordIdPattern),
  url: BrowserUrlSchema,
  _approved_item_title: z.string().trim().min(1).max(200),
  automate_totp: z.boolean().optional().default(false),
}).strict();
const BrowserSessionInputSchema = InternalContextSchema.extend({
  browser_session_id: BrowserSessionIdSchema,
}).strict();
const BrowserRefInputSchema = BrowserSessionInputSchema.extend({
  snapshot_id: BrowserSnapshotIdSchema,
  ref: BrowserRefSchema,
}).strict();
const BrowserTypeInputSchema = BrowserRefInputSchema.extend({
  text: z.string().min(1).max(browserTypeTextMaxChars),
}).strict();
const BrowserNavigateInputSchema = BrowserSessionInputSchema.extend({
  url: BrowserUrlSchema,
}).strict();

const PUBLIC_TOOLS = [
  {
    name: "find_login_items",
    description:
      "Find non-secret 1Password Login item metadata matching the exact HTTPS origin of a website URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { url: { type: "string", format: "uri", maxLength: 2_000 } },
      required: ["url"],
    },
  },
  {
    name: "browser_open_authenticated",
    description:
      "After human approval, autofill one matching Login item and return an opaque broker-owned browser session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        item_id: { type: "string", pattern: onePasswordIdPattern.source },
        url: { type: "string", format: "uri", maxLength: 2_000 },
        automate_totp: {
          type: "boolean",
          description:
            "Request approval-gated use of the Login item's TOTP field when the website presents one MFA challenge.",
          default: false,
        },
      },
      required: ["item_id", "url"],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Return a bounded credential-redacted accessibility snapshot for an authenticated browser session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { browser_session_id: { type: "string", format: "uuid" } },
      required: ["browser_session_id"],
    },
  },
  {
    name: "browser_click",
    description:
      "Click one element ref from the latest authenticated browser snapshot; the snapshot then expires.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        browser_session_id: { type: "string", format: "uuid" },
        snapshot_id: { type: "string", format: "uuid" },
        ref: { type: "string", pattern: BrowserRefPattern.source },
      },
      required: ["browser_session_id", "snapshot_id", "ref"],
    },
  },
  {
    name: "browser_type",
    description:
      "Fill ordinary non-secret text into one ref from the latest snapshot; password, MFA, token, and payment fields are denied.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        browser_session_id: { type: "string", format: "uuid" },
        snapshot_id: { type: "string", format: "uuid" },
        ref: { type: "string", pattern: BrowserRefPattern.source },
        text: { type: "string", minLength: 1, maxLength: browserTypeTextMaxChars },
      },
      required: ["browser_session_id", "snapshot_id", "ref", "text"],
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate an authenticated browser only within its exact approved HTTPS origin.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        browser_session_id: { type: "string", format: "uuid" },
        url: { type: "string", format: "uri", maxLength: 2_000 },
      },
      required: ["browser_session_id", "url"],
    },
  },
  {
    name: "browser_close",
    description: "Destroy one authenticated browser session and its cookies and storage.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { browser_session_id: { type: "string", format: "uuid" } },
      required: ["browser_session_id"],
    },
  },
] as const;

function resultContent<T>(result: Result<T, BrokerError>): CallToolResult {
  if (result._tag === "err") {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            code: result.error.code,
            message: result.error.message,
          }),
        },
      ],
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(result.value) }] };
}

function invalidRequest(): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "error",
          code: "invalid_request",
          message: "1Password browser broker rejected invalid tool arguments",
        }),
      },
    ],
  };
}

/** Create the strict MCP adapter without exposing its trusted session/title fields. */
export function createBrokerMcpServer(broker: ICredentialBroker): Server {
  const server = new Server(
    { name: "thor-onepassword-browser", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.onclose = () => {
    void broker.closeAllBrowsers();
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...PUBLIC_TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    if (request.params.name === "find_login_items") {
      const parsed = FindLoginItemsInputSchema.safeParse(request.params.arguments);
      if (!parsed.success) return invalidRequest();
      return resultContent(
        await broker.findLoginItems({
          url: parsed.data.url,
          sessionId: parsed.data._thor_session_id,
        }),
      );
    }
    if (request.params.name === "browser_open_authenticated") {
      const parsed = OpenAuthenticatedBrowserInputSchema.safeParse(request.params.arguments);
      if (!parsed.success) return invalidRequest();
      return resultContent(
        await broker.openAuthenticatedBrowser({
          itemId: parsed.data.item_id,
          approvedTitle: parsed.data._approved_item_title,
          automateTotp: parsed.data.automate_totp,
          url: parsed.data.url,
          sessionId: parsed.data._thor_session_id,
        }),
      );
    }
    if (request.params.name === "browser_snapshot") {
      const parsed = BrowserSessionInputSchema.safeParse(request.params.arguments);
      if (!parsed.success) return invalidRequest();
      return resultContent(
        await broker.snapshotBrowser({
          browserSessionId: parsed.data.browser_session_id,
          sessionId: parsed.data._thor_session_id,
        }),
      );
    }
    if (request.params.name === "browser_click") {
      const parsed = BrowserRefInputSchema.safeParse(request.params.arguments);
      if (!parsed.success) return invalidRequest();
      return resultContent(
        await broker.clickBrowser({
          browserSessionId: parsed.data.browser_session_id,
          snapshotId: parsed.data.snapshot_id,
          ref: parsed.data.ref,
          sessionId: parsed.data._thor_session_id,
        }),
      );
    }
    if (request.params.name === "browser_type") {
      const parsed = BrowserTypeInputSchema.safeParse(request.params.arguments);
      if (!parsed.success) return invalidRequest();
      return resultContent(
        await broker.typeInBrowser({
          browserSessionId: parsed.data.browser_session_id,
          snapshotId: parsed.data.snapshot_id,
          ref: parsed.data.ref,
          text: parsed.data.text,
          sessionId: parsed.data._thor_session_id,
        }),
      );
    }
    if (request.params.name === "browser_navigate") {
      const parsed = BrowserNavigateInputSchema.safeParse(request.params.arguments);
      if (!parsed.success) return invalidRequest();
      return resultContent(
        await broker.navigateBrowser({
          browserSessionId: parsed.data.browser_session_id,
          url: parsed.data.url,
          sessionId: parsed.data._thor_session_id,
        }),
      );
    }
    if (request.params.name === "browser_close") {
      const parsed = BrowserSessionInputSchema.safeParse(request.params.arguments);
      if (!parsed.success) return invalidRequest();
      return resultContent(
        await broker.closeBrowser({
          browserSessionId: parsed.data.browser_session_id,
          sessionId: parsed.data._thor_session_id,
        }),
      );
    }
    return invalidRequest();
  });

  return server;
}

/** Exact public tool inventory used by tests and remote-cli policy drift checks. */
export const publicBrokerTools = PUBLIC_TOOLS;
