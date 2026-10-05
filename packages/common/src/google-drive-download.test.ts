import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GoogleDriveDownloadSchema,
  GoogleDriveDownloadExecResultSchema,
  GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES,
} from "./google-drive-download.js";

function file(path: string[], bytes = Buffer.from([0, 255, 128])) {
  return {
    kind: "file" as const,
    path,
    mimeType: "application/octet-stream",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    dataBase64: bytes.toString("base64"),
  };
}
function tree() {
  return {
    version: 1,
    rootName: "root",
    skipped: [],
    entries: [{ kind: "directory", path: ["root"] }, file(["root", "bytes.bin"])],
  };
}

describe("Google Drive download wire contract", () => {
  it("preserves ordinary exec responses and rooted binary/empty-directory manifests", () => {
    expect(
      GoogleDriveDownloadExecResultSchema.parse({ stdout: "help", stderr: "", exitCode: 0 }),
    ).toEqual({ stdout: "help", stderr: "", exitCode: 0 });
    const manifest = tree();
    manifest.entries.push({ kind: "directory", path: ["root", "empty"] });
    expect(GoogleDriveDownloadSchema.parse(manifest)).toEqual(manifest);
    const rootFile = { version: 1, rootName: "single", skipped: [], entries: [file(["single"])] };
    expect(GoogleDriveDownloadSchema.parse(rootFile)).toEqual(rootFile);
  });

  it("round-trips generated binary payloads, independently rejecting noncanonical padding and size claims", () => {
    // Exhaustive small lengths exercise every base64 padding class and non-UTF8 bytes without a new dependency.
    for (let length = 0; length < 256; length++) {
      const bytes = Buffer.from(Array.from({ length }, (_, index) => (index * 43 + length) % 256));
      const entry = file(["binary"], bytes);
      const manifest = { version: 1, rootName: "binary", skipped: [], entries: [entry] };
      const parsed = GoogleDriveDownloadSchema.parse(manifest).entries[0];
      if (parsed.kind !== "file") throw new Error("Binary manifest fixture changed");
      expect(Buffer.from(parsed.dataBase64, "base64")).toEqual(bytes);
      expect(
        GoogleDriveDownloadSchema.safeParse({
          ...manifest,
          entries: [{ ...entry, size: length + 1 }],
        }).success,
      ).toBe(false);
    }
    for (const dataBase64 of ["AB==", "AAB=", "AA", "AA===", "AA==\n", "_w==", "=AAA", "AA=A"])
      expect(
        GoogleDriveDownloadSchema.safeParse({
          version: 1,
          rootName: "binary",
          skipped: [],
          entries: [{ ...file(["binary"], Buffer.alloc(1)), dataBase64 }],
        }).success,
      ).toBe(false);
  });

  it.each([
    ".",
    "..",
    "a/b",
    "a\\b",
    "name\0",
    "name\n",
    "CON",
    "nul.txt",
    "COM¹.txt",
    "LPT²",
    "trailing.",
    "trailing ",
    "a:b",
    "a?b",
    "x".repeat(181),
    "界".repeat(61),
    "e\u0301",
    "\ud800",
  ])("rejects nonportable root/path component %j", (rootName) => {
    expect(
      GoogleDriveDownloadSchema.safeParse({
        version: 1,
        rootName,
        skipped: [],
        entries: [file([rootName])],
      }).success,
    ).toBe(false);
    expect(
      GoogleDriveDownloadSchema.safeParse({
        ...tree(),
        entries: [{ kind: "directory", path: ["root"] }, file(["root", rootName])],
      }).success,
    ).toBe(false);
  });

  it("rejects missing roots, missing parents, foreign roots, duplicates and file parents", () => {
    for (const entries of [
      [file(["root", "child"])],
      [{ kind: "directory", path: ["root"] }, file(["root", "missing", "child"])],
      [{ kind: "directory", path: ["root"] }, file(["other", "child"])],
      [{ kind: "directory", path: ["root"] }, file(["root", "same"]), file(["root", "same"])],
      [file(["root"]), file(["root", "child"])],
    ])
      expect(GoogleDriveDownloadSchema.safeParse({ ...tree(), entries }).success).toBe(false);
  });

  it.each([
    ["same", "Same"],
    ["Straße", "STRASSE"],
    ["σ", "ς"],
  ])("rejects case-fold collisions %s/%s", (first, second) => {
    expect(
      GoogleDriveDownloadSchema.safeParse({
        ...tree(),
        entries: [
          { kind: "directory", path: ["root"] },
          file(["root", first]),
          file(["root", second]),
        ],
      }).success,
    ).toBe(false);
  });

  it("enforces strict versions, entry fields, depth and count ceilings", () => {
    for (const manifest of [
      { ...tree(), version: 2 },
      { ...tree(), unexpected: "ignored?" },
      { ...tree(), entries: [{ ...file(["root"]), url: "https://attacker.example.test" }] },
      { ...tree(), entries: [file(Array.from({ length: 33 }, () => "root"))] },
      {
        ...tree(),
        entries: [
          { kind: "directory", path: ["root"] },
          ...Array.from({ length: 1000 }, (_, index) =>
            file(["root", `child-${index}`], Buffer.alloc(0)),
          ),
        ],
      },
    ])
      expect(GoogleDriveDownloadSchema.safeParse(manifest).success).toBe(false);
  });

  it("bounds decoded totals and skipped records; digest verification is intentionally writer-owned", () => {
    const bytes = Buffer.alloc(26 * 1024 * 1024);
    expect(
      GoogleDriveDownloadSchema.safeParse({
        ...tree(),
        entries: [
          { kind: "directory", path: ["root"] },
          file(["root", "first"], bytes),
          file(["root", "second"], bytes),
        ],
      }).success,
    ).toBe(false);
    const entry = file(["single"]);
    expect(
      GoogleDriveDownloadSchema.safeParse({
        version: 1,
        rootName: "single",
        skipped: [],
        entries: [{ ...entry, size: GOOGLE_DRIVE_DOWNLOAD_MAX_BYTES + 1 }],
      }).success,
    ).toBe(false);
    expect(
      GoogleDriveDownloadSchema.parse({
        version: 1,
        rootName: "single",
        skipped: [],
        entries: [{ ...entry, sha256: "0".repeat(64) }],
      }).entries,
    ).toHaveLength(1);
    for (const skipped of [
      [{ fileId: "shortcut", name: "link", reason: "unsupported" }],
      [{ fileId: "../shortcut", name: "link", reason: "shortcut" }],
      Array.from({ length: 999 }, (_, index) => ({
        fileId: `shortcut-${index}`,
        name: "link",
        reason: "shortcut",
      })),
    ])
      expect(GoogleDriveDownloadSchema.safeParse({ ...tree(), skipped }).success).toBe(false);
  });
});
