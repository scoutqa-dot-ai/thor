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

  it("uses custom paths and legacy parseInt-compatible port behavior", () => {
    const config = loadAdminConfig({
      PORT: "03005x",
      CONFIG_PATH: "/tmp/thor/config.json",
      AUDIT_LOG_PATH: "/tmp/thor/audit.log",
    });

    expect(config.port).toBe(3005);
    expect(config.configPath).toBe("/tmp/thor/config.json");
    expect(config.auditLogPath).toBe("/tmp/thor/audit.log");
  });

  it("keeps invalid legacy integer results as NaN instead of throwing", () => {
    expect(Number.isNaN(loadAdminConfig({ PORT: "bad" }).port)).toBe(true);
  });
});
