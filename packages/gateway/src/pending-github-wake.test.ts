import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingGitHubWakeQueue, type PendingGitHubWakeResult } from "./pending-github-wake.js";
import type { GitHubWebhookEvent } from "./github.js";
import type { QueuedEvent } from "./queue.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pending-github-wake-test-"));
  dirs.push(dir);
  return dir;
}

function event(id: string, sourceTs: number): QueuedEvent<GitHubWebhookEvent> {
  return {
    id,
    source: "github",
    correlationKey: "git:branch:thor:feature/refactor",
    payload: {
      event_type: "push",
      ref: "refs/heads/feature/refactor",
      before: "1111111111111111111111111111111111111111",
      after: "2222222222222222222222222222222222222222",
      installation: { id: 1 },
      repository: { full_name: "acme/thor", default_branch: "main" },
      sender: { id: 1001, login: "alice", type: "User" },
    },
    receivedAt: new Date(sourceTs).toISOString(),
    sourceTs,
    readyAt: sourceTs,
    delayMs: 0,
    interrupt: false,
  };
}

function readPendingEvents(dir: string): Array<QueuedEvent<GitHubWebhookEvent>> {
  const files = readdirSync(dir).filter((file) => file.endsWith(".json") && !file.startsWith("."));
  expect(files).toHaveLength(1);
  const pending = JSON.parse(readFileSync(join(dir, files[0]), "utf8")) as {
    events: Array<QueuedEvent<GitHubWebhookEvent>>;
  };
  return pending.events;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PendingGitHubWakeQueue", () => {
  it("preserves newly parked events when an in-flight replay is accepted", async () => {
    const dir = tempDir();
    let resolveReplay!: (result: PendingGitHubWakeResult) => void;
    const handler = vi.fn(
      () => new Promise<PendingGitHubWakeResult>((resolve) => (resolveReplay = resolve)),
    );
    const queue = new PendingGitHubWakeQueue({ dir, disableInterval: true, handler });

    queue.park([event("delivery-1", 1)]);
    const flush = queue.flush();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    queue.park([event("delivery-2", 2)]);
    resolveReplay("accepted");
    await flush;

    expect(readPendingEvents(dir)).toMatchObject([{ id: "delivery-2" }]);
    queue.close();
  });

  it("preserves newly parked events when an in-flight replay remains busy", async () => {
    const dir = tempDir();
    let resolveReplay!: (result: PendingGitHubWakeResult) => void;
    const handler = vi.fn(
      () => new Promise<PendingGitHubWakeResult>((resolve) => (resolveReplay = resolve)),
    );
    const queue = new PendingGitHubWakeQueue({ dir, disableInterval: true, handler });

    queue.park([event("delivery-1", 1)]);
    const flush = queue.flush();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    queue.park([event("delivery-2", 2)]);
    resolveReplay("busy");
    await flush;

    expect(readPendingEvents(dir)).toMatchObject([{ id: "delivery-1" }, { id: "delivery-2" }]);
    queue.close();
  });
});
