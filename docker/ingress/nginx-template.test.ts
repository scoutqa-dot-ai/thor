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

function vouchManagedDomainAllows(domains: string, email: string): boolean {
  const [, emailDomain = ""] = email.split("@");
  return domains
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => emailDomain === entry || emailDomain.endsWith(`.${entry}`));
}

function thorAdminEmailsRegex(emails: string): string {
  return emails
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

describe("ingress auth split", () => {
  const compose = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf8");
  const template = readFileSync(resolve(repoRoot, "docker/ingress/nginx.conf.template"), "utf8");

  it("configures Vouch with managed email domains and comma-separated Thor admin emails", () => {
    expect(compose).toContain("VOUCH_DOMAINS=${VOUCH_ALLOWED_EMAIL_DOMAINS:-scoutqa.cc}");
    expect(compose).not.toContain("VOUCH_WHITELIST=");
    expect(vouchManagedDomainAllows("scoutqa.cc", "alice@scoutqa.cc")).toBe(true);
    expect(vouchManagedDomainAllows("scoutqa.cc", "alice@sub.scoutqa.cc")).toBe(true);
    expect(vouchManagedDomainAllows("scoutqa.cc", "alice@example.com")).toBe(false);
    expect(compose).toContain("THOR_ADMIN_EMAILS=${THOR_ADMIN_EMAILS:?set THOR_ADMIN_EMAILS}");
    expect(thorAdminEmailsRegex("admin@scoutqa.cc, owner@scoutqa.cc")).toBe(
      "admin@scoutqa\\.cc|owner@scoutqa\\.cc",
    );
  });

  it("runs the admin-email regex hook before nginx envsubst", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "docker/ingress/Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY 10-thor-admin-emails.envsh /docker-entrypoint.d/10-thor-admin-emails.envsh",
    );
  });

  it("gates OpenCode-backed routes by admin email", () => {
    expect(template).toContain('~^(${THOR_ADMIN_EMAILS_REGEX})$ "http://opencode:4096";');
    expect(template).toContain('default "http://127.0.0.1:8080/__opencode_admin_forbidden";');

    for (const path of ["/", "/assets/app.js", "/oc-theme-preload.js"]) {
      expect(routeDecision(template, path, adminEmails[0])).toBe("opencode");
      expect(routeDecision(template, path, adminEmails[1])).toBe("opencode");
      expect(routeDecision(template, path, "user@scoutqa.cc")).toBe("403");
    }
  });

  it("gates admin UI routes by admin email", () => {
    expect(template).toContain('~^(${THOR_ADMIN_EMAILS_REGEX})$ "http://admin:3005";');

    expect(routeDecision(template, "/admin/config", adminEmails[0])).toBe("admin");
    expect(routeDecision(template, "/admin/config", adminEmails[1])).toBe("admin");
    expect(routeDecision(template, "/admin/config", "user@scoutqa.cc")).toBe("403");
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
