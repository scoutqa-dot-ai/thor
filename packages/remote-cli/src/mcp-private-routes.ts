import type { Express } from "express";
import {
  matchesInternalSecret,
  McpPrivateCallSchema,
  McpPrivateSearchSchema,
  McpApprovalClickSchema,
  McpApprovalReaderSchema,
} from "@thor/common";
import { z } from "zod/v4";
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
  app.post("/internal/mcp/approvals/resolve", async (req, res) => {
    const parsed = McpApprovalClickSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ status: "denied", message: "MCP approval click invalid." });
      return;
    }
    res.json(await service.resolvePrivateApproval(parsed.data));
  });
  app.post("/internal/mcp/approvals/read", (req, res) => {
    const parsed = z
      .strictObject({ actionId: z.uuid(), reader: McpApprovalReaderSchema })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ status: "denied" });
      return;
    }
    try {
      const value = service.readPrivateApproval(parsed.data.actionId, parsed.data.reader);
      res.status(value ? 200 : 403).json(value ? { status: "ok", value } : { status: "denied" });
    } catch {
      res.status(403).json({ status: "denied" });
    }
  });
  app.post("/internal/mcp/approvals/wait", (req, res) => {
    const parsed = McpApprovalReaderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ status: "unavailable" });
      return;
    }
    res.json({ status: service.observePrivateApprovalWait(parsed.data) });
  });
  app.post("/internal/mcp/approvals/list", (req, res) => {
    const parsed = McpApprovalReaderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ status: "denied" });
      return;
    }
    try {
      res.json({ status: "ok", value: service.listPrivateApprovals(parsed.data) });
    } catch {
      res.status(403).json({ status: "denied" });
    }
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
