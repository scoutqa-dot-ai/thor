import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSlackPresentation } from "./pi-slack-presentation.js";
import type { SlackProgressTransport } from "./slack-progress.js";
import type { ProgressBlock } from "@thor/common";

function recordingSurface(statusMode: SlackProgressTransport["statusMode"] = "sessions") {
  const records: Array<{ method: string; text: string; blocks?: ProgressBlock[] }> = [];
  const transport: SlackProgressTransport = {
    statusMode,
    async post(_target, text, blocks) {
      records.push({ method: "post", text, blocks });
      return { ts: "1710000000.010" };
    },
    async update(_target, _ts, text, blocks) {
      records.push({ method: "update", text, blocks });
    },
    async delete() {
      records.push({ method: "delete", text: "" });
    },
    async addReaction(_target, _ts, name) {
      records.push({ method: "reaction", text: name });
    },
    async setStatus(_target, status) {
      records.push({ method: "status", text: status });
      return { state: "confirmed" };
    },
  };
  const owner = new PiSlackPresentation(
    {
      key: "C_TEST:1710000000.001",
      sourceTs: "1710000000.002",
      assetBaseUrl: "https://neo.example.test",
      transportTarget: { channel: "C_TEST", threadTs: "1710000000.001" },
    },
    transport,
    Date.now(),
    async () => {},
  );
  return { records, owner };
}

afterEach(() => vi.useRealTimers());
describe("single request Slack presentation pacing", () => {
  it("coalesces nonterminal phases/model changes, makes output still immediately and drains terminal cleanup without a minimum-visible delay", async () => {
    vi.useFakeTimers();
    const { records, owner } = recordingSurface();
    await owner.start();
    await owner.event({ type: "model", modelId: "initial", thinkingLevel: "low" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(records.filter((record) => record.method === "post")).toHaveLength(1);
    await owner.event({ type: "activity", activity: "working" });
    await owner.event({ type: "activity", activity: "thinking" });
    await owner.event({ type: "activity", activity: "working" });
    await owner.event({ type: "model", modelId: "promoted", thinkingLevel: "high" });
    await vi.advanceTimersByTimeAsync(1199);
    expect(records.filter((record) => record.method === "update")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const updates = records.filter((record) => record.method === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toContain("Neo working");
    expect(JSON.stringify(updates[0].blocks)).toContain("promoted");
    expect(JSON.stringify(updates[0].blocks).match(/\.gif/g)).toHaveLength(1);
    await owner.event({ type: "activity", activity: "responding" });
    expect(JSON.stringify(records.at(-1)?.blocks)).toContain("neo-ai-still-v1.png");
    const done = { type: "done", status: "completed", durationMs: 2700 } as const;
    await owner.settle(done);
    await owner.finish(done);
    const count = records.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(records).toHaveLength(count);
    expect(records.at(-1)?.method).toBe("delete");
    expect(records.filter((record) => record.method === "status").at(-1)?.text).toBe("active");
  });

  it("native snapshot replacement does not announce old completions or bypass grace, but three newly completed calls can", async () => {
    vi.useFakeTimers();
    const { owner, records } = recordingSurface();
    await owner.start();
    await owner.event({
      type: "tools_snapshot",
      tools: Array.from({ length: 30 }, (_, i) => ({ tool: "bash", toolCallId: `old-${i}` })),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(records.some((record) => record.method === "post")).toBe(false);
    await owner.stop();
    const fresh = recordingSurface();
    await fresh.owner.start();
    for (let i = 0; i < 3; i++)
      await fresh.owner.event({
        type: "tool",
        tool: "bash",
        toolCallId: `new-${i}`,
        status: "completed",
      });
    expect(fresh.records.filter((record) => record.method === "post")).toHaveLength(1);
    await fresh.owner.stop();
  });

  it("refreshes only explicitly verified legacy loading before expiry and stops keepalive during a confirmed hold", async () => {
    vi.useFakeTimers();
    const { owner, records } = recordingSurface("verified-legacy");
    await owner.start();
    await vi.advanceTimersByTimeAsync(95_000);
    const processing = records.filter(
      (record) => record.method === "status" && record.text === "processing",
    );
    expect(processing.length).toBeGreaterThanOrEqual(4);
    await owner.settle({ type: "done", status: "error", authWait: "google" });
    const count = records.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(records).toHaveLength(count);
    expect(records.filter((record) => record.method === "status").at(-1)?.text).toBe("suspended");
    expect(JSON.stringify(records.at(-1)?.blocks)).toContain("neo-ai-still-v1.png");
    expect(records.some((record) => record.text === "white_check_mark")).toBe(false);
    await owner.stop();
  });
});
