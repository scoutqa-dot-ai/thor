import { constants, openSync, closeSync, readFileSync, fstatSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { PROXY_REGISTRY, parseMcpOperatorCatalog, type McpProxyCatalog } from "@thor/common";
import type { UpstreamConfig } from "./upstream.js";

/** Fixed optional broker-only directory; no catalog path environment variable. */
export const MCP_CATALOG_DIRECTORY = "/etc/thor/mcp-catalog";
/** Token basenames resolve only inside this private broker-only directory. */
export const MCP_SECRETS_DIRECTORY = "/run/secrets/thor-mcp";

/** Immutable bearer credential snapshot; serialization and inspection never unwrap the value. */
export class McpBearerCredential {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  /** Only the upstream HTTP I/O owner may unwrap this token. */
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return "[REDACTED]";
  }
}

/** Safe startup/local validation failure; no raw filesystem/parser/vendor error crosses this edge. */
export type McpCatalogLoadResult =
  | { readonly ok: true; readonly value: McpCatalogSnapshot }
  | {
      readonly ok: false;
      readonly reason:
        | "catalog_unreadable"
        | "invalid_json"
        | "invalid_catalog"
        | "credential_unavailable";
    };

/** One activation owns policy and private upstream configs, without reading files during reconnect. */
class BrokerMcpCatalogSnapshot {
  readonly policies: McpProxyCatalog;
  readonly present: boolean;
  readonly #upstreams: ReadonlyMap<string, UpstreamConfig>;
  constructor(
    policies: McpProxyCatalog,
    upstreams: ReadonlyMap<string, UpstreamConfig>,
    present: boolean,
  ) {
    this.policies = policies;
    this.#upstreams = upstreams;
    this.present = present;
  }
  /** Custom transport lookup cannot resolve built-in env headers or managed implementations. */
  customUpstream(name: string): UpstreamConfig | undefined {
    return this.#upstreams.get(name);
  }
}

/** Only the local catalog loader constructs activation snapshots; callers cannot build a partial overlay. */
export type McpCatalogSnapshot = BrokerMcpCatalogSnapshot;

function readBoundedFile(path: string, maxBytes: number, privateToken: boolean): string {
  // O_NONBLOCK ensures a malicious FIFO cannot hang startup; fstat rejects it before reading.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes || !stat.size)
      throw new Error("MCP file unsupported");
    if (!privateToken && stat.mode & 0o022) throw new Error("MCP catalog permissions unsupported");
    if (
      privateToken &&
      (stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7177) !== 0 ||
        !(stat.mode & 0o400) ||
        stat.nlink !== 1)
    )
      throw new Error("MCP token permissions unsupported");
    const raw = readFileSync(fd, "utf8");
    if (Buffer.byteLength(raw) > maxBytes) throw new Error("MCP file oversized");
    return raw;
  } finally {
    closeSync(fd);
  }
}

function openDirectory(path: string, privateTokens: boolean): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const stat = fstatSync(fd);
  if (
    stat.mode & 0o022 ||
    (privateTokens &&
      (stat.uid !== process.getuid?.() || stat.mode & 0o7077 || (stat.mode & 0o500) !== 0o500))
  ) {
    closeSync(fd);
    throw new Error("MCP directory permissions unsupported");
  }
  return fd;
}
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function freezePolicies(
  policies: Record<string, import("@thor/common").ProxyConfig>,
): McpProxyCatalog {
  for (const policy of Object.values(policies)) {
    Object.freeze(policy.allow);
    Object.freeze(policy.approve);
    if (policy.upstream.headers) Object.freeze(policy.upstream.headers);
    Object.freeze(policy.upstream);
    Object.freeze(policy);
  }
  return Object.freeze(policies);
}

/** Read optional local config and enabled credentials only; never connects or logs private input. */
export function loadMcpCatalogSnapshot(
  paths: { catalogDirectory: string; secretsDirectory: string } = {
    catalogDirectory: MCP_CATALOG_DIRECTORY,
    secretsDirectory: MCP_SECRETS_DIRECTORY,
  },
): McpCatalogLoadResult {
  let directoryFd: number | undefined;
  let raw: string;
  try {
    // lstat distinguishes a missing file from a present dangling symlink. No fallback on unreadable input.
    lstatSync(join(paths.catalogDirectory, "catalog.json"));
    directoryFd = openDirectory(paths.catalogDirectory, false);
    raw = readBoundedFile(`/proc/self/fd/${directoryFd}/catalog.json`, 256 * 1024, false);
  } catch (error) {
    if (directoryFd === undefined && isMissing(error)) {
      // A symlinked catalog directory is never an optional missing catalog.
      try {
        if (lstatSync(paths.catalogDirectory).isSymbolicLink())
          return { ok: false, reason: "catalog_unreadable" };
      } catch (parentError) {
        if (!isMissing(parentError)) return { ok: false, reason: "catalog_unreadable" };
      }
      return {
        ok: true,
        value: new BrokerMcpCatalogSnapshot(
          freezePolicies(structuredClone(PROXY_REGISTRY)),
          new Map(),
          false,
        ),
      };
    }
    return { ok: false, reason: "catalog_unreadable" };
  } finally {
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
  const parsed = parseMcpOperatorCatalog(raw);
  if (!parsed.ok) return parsed;
  const policies: Record<string, import("@thor/common").ProxyConfig> =
    structuredClone(PROXY_REGISTRY);
  const upstreams = new Map<string, UpstreamConfig>();
  let secretDirectoryFd: number | undefined;
  try {
    for (const [alias, server] of Object.entries(parsed.value.servers)) {
      if (parsed.value.disabled.includes(alias)) continue;
      let bearer: McpBearerCredential | undefined;
      if (server.auth.type === "bearer") {
        secretDirectoryFd ??= openDirectory(paths.secretsDirectory, true);
        const rawToken = readBoundedFile(
          `/proc/self/fd/${secretDirectoryFd}/${server.auth.secretFile}`,
          16 * 1024,
          true,
        );
        // Permit exactly one terminal LF (common editor output). CR, embedded LF, whitespace and empty tokens fail.
        const token = rawToken.endsWith("\n") ? rawToken.slice(0, -1) : rawToken;
        if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(token))
          return { ok: false, reason: "credential_unavailable" };
        bearer = new McpBearerCredential(token);
      }
      policies[alias] = {
        upstream: { url: server.url, transport: "streamable-http" },
        allow: [...server.policy.allow],
        approve: [],
      };
      upstreams.set(
        alias,
        Object.freeze({ kind: "http", url: server.url, ...(bearer ? { bearer } : {}) }),
      );
    }
    for (const alias of parsed.value.disabled) delete policies[alias];
    return {
      ok: true,
      value: new BrokerMcpCatalogSnapshot(freezePolicies(policies), upstreams, true),
    };
  } catch {
    return { ok: false, reason: "credential_unavailable" };
  } finally {
    if (secretDirectoryFd !== undefined) closeSync(secretDirectoryFd);
  }
}
