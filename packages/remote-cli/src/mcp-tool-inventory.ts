import { createHash } from "node:crypto";
import type { McpToolDescriptor, ProxyConfig } from "@thor/common";
import { McpToolRefSchema } from "@thor/common";
import type { UpstreamConnection } from "./upstream.js";
import { classifyTool, validatePolicy } from "./policy-mcp.js";
import { compileMcpSchema, type McpArgumentValidator } from "./mcp-schema-validation.js";

/** Complete descriptors above 32 KiB are unsupported, never silently clipped. */
const MCP_DESCRIPTOR_MAX_BYTES = 32 * 1024;
/** Each discovery page contains at most 20 descriptors and 256 KiB of descriptor JSON. */
export const MCP_DISCOVERY_MAX_BYTES = 256 * 1024;
/** A visible tool binds exact policy/schema/revision and its argument validator together. */
export interface McpInventoryTool {
  readonly descriptor: McpToolDescriptor;
  readonly validator: McpArgumentValidator;
  readonly outputValidator?: McpArgumentValidator;
}
/** Built-in identity hashes policy/transport templates without resolving credential bytes. */
export function mcpPolicyFingerprint(config: ProxyConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
/** Fail the entire server closed on drift, duplicate names, or unsupported permitted schemas. */
export function buildMcpInventory(
  server: string,
  config: ProxyConfig,
  upstream: UpstreamConnection,
  revision: string,
): readonly McpInventoryTool[] {
  const names = upstream.tools.map((tool) => tool.name);
  validatePolicy(config.allow, config.approve ?? [], names);
  if (new Set(names).size !== names.length)
    throw new Error("MCP inventory unsupported: duplicate names");
  return upstream.tools.flatMap((tool) => {
    const policy = classifyTool(config.allow, config.approve ?? [], tool.name);
    if (policy === "hidden") return [];
    const validator = compileMcpSchema(tool.inputSchema);
    const outputValidator = tool.outputSchema ? compileMcpSchema(tool.outputSchema) : undefined;
    if (
      !validator ||
      (tool.outputSchema && !outputValidator) ||
      tool.execution?.taskSupport === "required"
    )
      throw new Error("MCP inventory unsupported: schema");
    const toolRef = McpToolRefSchema.parse(
      `${server}.${createHash("sha256")
        .update(JSON.stringify([revision, tool.name, validator.schema, policy]))
        .digest("hex")}`,
    );
    const descriptor: McpToolDescriptor = {
      server,
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: validator.schema,
      policy,
      toolRef,
    };
    if (Buffer.byteLength(JSON.stringify(descriptor)) > MCP_DESCRIPTOR_MAX_BYTES)
      throw new Error("MCP inventory unsupported: descriptor budget");
    return [{ descriptor, validator, ...(outputValidator ? { outputValidator } : {}) }];
  });
}
