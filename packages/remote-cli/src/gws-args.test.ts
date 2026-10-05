import { describe, expect, it } from "vitest";

import { parseGwsArgs } from "./gws-args.js";

describe("parseGwsArgs", () => {
  it("preserves non-auth commands exactly", () => {
    const args = ["drive", "files", "update", "--json", '{"name":"Report"}'];
    expect(parseGwsArgs(args)).toEqual({ ok: true, args });
  });

  it("blocks every agent-facing credential-management command", () => {
    for (const args of [
      ["auth"],
      ["auth", "login"],
      ["auth", "logout"],
      ["auth", "export", "--unmasked"],
    ]) {
      expect(parseGwsArgs(args)).toMatchObject({
        ok: false,
        error: { _tag: "GwsAuthCommandDenied" },
      });
    }
  });

  it("blocks local filesystem input/output surfaces", () => {
    for (const args of [
      ["drive", "files", "create", "--upload", "/var/lib/remote-cli/private"],
      ["drive", "+upload", "/tmp/file"],
      ["drive", "+download", "FILE_ID"],
      ["docs", "documents", "get", "--output=/tmp/result"],
      ["schema", "@/workspace/request.json"],
      ["drive", "files", "list", "--config-dir", "/workspace/config"],
      ["drive", "files", "list", "--client-secret=attacker"],
    ]) {
      expect(parseGwsArgs(args)).toMatchObject({
        ok: false,
        error: { _tag: "GwsLocalFileCommandDenied" },
      });
    }
  });

  it("accepts only the exact broker download shape with a bounded opaque ID", () => {
    for (const id of ["A_z-09", "a".repeat(256)]) {
      const args = ["drive", "+download", "--file-id", id];
      expect(parseGwsArgs(args)).toEqual({ ok: true, args });
    }
    for (const args of [
      ["drive", "+download", "--file-id", ""],
      ["drive", "+download", "--file-id", "a".repeat(257)],
      ["drive", "+download", "--file-id", "root"],
      ["drive", "+download", "--file-id", "../private"],
      ["drive", "+download", "--file-id", "id?alt=media"],
      ["drive", "+download", "--file-id=abc"],
      ["drive", "+download", "--file-id", "abc", "--recursive"],
      ["drive", "+download", "--file-id", "abc", "--output", "/tmp/out"],
      ["drive", "+download", "--file-id", "abc", "--token=dummy-secret"],
      ["docs", "+download", "--file-id", "abc"],
      ["drive", "+Download", "--file-id", "abc"],
      ["drive", "--file-id", "abc", "+download"],
      ["drive", "files", "get", "--file-id", "abc"],
    ])
      expect(parseGwsArgs(args)).toMatchObject({
        ok: false,
        error: { _tag: "GwsLocalFileCommandDenied" },
      });
  });

  it("rejects malformed argv and NUL bytes", () => {
    for (const args of [undefined, null, {}, [1], ["drive\0files"], ["drive", null]]) {
      expect(parseGwsArgs(args)).toMatchObject({
        ok: false,
        error: { _tag: "GwsArgsError" },
      });
    }
  });
});
