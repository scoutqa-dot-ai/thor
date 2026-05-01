import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSPACE_CONFIG_PATH } from "@thor/common";
import { loadAdminConfig } from "./env.js";

describe("admin env", () => {
  it("loads defaults and derives audit log path from config path", () => {
    const config = loadAdminConfig({});

    expect(config.port).toBe(3005);
    expect(config.configPath).toBe(WORKSPACE_CONFIG_PATH);
    expect(config.auditLogPath).toBe(join(dirname(WORKSPACE_CONFIG_PATH), "config.audit.log"));
  });

  it("uses custom paths and strictly parses port", () => {
    const config = loadAdminConfig({
      PORT: "3005",
      CONFIG_PATH: "/tmp/thor/config.json",
      AUDIT_LOG_PATH: "/tmp/thor/audit.log",
    });

    expect(config.port).toBe(3005);
    expect(config.configPath).toBe("/tmp/thor/config.json");
    expect(config.auditLogPath).toBe("/tmp/thor/audit.log");
  });

  it("throws for invalid port", () => {
    expect(() => loadAdminConfig({ PORT: "bad" })).toThrow("PORT must be an integer");
    expect(() => loadAdminConfig({ PORT: "+3005" })).toThrow("PORT must be an integer");
  });
});
