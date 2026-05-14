import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const adminEmails = ["admin@scoutqa.cc", "owner@scoutqa.cc"];

function locationBlock(config: string, path: string): string {
  const marker = `location ${path} {`;
  const start = config.indexOf(marker);
  expect(start, `missing ${marker}`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  let enteredBlock = false;
  for (let i = start; i < config.length; i += 1) {
    const char = config[i];
    if (char === "{") {
      depth += 1;
      enteredBlock = true;
    }
    if (char === "}") depth -= 1;
    if (enteredBlock && depth === 0) return config.slice(start, i + 1);
  }

  throw new Error(`unterminated ${marker}`);
}

function blockForRequestPath(config: string, requestPath: string): string {
  if (requestPath === "/oc-theme-preload.js")
    return locationBlock(config, "= /oc-theme-preload.js");
  if (requestPath.startsWith("/assets/")) return locationBlock(config, "/assets/");
  if (requestPath.startsWith("/admin/")) return locationBlock(config, "/admin/");
  if (requestPath.startsWith("/runner/")) return locationBlock(config, "/runner/");
  return locationBlock(config, "/");
}

function routeDecision(config: string, requestPath: string, user: string): string {
  const block = blockForRequestPath(config, requestPath);
  expect(block).toContain("auth_request /vouch/validate;");

  if (block.includes("proxy_pass $opencode_admin_upstream;")) {
    return adminEmails.includes(user) ? "opencode" : "403";
  }

  if (block.includes("proxy_pass $admin_admin_upstream;")) {
    return adminEmails.includes(user) ? "admin" : "403";
  }

  if (block.includes("proxy_pass $runner;")) return "runner";

  throw new Error(`unexpected route block for ${requestPath}`);
}

describe("ingress auth split", () => {
  const compose = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf8");
  const template = readFileSync(resolve(repoRoot, "docker/ingress/nginx.conf.template"), "utf8");

  it("configures Vouch with managed email domains and comma-separated Thor admin emails", () => {
    expect(compose).toContain(
      "VOUCH_DOMAINS=${VOUCH_ALLOWED_EMAIL_DOMAINS:-scoutqa.cc},${VOUCH_COOKIE_DOMAIN:-localhost}",
    );
    expect(compose).not.toContain("VOUCH_WHITELIST=");
    expect(compose).toContain("THOR_ADMIN_EMAILS=${THOR_ADMIN_EMAILS:?set THOR_ADMIN_EMAILS}");
  });

  it("runs the admin-email regex hook before nginx envsubst", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "docker/ingress/Dockerfile"), "utf8");
    const envHook = readFileSync(
      resolve(repoRoot, "docker/ingress/10-thor-admin-emails.envsh"),
      "utf8",
    );
    expect(dockerfile).toContain(
      "COPY 10-thor-admin-emails.envsh /docker-entrypoint.d/10-thor-admin-emails.envsh",
    );
    expect(envHook).not.toContain("set -u");
    expect(envHook).not.toContain("set -- ${THOR_ADMIN_EMAILS}");
  });

  it("gates the OpenCode SPA root by admin email", () => {
    expect(template).toContain('default "http://127.0.0.1:8080/__opencode_admin_forbidden";');

    expect(routeDecision(template, "/", adminEmails[0])).toBe("opencode");
    expect(routeDecision(template, "/", adminEmails[1])).toBe("opencode");
    expect(routeDecision(template, "/", "user@scoutqa.cc")).toBe("403");
  });

  it("bypasses Vouch for static OpenCode assets", () => {
    for (const path of ["/assets/", "= /oc-theme-preload.js"]) {
      const block = locationBlock(template, path);
      expect(block).not.toContain("auth_request");
      expect(block).not.toContain("THOR_ADMIN_EMAILS");
      expect(block).toContain("proxy_pass $opencode;");
    }
  });

  it("gates admin UI routes by admin email", () => {
    expect(routeDecision(template, "/admin/config", adminEmails[0])).toBe("admin");
    expect(routeDecision(template, "/admin/config", adminEmails[1])).toBe("admin");
    expect(routeDecision(template, "/admin/config", "user@scoutqa.cc")).toBe("403");
  });

  it("forwards the public Host to vouch so JWT site-claim checks see the ingress hostname", () => {
    const validate = locationBlock(template, "= /vouch/validate");
    expect(validate).toContain("proxy_set_header Host $http_host;");

    const vouchPublic = locationBlock(template, "/vouch/");
    expect(vouchPublic).toContain("proxy_set_header Host $http_host;");
  });

  it("leaves runner routes domain-authenticated without the OpenCode admin gate", () => {
    const block = locationBlock(template, "/runner/");
    expect(block).toContain("auth_request /vouch/validate;");
    expect(block).toContain("proxy_pass $runner;");
    expect(block).not.toContain("THOR_ADMIN_EMAILS");
    expect(block).not.toContain("return 403");

    expect(routeDecision(template, "/runner/v/anchor/trigger", adminEmails[0])).toBe("runner");
    expect(routeDecision(template, "/runner/v/anchor/trigger", "user@scoutqa.cc")).toBe("runner");
  });
});
