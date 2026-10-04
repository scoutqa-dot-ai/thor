import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseMcpOperatorCatalog,
  PROXY_NAMES,
  PROXY_REGISTRY,
  mcpOperatorCatalogJsonSchema,
} from "@thor/common";
import { loadMcpCatalogSnapshot } from "./mcp-catalog-files.js";

const custom = {
  transport: "streamable-http",
  url: "https://docs.example.test/mcp",
  description: "Docs",
  auth: { type: "bearer", secretFile: "docs-token" },
  policy: { allow: ["search_docs"], approve: new Array<string>() },
};
const catalog = () => ({
  version: 1,
  servers: { mydocs: structuredClone(custom) },
  disabled: [] as string[],
});

describe("operator MCP catalog startup authority and credentials", () => {
  let root: string;
  let paths: { catalogDirectory: string; secretsDirectory: string };
  const load = () => loadMcpCatalogSnapshot(paths);
  const write = (value: unknown = catalog()) =>
    writeFileSync(join(paths.catalogDirectory, "catalog.json"), JSON.stringify(value));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "neo-catalog-"));
    paths = { catalogDirectory: join(root, "catalog"), secretsDirectory: join(root, "secrets") };
    mkdirSync(paths.catalogDirectory, { mode: 0o755 });
    mkdirSync(paths.secretsDirectory, { mode: 0o700 });
    writeFileSync(join(paths.secretsDirectory, "docs-token"), "dummy-snapshot-token\n", {
      mode: 0o600,
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("missing/empty optional directories preserve all six exact defaults, malformed present never falls back", () => {
    for (const phase of ["empty", "missing"] as const) {
      if (phase === "missing") rmSync(paths.catalogDirectory, { recursive: true });
      const result = load();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("fixture defaults unavailable");
      expect(Object.keys(result.value.policies)).toEqual(PROXY_NAMES);
      expect(result.value.policies).toEqual(PROXY_REGISTRY);
    }
    mkdirSync(paths.catalogDirectory);
    writeFileSync(join(paths.catalogDirectory, "catalog.json"), "{malformed dummy-secret");
    expect(load()).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("atomic directory-file replacement activates only on a new snapshot; token edits cannot mutate active credentials", () => {
    write();
    const first = load();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("snapshot unavailable");
    const config = first.value.customUpstream("mydocs");
    if (config?.kind !== "http") throw new Error("custom missing");
    expect(config.bearer?.reveal()).toBe("dummy-snapshot-token");
    expect(JSON.stringify(first)).not.toContain("dummy-snapshot-token");
    writeFileSync(join(paths.secretsDirectory, "replacement"), "dummy-rotated-token", {
      mode: 0o400,
    });
    renameSync(
      join(paths.secretsDirectory, "replacement"),
      join(paths.secretsDirectory, "docs-token"),
    );
    const removed = { version: 1, servers: {}, disabled: ["grafana"] };
    writeFileSync(join(paths.catalogDirectory, "replacement.json"), JSON.stringify(removed));
    renameSync(
      join(paths.catalogDirectory, "replacement.json"),
      join(paths.catalogDirectory, "catalog.json"),
    );
    expect(config.bearer?.reveal()).toBe("dummy-snapshot-token");
    expect(first.value.policies.mydocs).toBeDefined();
    const next = load();
    if (!next.ok) throw new Error("second snapshot unavailable");
    expect(next.value.policies.mydocs).toBeUndefined();
    expect(next.value.policies.grafana).toBeUndefined();
    rmSync(join(paths.catalogDirectory, "catalog.json"));
    const defaults = load();
    if (!defaults.ok) throw new Error("default snapshot unavailable");
    expect(Object.keys(defaults.value.policies)).toEqual(PROXY_NAMES);
  });

  it.each([
    "",
    "\n",
    "dummy-token\n\n",
    "dummy-token\r\n",
    "dummy-token\r",
    "dummy-token\nembedded",
    "dummy token",
    "${BROKER_SECRET}",
  ])("rejects malformed token bytes without including input/reference in errors (%j)", (token) => {
    write();
    writeFileSync(join(paths.secretsDirectory, "docs-token"), token);
    expect(load()).toEqual({ ok: false, reason: "credential_unavailable" });
  });
  it.each([
    "missing",
    "symlink",
    "directory",
    "fifo",
    "hardlink",
    "public-file",
    "executable-file",
    "special-file",
    "public-directory",
  ])("rejects unsafe credential filesystem authority: %s", (failure) => {
    write();
    const file = join(paths.secretsDirectory, "docs-token");
    if (["missing", "symlink", "directory", "fifo"].includes(failure)) rmSync(file);
    if (failure === "symlink") {
      writeFileSync(join(root, "outside-token"), "dummy-outside");
      symlinkSync(join(root, "outside-token"), file);
    }
    if (failure === "directory") mkdirSync(file);
    if (failure === "fifo") execFileSync("mkfifo", [file]);
    if (failure === "hardlink") linkSync(file, join(root, "token-link"));
    if (failure === "special-file") chmodSync(file, 0o4600);
    if (failure === "public-file") chmodSync(file, 0o644);
    if (failure === "executable-file") chmodSync(file, 0o700);
    if (failure === "public-directory") chmodSync(paths.secretsDirectory, 0o755);
    expect(load()).toEqual({ ok: false, reason: "credential_unavailable" });
  });
  it("disabled custom credentials are not read and custom approve remains approval policy, never allow", () => {
    const value = catalog();
    value.disabled = ["mydocs", "grafana"];
    write(value);
    rmSync(paths.secretsDirectory, { recursive: true });
    const result = load();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.policies.mydocs).toBeUndefined();
    value.servers.mydocs.policy.approve.push("write_doc");
    write(value);
    expect(load().ok).toBe(true);
    mkdirSync(paths.secretsDirectory, { mode: 0o700 });
    writeFileSync(join(paths.secretsDirectory, "docs-token"), "dummy-token", { mode: 0o600 });
    value.disabled = [];
    write(value);
    const enabled = load();
    expect(enabled.ok).toBe(true);
    if (enabled.ok) expect(enabled.value.policies.mydocs.approve).toEqual(["write_doc"]);
  });
  it("present unreadable/symlink/nonregular catalog fails, including dangling directory symlinks", () => {
    write();
    chmodSync(join(paths.catalogDirectory, "catalog.json"), 0);
    expect(load().ok).toBe(false);
    rmSync(join(paths.catalogDirectory, "catalog.json"));
    symlinkSync(join(root, "missing"), join(paths.catalogDirectory, "catalog.json"));
    expect(load().ok).toBe(false);
    rmSync(paths.catalogDirectory, { recursive: true });
    symlinkSync(join(root, "missing-directory"), paths.catalogDirectory);
    expect(load().ok).toBe(false);
  });
});

describe("strict MCP catalog JSON parser", () => {
  it.each([
    '{"version":1,"version":1,"servers":{},"disabled":[]}',
    '{"version":1,"servers":{"mydocs":{},"my\\u0064ocs":{}},"disabled":[]}',
    '{"version":1,"servers":{},"disabled":[],"disabled":[]}',
  ])("rejects duplicate decoded JSON keys: %s", (raw) =>
    expect(parseMcpOperatorCatalog(raw)).toEqual({ ok: false, reason: "invalid_json" }),
  );
  it.each([
    { ...catalog(), version: 2 },
    { ...catalog(), unknown: "dummy-secret" },
    { ...catalog(), disabled: ["typo"] },
    { ...catalog(), disabled: ["grafana", "grafana"] },
    ...[
      "atlassian",
      "__proto__",
      "constructor",
      "prototype",
      "resolve",
      "list",
      "--help",
      "a/b",
      "a.b",
      "a".repeat(41),
    ].map((alias) => ({ ...catalog(), servers: { [alias]: custom } })),
    ...["allow", "approve"].map((list) => ({
      ...catalog(),
      servers: {
        mydocs: {
          ...custom,
          policy: { allow: ["search_docs"], approve: [], [list]: ["search_docs", "search_docs"] },
        },
      },
    })),
    ...["*", "search*", "tool/exec"].map((tool) => ({
      ...catalog(),
      servers: { mydocs: { ...custom, policy: { allow: [tool], approve: [] } } },
    })),
    ...["stdio", "kali-api", "onepassword-browser"].map((transport) => ({
      ...catalog(),
      servers: { mydocs: { ...custom, transport } },
    })),
    ...[
      "https://user:dummy-secret@docs.test/mcp",
      "https://docs.test/mcp?token=dummy-secret",
      "https://docs.test/mcp#secret",
      "https://docs.test/${TOKEN}",
      "https://docs.test/\npath",
      "https://docs.test/%0dpath",
      "https://docs.test/%7Btenant%7D",
      "https://docs.test/%24%7BENV%7D",
      "https://docs.test/\u0085path",
      "https://docs.test/%E2%80%8Bpath",
      "https://docs.test/\\path",
      "//docs.test/mcp",
      "http://docs.test/mcp",
    ].map((url) => ({ ...catalog(), servers: { mydocs: { ...custom, url } } })),
    ...["../token", "/token", "token.txt", "token/child", "${ENV}", "!command"].map(
      (secretFile) => ({
        ...catalog(),
        servers: { mydocs: { ...custom, auth: { type: "bearer", secretFile } } },
      }),
    ),
    {
      ...catalog(),
      servers: { mydocs: { ...custom, headers: { Authorization: "${BROKER_SECRET}" } } },
    },
    {
      ...catalog(),
      servers: { mydocs: { ...custom, auth: { type: "env", variable: "BROKER_SECRET" } } },
    },
  ])("fails closed on invalid authority/policy without echoing input", (value) =>
    expect(parseMcpOperatorCatalog(JSON.stringify(value))).toEqual({
      ok: false,
      reason: "invalid_catalog",
    }),
  );
  it("permits only explicit operator-reviewed internal unauthenticated HTTP, never HTTP bearer or public HTTP", () => {
    const server = {
      ...custom,
      url: "http://fixture:8000/mcp",
      auth: { type: "none" },
      http: { type: "internal-unauthenticated", operatorReviewed: true },
    };
    expect(
      parseMcpOperatorCatalog(JSON.stringify({ ...catalog(), servers: { localdocs: server } })).ok,
    ).toBe(true);
    for (const bad of [
      { ...server, auth: custom.auth },
      { ...server, url: "http://public.example.com/mcp" },
      { ...server, http: { ...server.http, operatorReviewed: false } },
    ])
      expect(
        parseMcpOperatorCatalog(JSON.stringify({ ...catalog(), servers: { localdocs: bad } })).ok,
      ).toBe(false);
    expect(JSON.stringify(mcpOperatorCatalogJsonSchema())).toContain(
      '"additionalProperties":false',
    );
  });
});
