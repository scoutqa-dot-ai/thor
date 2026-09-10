import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { onePasswordIdPattern } from "./config.ts";
import type { ICredentialBroker } from "./broker.ts";
import type { BrokerError } from "./errors.ts";
import type { Result } from "./result.ts";

const InternalContextSchema = z.object({
  _thor_session_id: z.string().trim().min(1).optional(),
});
const MetadataInputSchema = InternalContextSchema.extend({
  item_id: z.string().regex(onePasswordIdPattern),
}).strict();
const BrowserLoginInputSchema = InternalContextSchema.extend({
  item_id: z.string().regex(onePasswordIdPattern),
  expected_origin: z.string().trim().min(1),
}).strict();

const PUBLIC_TOOLS = [
  {
    name: "get_login_metadata",
    description:
      "Return non-secret metadata for the one approved 1Password login item. Never returns field values.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { item_id: { type: "string", pattern: onePasswordIdPattern.source } },
      required: ["item_id"],
    },
  },
  {
    name: "browser_login",
    description:
      "After human approval, inject the approved 1Password login into a local ephemeral browser for the exact approved HTTPS origin.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        item_id: { type: "string", pattern: onePasswordIdPattern.source },
        expected_origin: { type: "string", format: "uri" },
      },
      required: ["item_id", "expected_origin"],
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

export function createBrokerMcpServer(broker: ICredentialBroker): Server {
  const server = new Server(
    { name: "thor-onepassword-browser", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...PUBLIC_TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    if (request.params.name === "get_login_metadata") {
      const parsed = MetadataInputSchema.safeParse(request.params.arguments);
      if (!parsed.success) return invalidRequest();
      return resultContent(
        await broker.getLoginMetadata({
          itemId: parsed.data.item_id,
          ...(parsed.data._thor_session_id ? { sessionId: parsed.data._thor_session_id } : {}),
        }),
      );
    }
    if (request.params.name === "browser_login") {
      const parsed = BrowserLoginInputSchema.safeParse(request.params.arguments);
      if (!parsed.success) return invalidRequest();
      return resultContent(
        await broker.browserLogin({
          itemId: parsed.data.item_id,
          expectedOrigin: parsed.data.expected_origin,
          ...(parsed.data._thor_session_id ? { sessionId: parsed.data._thor_session_id } : {}),
        }),
      );
    }
    return invalidRequest();
  });

  return server;
}

export const publicBrokerTools = PUBLIC_TOOLS;
