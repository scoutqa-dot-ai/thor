import { mkdtemp, writeFile, truncate, rm, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBoundedExecutorFile } from "./bounded-binary-read.js";
import { PI_IMAGE_MAX_BYTES } from "./execution-protocol.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-bounded-read-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("opened-file bounded binary read", () => {
  it("returns exact-limit bytes and rejects one extra byte", async () => {
    const path = join(directory, "image");
    await writeFile(path, Buffer.from([0, 1, 255, 3]));
    expect(await readBoundedExecutorFile(path, 4, BACKGROUND_CONTEXT)).toEqual({
      ok: true,
      value: { data: "AAH/Aw==" },
    });
    expect(await readBoundedExecutorFile(path, 3, BACKGROUND_CONTEXT)).toEqual({
      ok: true,
      value: { tooLarge: true },
    });
  });

  it("never allocates from an adversarial sparse file's size and rejects caller limit escalation", async () => {
    const path = join(directory, "huge");
    await writeFile(path, "");
    await truncate(path, 1024 ** 4);
    const before = process.memoryUsage().arrayBuffers;
    expect(await readBoundedExecutorFile(path, 32, BACKGROUND_CONTEXT)).toEqual({
      ok: true,
      value: { tooLarge: true },
    });
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(1024 * 1024);
    for (const limit of [0, -1, Number.MAX_SAFE_INTEGER, PI_IMAGE_MAX_BYTES + 1]) {
      expect(await readBoundedExecutorFile(path, limit, BACKGROUND_CONTEXT)).toMatchObject({
        ok: false,
        error: { code: "invalid" },
      });
    }
  });

  it("checks the opened file is regular and sanitizes missing-file failures", async () => {
    expect(await readBoundedExecutorFile(directory, 32, BACKGROUND_CONTEXT)).toMatchObject({
      ok: false,
      error: { code: "not_supported" },
    });
    expect(
      await readBoundedExecutorFile(join(directory, "missing"), 32, BACKGROUND_CONTEXT),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await readBoundedExecutorFile("/dev/zero", 32, BACKGROUND_CONTEXT)).toMatchObject({
      ok: false,
      error: { code: "not_supported" },
    });
  });

  it("honors cancellation before/during an opened-file read and closes its file handle", async () => {
    const path = join(directory, "large");
    await writeFile(path, "");
    await truncate(path, PI_IMAGE_MAX_BYTES);
    const early = new AbortController();
    early.abort();
    expect(
      await readBoundedExecutorFile(
        path,
        PI_IMAGE_MAX_BYTES,
        withAbortSignal(early.signal, BACKGROUND_CONTEXT),
      ),
    ).toMatchObject({ ok: false, error: { code: "aborted" } });
    const controller = new AbortController();
    const read = readBoundedExecutorFile(
      path,
      PI_IMAGE_MAX_BYTES,
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    );
    setImmediate(() => controller.abort());
    expect(await read).toMatchObject({ ok: false, error: { code: "aborted" } });
    // Linux is the supported executor platform; a cancelled read must not retain an opened image fd.
    const targets = await Promise.all(
      (await readdir("/proc/self/fd")).map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => "")),
    );
    expect(targets).not.toContain(path);
  });
});
