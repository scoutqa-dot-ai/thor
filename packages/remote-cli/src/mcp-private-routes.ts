import type { Express } from "express";
import { matchesInternalSecret, McpPrivateCallSchema, McpPrivateSearchSchema } from "@thor/common";
import type { McpService } from "./mcp-handler.js";
import { mcpCallToNative } from "./mcp-call-result.js";

/** Install private structured MCP routes; CLI headers/body cannot establish native admission. */
export function registerMcpPrivateRoutes(
  app: Express,
  service: McpService,
  internalSecret: string | undefined,
): void {
  app.use("/internal/mcp", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!matchesInternalSecret(internalSecret ?? "", req.get("x-thor-internal-secret"))) {
      res
        .status(401)
        .json({ status: "denied", isError: true, message: "MCP private transport unauthorized." });
      return;
    }
    next();
  });
  app.post("/internal/mcp/search", async (req, res) => {
    const parsed = McpPrivateSearchSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ status: "denied", isError: true, message: "MCP private search envelope invalid." });
      return;
    }
    res.json(
      await service.searchTools(parsed.data.input, {
        kind: "native",
        authority: parsed.data.context,
      }),
    );
  });
  app.post("/internal/mcp/call", async (req, res) => {
    const parsed = McpPrivateCallSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ status: "denied", isError: true, message: "MCP private call envelope invalid." });
      return;
    }
    res.json(
      mcpCallToNative(
        await service.callTool(parsed.data.input, {
          kind: "native",
          authority: parsed.data.context,
        }),
      ),
    );
  });
}
