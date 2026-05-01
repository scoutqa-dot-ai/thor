import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { appendAlias, appendSessionEvent } from "./event-log.js";
import { buildThorDisclaimerForSession } from "./disclaimer.js";

const worklogRoot = "/tmp/thor-common-disclaimer-test";
const triggerId = "00000000-0000-4000-8000-000000000301";

describe("buildThorDisclaimerForSession", () => {
  beforeEach(() => {
    vi.stubEnv("WORKLOG_DIR", worklogRoot);
    rmSync(worklogRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(worklogRoot, { recursive: true, force: true });
  });

  it("uses the active trigger owner when building the disclaimer footer", () => {
    expect(appendSessionEvent("parent", { type: "trigger_start", triggerId })).toEqual({ ok: true });
    expect(appendAlias({ aliasType: "session.parent", aliasValue: "child", sessionId: "parent" })).toEqual({ ok: true });

    const disclaimer = buildThorDisclaimerForSession("child", "https://thor.example.com/");

    expect(disclaimer).toMatchObject({
      sessionId: "parent",
      triggerId,
      triggerUrl: `https://thor.example.com/runner/v/parent/${triggerId}`,
    });
    expect(disclaimer.footer).toContain(`[View Thor trigger](${disclaimer.triggerUrl})`);
  });

  it("fails fast with actionable reasons when disclaimer context is unsafe", () => {
    expect(() => buildThorDisclaimerForSession(undefined)).toThrowError(
      "Disclaimer required: missing Thor session id",
    );

    expect(() => buildThorDisclaimerForSession("missing")).toThrowError(
      "Disclaimer required: no single active trigger for session missing (none)",
    );
  });
});
