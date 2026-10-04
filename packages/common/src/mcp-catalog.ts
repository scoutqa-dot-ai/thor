import { z } from "zod";
import { isIP } from "node:net";
import { PROXY_NAMES } from "./proxies.js";
import type { ProxyConfig } from "./workspace-config.js";

const reservedAliases = new Set([
  ...Object.getOwnPropertyNames(Object.prototype).map((name) => name.toLowerCase()),
  "prototype",
  "resolve",
  "status",
  "result",
  "list",
  "help",
  "search",
  "call",
  "approval",
  "mcp",
  "catalog",
  "mcp-catalog",
  "validate",
  "check",
  "schema",
  "approve",
  "reject",
  "approved",
  "rejected",
  "git",
  "gh",
  "gws",
  "scoutqa",
  "langfuse",
  "metabase",
  "ldcli",
  "drata",
  "sandbox",
  "slack-post-message",
  "slack-upload",
]);
const AliasSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/)
  .refine((name) => !reservedAliases.has(name));
const ToolNameSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
const SecretBasenameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const AuthSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("bearer"), secretFile: SecretBasenameSchema }),
]);
function isInternalHttpHost(host: string): boolean {
  if (host === "[::1]" || host === "localhost") return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return isIP(host) === 0 && /^[a-z][a-z0-9-]*$/.test(host);
}
const UrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!/^https?:\/\//.test(value)) return false;
    try {
      if (/[\s\\${}<>]|\p{Cc}|\p{Cf}/u.test(decodeURIComponent(value))) return false;
      const url = new URL(value);
      return (
        !!url.hostname &&
        !url.username &&
        !url.password &&
        !value.includes("?") &&
        !value.includes("#")
      );
    } catch {
      return false;
    }
  });
const ServerSchema = z
  .strictObject({
    transport: z.literal("streamable-http"),
    url: UrlSchema,
    description: z
      .string()
      .min(1)
      .max(1000)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    auth: AuthSchema,
    http: z
      .strictObject({
        type: z.literal("internal-unauthenticated"),
        operatorReviewed: z.literal(true),
      })
      .optional(),
    policy: z.strictObject({
      allow: z.array(ToolNameSchema).max(128),
      approve: z.array(ToolNameSchema).max(128),
    }),
  })
  .superRefine((server, ctx) => {
    const names = [...server.policy.allow, ...server.policy.approve];
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: "custom", message: "duplicate or overlapping policy" });
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      return;
    }
    if (
      url.protocol === "http:"
        ? !server.http || server.auth.type !== "none" || !isInternalHttpHost(url.hostname)
        : !!server.http
    )
      ctx.addIssue({
        code: "custom",
        message: "HTTP requires reviewed internal unauthenticated contract",
      });
  });
const CatalogSchema = z
  .strictObject({
    version: z.literal(1),
    servers: z
      .record(AliasSchema, ServerSchema)
      .refine((servers) => Object.keys(servers).length <= 32),
    disabled: z.array(AliasSchema).max(38),
  })
  .superRefine((catalog, ctx) => {
    const builtin = new Set<string>(PROXY_NAMES);
    if (Object.keys(catalog.servers).some((name) => builtin.has(name)))
      ctx.addIssue({ code: "custom", message: "builtin collision" });
    if (
      new Set(catalog.disabled).size !== catalog.disabled.length ||
      catalog.disabled.some((name) => !builtin.has(name) && !Object.hasOwn(catalog.servers, name))
    )
      ctx.addIssue({ code: "custom", message: "unknown or duplicate disabled alias" });
  });

/** Parsed operator catalog: complete custom definitions, never a credential overlay. */
export type McpOperatorCatalog = z.infer<typeof CatalogSchema>;
/** Active policy lookup is broker-owned; omitted catalog preserves the six legacy defaults. */
export type McpProxyCatalog = Readonly<Record<string, ProxyConfig>>;
/** Safe catalog failure tags intentionally contain no input fragments or credential references. */
export type McpCatalogParseResult =
  | { readonly ok: true; readonly value: McpOperatorCatalog }
  | { readonly ok: false; readonly reason: "invalid_json" | "invalid_catalog" };

// JSON.parse discards duplicate keys. Scan decoded key spellings first, including escaped aliases.
function rejectDuplicateJsonKeys(raw: string): void {
  let at = 0;
  const whitespace = () => {
    while (/\s/.test(raw[at] ?? "") && at < raw.length) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < raw.length) {
      if (raw[at++] === '"') return JSON.parse(raw.slice(start, at));
      if (raw[at - 1] === "\\") at++;
    }
    throw new Error("Invalid catalog JSON string");
  };
  const value = (depth: number): void => {
    if (depth > 32) throw new Error("Catalog JSON nesting unsupported");
    whitespace();
    const first = raw[at++];
    if (first === "{") {
      const keys = new Set<string>();
      whitespace();
      if (raw[at] === "}") {
        at++;
        return;
      }
      while (at < raw.length) {
        whitespace();
        if (raw[at] !== '"') throw new Error("Invalid catalog JSON key");
        const key = string();
        if (keys.has(key)) throw new Error("Duplicate catalog JSON key");
        keys.add(key);
        whitespace();
        if (raw[at++] !== ":") throw new Error("Invalid catalog JSON colon");
        value(depth + 1);
        whitespace();
        const end = raw[at++];
        if (end === "}") return;
        if (end !== ",") throw new Error("Invalid catalog JSON separator");
      }
    } else if (first === "[") {
      whitespace();
      if (raw[at] === "]") {
        at++;
        return;
      }
      while (at < raw.length) {
        value(depth + 1);
        whitespace();
        const end = raw[at++];
        if (end === "]") return;
        if (end !== ",") throw new Error("Invalid catalog JSON separator");
      }
    } else if (first === '"') {
      at--;
      string();
      return;
    } else {
      while (at < raw.length && !/[\s,}\]]/.test(raw[at])) at++;
      return;
    }
    throw new Error("Incomplete catalog JSON");
  };
  value(0);
  whitespace();
  if (at !== raw.length) throw new Error("Invalid catalog JSON trailing data");
}

/** Parse strict version 1 JSON, rejecting duplicate keys before Zod can lose that evidence. */
export function parseMcpOperatorCatalog(raw: string): McpCatalogParseResult {
  let input: unknown;
  try {
    if (Buffer.byteLength(raw) > 256 * 1024) return { ok: false, reason: "invalid_catalog" };
    rejectDuplicateJsonKeys(raw);
    input = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  // Zod records intentionally skip __proto__; inspect original decoded keys before record parsing.
  if (
    typeof input === "object" &&
    input !== null &&
    "servers" in input &&
    typeof input.servers === "object" &&
    input.servers !== null &&
    Object.keys(input.servers).some((alias) => !AliasSchema.safeParse(alias).success)
  )
    return { ok: false, reason: "invalid_catalog" };
  const safeKeys = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null) return true;
    return Object.entries(value).every(
      ([key, child]) => !["__proto__", "constructor", "prototype"].includes(key) && safeKeys(child),
    );
  };
  if (!safeKeys(input)) return { ok: false, reason: "invalid_catalog" };
  const result = CatalogSchema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, reason: "invalid_catalog" };
}

/** Operator JSON Schema comes from the owning parser; semantic refinements still require validation. */
export function mcpOperatorCatalogJsonSchema(): unknown {
  return z.toJSONSchema(CatalogSchema);
}
