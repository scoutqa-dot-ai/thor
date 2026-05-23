import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { isSlackEventGated } from "./slack-api.js";

function depsWithInfo(info = vi.fn()) {
  return {
    client: { conversations: { info } } as unknown as WebClient,
    info,
  };
}

describe("Slack channel gating", () => {
  it("admits regular public channels without an allowlist check", async () => {
    const deps = depsWithInfo();
    await expect(
      isSlackEventGated({ channel: "C123", channel_type: "channel" }, deps),
    ).resolves.toBe(false);
    expect(deps.info).not.toHaveBeenCalled();
  });

  it("gates every other known surface (group, im, mpim) without a lookup", async () => {
    const deps = depsWithInfo();
    await expect(isSlackEventGated({ channel: "G123", channel_type: "group" }, deps)).resolves.toBe(
      true,
    );
    await expect(isSlackEventGated({ channel: "D123", channel_type: "im" }, deps)).resolves.toBe(
      true,
    );
    await expect(isSlackEventGated({ channel: "GMPIM", channel_type: "mpim" }, deps)).resolves.toBe(
      true,
    );
    expect(deps.info).not.toHaveBeenCalled();
  });

  it("falls back to conversations.info when channel_type is missing", async () => {
    const privateDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: { is_private: true } }));
    await expect(isSlackEventGated({ channel: "G123" }, privateDeps)).resolves.toBe(true);
    expect(privateDeps.info).toHaveBeenCalledWith({ channel: "G123" });

    const imDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: { is_im: true } }));
    await expect(isSlackEventGated({ channel: "D123" }, imDeps)).resolves.toBe(true);

    const mpimDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: { is_mpim: true } }));
    await expect(isSlackEventGated({ channel: "GMPIM" }, mpimDeps)).resolves.toBe(true);

    const publicDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: { is_private: false } }));
    await expect(isSlackEventGated({ channel: "C123" }, publicDeps)).resolves.toBe(false);
  });

  it("fails closed on lookup errors", async () => {
    const deps = depsWithInfo(vi.fn().mockRejectedValue(new Error("unavailable")));
    await expect(isSlackEventGated({ channel: "G123" }, deps)).resolves.toBe(true);
  });

  it("fails closed on incomplete lookup responses", async () => {
    const missingChannelDeps = depsWithInfo(vi.fn().mockResolvedValue({ ok: true }));
    await expect(isSlackEventGated({ channel: "G123" }, missingChannelDeps)).resolves.toBe(true);

    const missingPrivacyDeps = depsWithInfo(vi.fn().mockResolvedValue({ channel: {} }));
    await expect(isSlackEventGated({ channel: "G123" }, missingPrivacyDeps)).resolves.toBe(true);
  });
});
