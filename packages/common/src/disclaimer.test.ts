import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { appendAlias, appendSessionEvent } from "./event-log.js";
import { buildThorDisclaimerForSession } from "./disclaimer.js";

const worklogRoot = "/tmp/thor-common-disclaimer-test";
const triggerId = "00000000-0000-7000-8000-000000000301";
const anchorId = "00000000-0000-7000-8000-000000000d01";

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
    expect(appendAlias({ aliasType: "opencode.session", aliasValue: "parent", anchorId })).toEqual({
      ok: true,
    });
    expect(appendSessionEvent("parent", { type: "trigger_start", triggerId })).toEqual({
      ok: true,
    });
    expect(
      appendAlias({ aliasType: "opencode.subsession", aliasValue: "child", anchorId }),
    ).toEqual({ ok: true });

    const disclaimer = buildThorDisclaimerForSession("child", "https://thor.example.com/");

    expect(disclaimer).toMatchObject({
      anchorId,
      sessionId: "parent",
      triggerId,
      triggerUrl: `https://thor.example.com/runner/v/${anchorId}/${triggerId}`,
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
