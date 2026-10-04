import { mcpOperatorCatalogJsonSchema } from "@thor/common";
import { loadMcpCatalogSnapshot } from "./mcp-catalog-files.js";
import { createMcpService } from "./mcp-handler.js";

/** Operator-only validation: no network unless the explicit check verb is selected; no secret output. */
export async function runMcpCatalogCommand(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "schema") {
    process.stdout.write(JSON.stringify(mcpOperatorCatalogJsonSchema(), null, 2) + "\n");
    return 0;
  }
  if (
    !(args.length === 1 && args[0] === "validate") &&
    !(args.length === 2 && args[0] === "check")
  ) {
    process.stderr.write("Usage: mcp-catalog validate | check <alias> | schema\n");
    return 1;
  }
  const loaded = loadMcpCatalogSnapshot();
  if (!loaded.ok) {
    process.stderr.write(`MCP catalog rejected: ${loaded.reason}\n`);
    return 1;
  }
  if (args[0] === "validate") {
    process.stdout.write(
      JSON.stringify({
        valid: true,
        present: loaded.value.present,
        servers: Object.keys(loaded.value.policies),
      }) + "\n",
    );
    return 0;
  }
  const alias = args[1];
  if (!Object.hasOwn(loaded.value.policies, alias)) {
    process.stderr.write("MCP catalog check denied: unknown or disabled alias\n");
    return 1;
  }
  const service = createMcpService({ catalog: loaded.value, mode: "inventory-only" });
  // This operator diagnostic has a whole-check budget; it never invokes a tool.
  const timer = setTimeout(() => {
    void service.closeAll();
  }, 10_000).unref();
  try {
    const discovered = await service.searchTools(
      { query: "", server: alias, limit: 20 },
      { kind: "cli", command: { directory: "/workspace/repos/operator" } },
    );
    if (discovered.status !== "ok" || !discovered.value.servers[0]?.available) {
      process.stdout.write(
        JSON.stringify({
          server: alias,
          available: false,
          reason: "connection_or_inventory_unsupported",
        }) + "\n",
      );
      return 1;
    }
    // Legacy inventory is the same exact policy-filtered owner, with no descriptions or hidden names.
    const inventory = await service.executeMcp([alias], { directory: "/workspace/repos/operator" });
    process.stdout.write(
      JSON.stringify({
        server: alias,
        available: inventory.exitCode === 0,
        tools: inventory.exitCode === 0 ? inventory.stdout.trim().split("\n").filter(Boolean) : [],
      }) + "\n",
    );
    return inventory.exitCode;
  } finally {
    clearTimeout(timer);
    await service.closeAll();
  }
}
