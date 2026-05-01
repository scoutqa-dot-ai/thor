import { describe, expect, it } from "vitest";
import { loadRunnerConfig } from "./env.js";

describe("runner env", () => {
  it("loads defaults and normalizes OpenCode URL", () => {
    const config = loadRunnerConfig({ OPENCODE_URL: "http://127.0.0.1:4096///" });

    expect(config.port).toBe(3000);
    expect(config.opencodeUrl).toBe("http://127.0.0.1:4096");
    expect(config.opencodeConnectTimeout).toBe(15000);
    expect(config.abortTimeout).toBe(10000);
    expect(config.sessionErrorGraceMs).toBe(10000);
  });

  it("preserves legacy parseInt-compatible integer behavior", () => {
    const config = loadRunnerConfig({
      PORT: "03000x",
      OPENCODE_CONNECT_TIMEOUT: "+15000ms",
      ABORT_TIMEOUT: "10000 ",
      SESSION_ERROR_GRACE_MS: "20ms",
    });

    expect(config.port).toBe(3000);
    expect(config.opencodeConnectTimeout).toBe(15000);
    expect(config.abortTimeout).toBe(10000);
    expect(config.sessionErrorGraceMs).toBe(20);
  });

  it("keeps invalid legacy integer results as NaN instead of throwing", () => {
    expect(Number.isNaN(loadRunnerConfig({ PORT: "not-a-number" }).port)).toBe(true);
  });
});
