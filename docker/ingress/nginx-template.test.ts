import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const adminEmails = ["admin@scoutqa.cc", "owner@scoutqa.cc"];

const codexLbDashboardLocation =
  "~ ^/(dashboard|accounts|settings|api/(accounts|api-keys|automations|conversation-archive|dashboard|dashboard-auth|firewall|model-sources|models|oauth|quota-planner|reports|request-logs|runtime|settings|sticky-sessions))(/|$)";

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
  if (
    requestPath === "/dashboard" ||
    requestPath.startsWith("/dashboard/") ||
    requestPath === "/accounts" ||
    requestPath.startsWith("/accounts/") ||
    requestPath === "/settings" ||
    requestPath.startsWith("/settings/") ||
    requestPath.startsWith("/api/accounts")
  )
    return locationBlock(config, codexLbDashboardLocation);
  if (requestPath.startsWith("/admin/")) return locationBlock(config, "/admin/");
  if (requestPath.startsWith("/runner/")) return locationBlock(config, "/runner/");
  return locationBlock(config, "/");
}

function routeDecision(config: string, requestPath: string, user: string): string {
  const block = blockForRequestPath(config, requestPath);
  expect(block).toContain("auth_request /vouch/validate;");

  if (block.includes("proxy_pass $agent_runtime_admin_upstream;")) {
    return adminEmails.includes(user) ? "opencode" : "403";
  }

  if (block.includes("proxy_pass $admin_admin_upstream;")) {
    return adminEmails.includes(user) ? "admin" : "403";
  }

  if (block.includes("proxy_pass $codex_lb_admin_upstream;")) {
    return adminEmails.includes(user) ? "codex-lb" : "403";
  }

  if (block.includes("proxy_pass $runner;")) return "runner";

  throw new Error(`unexpected route block for ${requestPath}`);
}

describe("ingress auth split", () => {
  const compose = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf8");
  const template = readFileSync(resolve(repoRoot, "docker/ingress/nginx.conf.template"), "utf8");

  it("configures Vouch with managed email domains and comma-separated Neo admin emails", () => {
    expect(compose).toContain(
      "VOUCH_DOMAINS=${VOUCH_ALLOWED_EMAIL_DOMAINS:-scoutqa.cc},${VOUCH_COOKIE_DOMAIN:-localhost}",
    );
    expect(compose).not.toContain("VOUCH_WHITELIST=");
    expect(compose).toContain("THOR_ADMIN_EMAILS=${THOR_ADMIN_EMAILS:?set THOR_ADMIN_EMAILS}");
  });

  it("keeps direct codex-lb ports private while ingress owns dashboard access", () => {
    expect(compose).toContain('"127.0.0.1:2455:2455"');
    expect(compose).toContain('"127.0.0.1:1455:1455"');
    expect(compose).toContain("CODEX_LB_DASHBOARD_AUTH_MODE: disabled");
    expect(compose).toContain(
      "CODEX_LB_PROXY_UNAUTHENTICATED_CLIENT_CIDRS: 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    );
    expect(compose).toContain("CODEX_LB_API_KEY: codex-lb-local");
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

  it("serves shared assets from codex-lb with an OpenCode 404 fallback", () => {
    const assets = locationBlock(template, "/assets/");
    expect(assets).not.toContain("auth_request");
    expect(assets).toContain("proxy_pass $codex_lb;");
    expect(assets).toContain("error_page 404 = @opencode_assets;");

    const fallback = locationBlock(template, "@opencode_assets");
    expect(fallback).toContain("internal;");
    expect(fallback).toContain("proxy_pass $opencode;");

    const themePreload = locationBlock(template, "= /oc-theme-preload.js");
    expect(themePreload).not.toContain("auth_request");
    expect(themePreload).toContain("proxy_pass $opencode;");
  });

  it("gates admin UI routes by admin email", () => {
    expect(routeDecision(template, "/admin/config", adminEmails[0])).toBe("admin");
    expect(routeDecision(template, "/admin/config", adminEmails[1])).toBe("admin");
    expect(routeDecision(template, "/admin/config", "user@scoutqa.cc")).toBe("403");
  });

  it("gates codex-lb dashboard routes without capturing OpenCode APIs", () => {
    for (const path of ["/dashboard", "/accounts", "/settings", "/api/accounts"]) {
      expect(routeDecision(template, path, adminEmails[0])).toBe("codex-lb");
      expect(routeDecision(template, path, "user@scoutqa.cc")).toBe("403");
    }

    expect(routeDecision(template, "/api/session", adminEmails[0])).toBe("opencode");
  });

  it("forwards the public Host to vouch so JWT site-claim checks see the ingress hostname", () => {
    const validate = locationBlock(template, "= /vouch/validate");
    expect(validate).toContain("proxy_set_header Host $http_host;");

    const vouchPublic = locationBlock(template, "/vouch/");
    expect(vouchPublic).toContain("proxy_set_header Host $http_host;");
  });

  it("protects exact Google Workspace OAuth routes at the trusted ingress boundary", () => {
    const connect = locationBlock(template, "= /google-workspace/connect");
    expect(connect).toContain("access_log off;");
    expect(connect).toContain("error_log /dev/null emerg;");
    expect(connect).not.toContain("auth_request");
    expect(connect).not.toContain("X-Vouch-User");
    expect(connect).toContain('proxy_set_header X-Thor-Internal-Secret "${THOR_INTERNAL_SECRET}";');
    expect(connect).toContain("proxy_pass $remote_cli;");

    const authorize = locationBlock(template, "= /google-workspace/connect/authorize");
    expect(authorize).toContain("access_log off;");
    expect(authorize).toContain("error_log /dev/null emerg;");
    expect(authorize).toContain("auth_request /vouch/validate;");
    expect(authorize).toContain("proxy_set_header X-Vouch-User $auth_user;");
    expect(authorize).toContain("proxy_pass $remote_cli;");

    const disconnect = locationBlock(template, "= /google-workspace/disconnect");
    expect(disconnect).toContain("access_log off;");
    expect(disconnect).toContain("error_log /dev/null emerg;");
    expect(disconnect).toContain("auth_request /vouch/validate;");
    expect(disconnect).toContain("proxy_set_header X-Vouch-User $auth_user;");
    expect(disconnect).toContain("proxy_pass $remote_cli;");

    const callback = locationBlock(template, "= /google-workspace/oauth/callback");
    expect(callback).toContain("access_log off;");
    expect(callback).toContain("error_log /dev/null emerg;");
    expect(callback).not.toContain("auth_request");
    expect(callback).toContain(
      'proxy_set_header X-Thor-Internal-Secret "${THOR_INTERNAL_SECRET}";',
    );
    expect(callback).not.toContain("X-Vouch-User");
    expect(callback).toContain("proxy_pass $remote_cli;");

    const loginRedirect = locationBlock(template, "@google_workspace_connect_login");
    expect(loginRedirect).toContain("access_log off;");
    expect(loginRedirect).toContain("error_log /dev/null emerg;");
    expect(loginRedirect).toContain(
      "${GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL}/vouch/login?url=${GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL}$request_uri",
    );
    expect(loginRedirect).not.toContain("http://$http_host");
    expect(compose).toContain(
      "GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL=${GOOGLE_WORKSPACE_OAUTH_PUBLIC_BASE_URL:-http://localhost:8080}",
    );
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
