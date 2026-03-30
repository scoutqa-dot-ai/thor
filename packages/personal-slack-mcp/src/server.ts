/**
 * MCP Server setup — registers all tools with Zod-validated inputs.
 * READ-ONLY: No post_message, no write operations.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createLogger, logInfo, logError } from "@thor/common";
import type { SlackDeps } from "./slack-client.js";

import { ListChannelsInput, GetChannelHistoryInput, listChannels, getChannelHistory } from "./tools/channels.js";
import { SearchMessagesInput, GetThreadRepliesInput, searchMessages, getThreadReplies } from "./tools/messages.js";
import { ListDmsInput, GetDmHistoryInput, listDms, getDmHistory } from "./tools/dms.js";
import { ListUsersInput, GetUserProfileInput, listUsers, getUserProfile } from "./tools/users.js";

const log = createLogger("personal-slack-mcp");

const tools: Tool[] = [
  {
    name: "list_channels",
    description: "List Slack channels the user has access to (public + private).",
    inputSchema: {
      type: "object" as const,
      properties: {
        types: { type: "string", description: "Channel types (default: public_channel,private_channel)" },
        limit: { type: "number", description: "Max channels (default 100, max 200)" },
        cursor: { type: "string", description: "Pagination cursor" },
      },
    },
  },
  {
    name: "get_channel_history",
    description: "Read recent messages from a Slack channel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string", description: "Channel ID" },
        limit: { type: "number", description: "Max messages (default 50, max 100)" },
        oldest: { type: "string", description: "Only messages after this timestamp" },
      },
      required: ["channel"],
    },
  },
  {
    name: "search_messages",
    description: "Search Slack messages. Supports from:, in:, has: modifiers. Only available with user tokens.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Max results (default 20, max 100)" },
        sort: { type: "string", enum: ["score", "timestamp"], description: "Sort order" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_thread_replies",
    description: "Read all replies in a Slack thread.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string", description: "Channel ID" },
        ts: { type: "string", description: "Thread parent message timestamp" },
        limit: { type: "number", description: "Max replies (default 50, max 200)" },
      },
      required: ["channel", "ts"],
    },
  },
  {
    name: "list_dms",
    description: "List direct message conversations (1:1 and group DMs).",
    inputSchema: {
      type: "object" as const,
      properties: {
        types: { type: "string", description: "DM types (default: im,mpim)" },
        limit: { type: "number", description: "Max conversations (default 100, max 200)" },
        cursor: { type: "string", description: "Pagination cursor" },
      },
    },
  },
  {
    name: "get_dm_history",
    description: "Read recent messages from a DM conversation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string", description: "DM channel ID" },
        limit: { type: "number", description: "Max messages (default 50, max 100)" },
        oldest: { type: "string", description: "Only messages after this timestamp" },
      },
      required: ["channel"],
    },
  },
  {
    name: "list_users",
    description: "List workspace users (excludes bots and deactivated accounts).",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max users (default 100, max 200)" },
        cursor: { type: "string", description: "Pagination cursor" },
      },
    },
  },
  {
    name: "get_user_profile",
    description: "Get a user's profile details.",
    inputSchema: {
      type: "object" as const,
      properties: {
        user: { type: "string", description: "Slack user ID" },
      },
      required: ["user"],
    },
  },
];

type ToolHandler = (args: Record<string, unknown>, deps: SlackDeps) => Promise<unknown>;

function createToolHandlers(deps: SlackDeps): Record<string, ToolHandler> {
  return {
    list_channels: (args) => listChannels(ListChannelsInput.parse(args), deps),
    get_channel_history: (args) => getChannelHistory(GetChannelHistoryInput.parse(args), deps),
    search_messages: (args) => searchMessages(SearchMessagesInput.parse(args), deps),
    get_thread_replies: (args) => getThreadReplies(GetThreadRepliesInput.parse(args), deps),
    list_dms: (args) => listDms(ListDmsInput.parse(args), deps),
    get_dm_history: (args) => getDmHistory(GetDmHistoryInput.parse(args), deps),
    list_users: (args) => listUsers(ListUsersInput.parse(args), deps),
    get_user_profile: (args) => getUserProfile(GetUserProfileInput.parse(args), deps),
  };
}

export function createPersonalSlackMcpServer(deps: SlackDeps): Server {
  const server = new Server(
    { name: "personal-slack-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  const handlers = createToolHandlers(deps);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const start = Date.now();

    const handler = handlers[toolName];
    if (!handler) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }

    try {
      const result = await handler(args, deps);
      const durationMs = Date.now() - start;
      logInfo(log, "tool_call", { tool: toolName, durationMs });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      logError(log, "tool_call_error", err instanceof Error ? err.message : String(err), {
        tool: toolName,
        durationMs,
      });
      return {
        content: [
          { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export { tools };
