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

  it("strictly parses integer fields", () => {
    const config = loadRunnerConfig({
      PORT: "3000",
      OPENCODE_CONNECT_TIMEOUT: "15000",
      ABORT_TIMEOUT: "10000",
      SESSION_ERROR_GRACE_MS: "20",
    });

    expect(config.port).toBe(3000);
    expect(config.opencodeConnectTimeout).toBe(15000);
    expect(config.abortTimeout).toBe(10000);
    expect(config.sessionErrorGraceMs).toBe(20);
    expect(() => loadRunnerConfig({ PORT: "03000x" })).toThrow("PORT must be an integer");
    expect(() => loadRunnerConfig({ OPENCODE_CONNECT_TIMEOUT: "+15000" })).toThrow(
      "OPENCODE_CONNECT_TIMEOUT must be an integer",
    );
  });

  it("throws for invalid integers", () => {
    expect(() => loadRunnerConfig({ PORT: "not-a-number" })).toThrow("PORT must be an integer");
  });
});
