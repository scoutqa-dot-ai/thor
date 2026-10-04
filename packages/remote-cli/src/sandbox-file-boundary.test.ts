import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { overlayDirtyFiles, _testing } from "./sandbox.js";
import { readBrokerSharedFile, withBrokerSharedFiles } from "./broker-shared-file.js";

const boundary = vi.hoisted(() => ({ upload: vi.fn() }));
// Only the external cloud boundary is substituted; git, files, policy and pinned reads are real.
vi.mock("@daytonaio/sdk", () => ({
  Daytona: class {
    async get() {
      return { fs: { uploadFiles: boundary.upload } };
    }
  },
}));

describe("broker shared files and cloud sandbox upload credential boundary", () => {
  let root: string;
  let cwd: string;
  let privateToken: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "neo-shared-files-"));
    cwd = join(root, "worktree");
    mkdirSync(cwd);
    privateToken = join(root, "private-token");
    writeFileSync(privateToken, "dummy-broker-private-token");
    execFileSync("git", ["init", "-q", cwd]);
    vi.stubEnv("DAYTONA_API_KEY", "dummy-daytona-token");
    _testing.resetDaytona();
    boundary.upload.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    _testing.resetDaytona();
    rmSync(root, { recursive: true, force: true });
  });

  it("uploads normal text/binary worktree artifacts through pinned descriptors and preserves names/content", async () => {
    const binary = Buffer.from([0, 255, 1, 3]);
    writeFileSync(join(cwd, "a.bin"), binary);
    writeFileSync(join(cwd, "b.txt"), "ordinary workflow");
    const content: Buffer[] = [];
    boundary.upload.mockImplementation(async (files: { source: string; destination: string }[]) => {
      await Promise.resolve();
      expect(files.map((file) => file.destination)).toEqual([
        "/workspace/sandbox/a.bin",
        "/workspace/sandbox/b.txt",
      ]);
      content.push(...files.map((file) => readFileSync(file.source)));
    });
    expect(await overlayDirtyFiles("fixture", cwd)).toEqual({
      pushed: ["a.bin", "b.txt"],
      deleted: [],
    });
    expect(content).toEqual([binary, Buffer.from("ordinary workflow")]);
  });
  it("denies private/proc symlink uploads before any SDK read, including a mixed safe/unsafe batch", async () => {
    writeFileSync(join(cwd, "a-safe"), "safe");
    symlinkSync(privateToken, join(cwd, "z-private"));
    await expect(overlayDirtyFiles("fixture", cwd)).rejects.toThrow(
      "Sandbox file boundary rejected",
    );
    expect(boundary.upload).not.toHaveBeenCalled();
    rmSync(join(cwd, "z-private"));
    symlinkSync("/proc/self/environ", join(cwd, "z-proc"));
    await expect(overlayDirtyFiles("fixture", cwd)).rejects.toThrow(
      "Sandbox file boundary rejected",
    );
    expect(boundary.upload).not.toHaveBeenCalled();
  });
  it("a path swapped to a token after validation cannot change the SDK's opened upload inode", async () => {
    const original = join(cwd, "report");
    writeFileSync(original, "reviewed artifact");
    boundary.upload.mockImplementation(async ([file]: { source: string }[]) => {
      renameSync(original, join(root, "old-report"));
      symlinkSync(privateToken, original);
      expect(readFileSync(file.source, "utf8")).toBe("reviewed artifact");
    });
    await overlayDirtyFiles("fixture", cwd);
    expect(boundary.upload).toHaveBeenCalledOnce();
  });
  it("shared text reads and pinned leases reject parent symlinks, nonregular files and outside roots", async () => {
    symlinkSync(root, join(cwd, "escape"));
    expect(readBrokerSharedFile(join(cwd, "escape", "private-token"), [cwd], 1024)).toEqual({
      ok: false,
    });
    expect(readBrokerSharedFile(cwd, [cwd], 1024)).toEqual({ ok: false });
    expect(readBrokerSharedFile(privateToken, [cwd], 1024)).toEqual({ ok: false });
    const consume = vi.fn();
    expect(await withBrokerSharedFiles([privateToken], [cwd], 1024, consume)).toEqual({
      ok: false,
    });
    expect(consume).not.toHaveBeenCalled();
    writeFileSync(join(cwd, "blocks.json"), '[{"type":"divider"}]');
    expect(readBrokerSharedFile(join(cwd, "blocks.json"), [cwd], 1024)).toEqual({
      ok: true,
      value: '[{"type":"divider"}]',
    });
  });
});
