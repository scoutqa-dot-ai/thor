import type { PendingQueueSnapshot } from "./queue.ts";

interface ServiceHealth {
  status: "ok" | "error";
  [key: string]: unknown;
}

interface QueueHealth {
  status: "ok" | "error";
  pendingCount: number;
  staleThresholdMs: number;
  staleEventCount: number;
  error?: string;
  oldestPendingReceivedAt?: string;
  oldestPendingAgeMs?: number;
}

const DEFAULT_QUEUE_STALE_THRESHOLD_MS = 15 * 60 * 1000;

export interface HealthCheckResult {
  status: "ok" | "error";
  service: "gateway";
  services: Record<string, ServiceHealth>;
  queue?: QueueHealth;
}

async function checkService(url: string, fetchImpl?: typeof fetch): Promise<ServiceHealth> {
  const fetchFn = fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return { status: "error", error: `HTTP ${res.status}` };
    }
    const json = (await res.json()) as Record<string, unknown>;
    return { status: "ok", ...json };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

export interface HealthCheckDeps {
  runnerUrl: string;
  remoteCliHost: string;
  remoteCliPort: number;
  fetchImpl?: typeof fetch;
  queueSnapshot?: PendingQueueSnapshot;
  queueStaleThresholdMs?: number;
}

function checkQueueHealth(
  snapshot: PendingQueueSnapshot | undefined,
  staleThresholdMs: number,
): QueueHealth | undefined {
  if (!snapshot) return undefined;

  if (snapshot.readError) {
    return {
      status: "error",
      pendingCount: snapshot.pendingCount,
      staleThresholdMs,
      staleEventCount: 0,
      error: `queue snapshot failed: ${snapshot.readError}`,
    };
  }

  const now = Date.now();
  let staleEventCount = 0;
  let oldestPendingReceivedAt: string | undefined;
  let oldestPendingAgeMs: number | undefined;

  for (const event of snapshot.pending) {
    const receivedAtMs = Date.parse(event.receivedAt);
    if (!Number.isFinite(receivedAtMs)) continue;

    const ageMs = now - receivedAtMs;
    if (oldestPendingAgeMs === undefined || ageMs > oldestPendingAgeMs) {
      oldestPendingAgeMs = ageMs;
      oldestPendingReceivedAt = event.receivedAt;
    }
    if (ageMs > staleThresholdMs) staleEventCount++;
  }

  return {
    status: staleEventCount > 0 ? "error" : "ok",
    pendingCount: snapshot.pendingCount,
    staleThresholdMs,
    staleEventCount,
    ...(oldestPendingReceivedAt ? { oldestPendingReceivedAt } : {}),
    ...(oldestPendingAgeMs !== undefined ? { oldestPendingAgeMs } : {}),
  };
}

export async function deepHealthCheck(deps: HealthCheckDeps): Promise<HealthCheckResult> {
  const remoteCliUrl = `http://${deps.remoteCliHost}:${deps.remoteCliPort}`;

  const [runner, remoteCli] = await Promise.all([
    checkService(deps.runnerUrl, deps.fetchImpl),
    checkService(remoteCliUrl, deps.fetchImpl),
  ]);

  const services = { runner, "remote-cli": remoteCli };
  const queue = checkQueueHealth(
    deps.queueSnapshot,
    deps.queueStaleThresholdMs ?? DEFAULT_QUEUE_STALE_THRESHOLD_MS,
  );
  const allServicesOk = Object.values(services).every((s) => s.status === "ok");
  const queueOk = !queue || queue.status === "ok";

  return {
    status: allServicesOk && queueOk ? "ok" : "error",
    service: "gateway",
    services,
    ...(queue ? { queue } : {}),
  };
}
