import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSchemas, MetabaseError } from "./metabase.ts";

// Exercises the real client so the HTTP-status → userFailure classification is
// proven structurally (no message parsing). listSchemas drives the shared GET
// helper, so its verdict covers every read path.
describe("metabase client failure classification", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.METABASE_URL = "https://metabase.test";
    process.env.METABASE_API_KEY = "test-key";
    process.env.METABASE_DATABASE_ID = "1";
    process.env.METABASE_ALLOWED_SCHEMAS = "public";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubStatus(status: number): void {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: () => Promise.resolve("upstream body"),
    }) as unknown as typeof fetch;
  }

  it("marks caller-caused 4xx requests as user failures", async () => {
    for (const status of [400, 404, 422]) {
      stubStatus(status);
      const err = await listSchemas().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MetabaseError);
      expect((err as MetabaseError).userFailure).toBe(true);
      expect((err as MetabaseError).status).toBe(status);
    }
  });

  it("keeps auth, rate-limit, and 5xx as service faults", async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      stubStatus(status);
      const err = await listSchemas().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MetabaseError);
      expect((err as MetabaseError).userFailure).toBe(false);
      expect((err as MetabaseError).status).toBe(status);
    }
  });
});
