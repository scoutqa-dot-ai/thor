import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  consumeServiceAccountTokenFile,
  parseBrokerEnvironment,
  parseExpectedOrigin,
  SERVICE_ACCOUNT_TOKEN_FILE,
} from "./config.ts";

const VAULT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN = "ops_fixture_service_account_token";
const TOKEN_ENV = { OP_SERVICE_ACCOUNT_TOKEN_FILE: SERVICE_ACCOUNT_TOKEN_FILE };

function policy(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    vault_id: VAULT_ID,
    item_id: ITEM_ID,
    origin: "https://accounts.lambdatest.com",
    login_url: "https://accounts.lambdatest.com/login",
    username_ref: `op://${VAULT_ID}/${ITEM_ID}/username`,
    password_ref: `op://${VAULT_ID}/${ITEM_ID}/password`,
    selectors: {
      username: "input[name=email]",
      password: "input[name=password]",
      submit: "button[type=submit]",
    },
    success_path_prefix: "/dashboard",
    ...overrides,
  });
}

function parse(env: NodeJS.ProcessEnv) {
  return parseBrokerEnvironment(env, (path) =>
    path === SERVICE_ACCOUNT_TOKEN_FILE ? TOKEN : undefined,
  );
}

describe("parseBrokerEnvironment", () => {
  it("parses an exact allowlist and redacts the service-account token", () => {
    const result = parse({
      ...TOKEN_ENV,
      ONEPASSWORD_BROWSER_CONFIG: policy(),
    });

    expect(result._tag).toBe("ok");
    if (result._tag === "err") return;
    expect(result.value.policy).toMatchObject({
      vaultId: VAULT_ID,
      itemId: ITEM_ID,
      origin: "https://accounts.lambdatest.com",
      loginUrl: "https://accounts.lambdatest.com/login",
      successPathPrefix: "/dashboard",
      timeoutMs: 30_000,
    });
    expect(String(result.value.serviceAccountToken)).toBe("[REDACTED]");
    expect(JSON.stringify(result.value)).not.toContain(TOKEN);
  });

  it.each([
    [{ ONEPASSWORD_BROWSER_CONFIG: policy() }, "missing_token"],
    [TOKEN_ENV, "missing_policy"],
    [
      {
        ...TOKEN_ENV,
        ONEPASSWORD_BROWSER_CONFIG: policy({ item_id: "not-an-item-id" }),
      },
      "invalid_policy",
    ],
    [
      {
        ...TOKEN_ENV,
        ONEPASSWORD_BROWSER_CONFIG: policy({ origin: "http://accounts.lambdatest.com" }),
      },
      "invalid_policy",
    ],
    [
      {
        ...TOKEN_ENV,
        ONEPASSWORD_BROWSER_CONFIG: policy({
          login_url: "https://phishing.example/login",
        }),
      },
      "invalid_policy",
    ],
    [
      {
        ...TOKEN_ENV,
        ONEPASSWORD_BROWSER_CONFIG: policy({
          password_ref: `op://${VAULT_ID}/${"c".repeat(26)}/password`,
        }),
      },
      "invalid_policy",
    ],
    [
      {
        ...TOKEN_ENV,
        ONEPASSWORD_BROWSER_CONFIG: policy({
          username_ref: `op://${VAULT_ID}/${ITEM_ID}/password`,
        }),
      },
      "invalid_policy",
    ],
  ])("fails closed for invalid or partial configuration", (env, code) => {
    const result = parse(env);
    expect(result).toMatchObject({ _tag: "err", error: { code } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("consumes and deletes the one-shot service-account token file", () => {
    const dir = mkdtempSync(join(tmpdir(), "thor-op-token-"));
    const tokenFile = join(dir, "token");
    try {
      writeFileSync(tokenFile, `  ${TOKEN}\n`, { mode: 0o600 });
      expect(consumeServiceAccountTokenFile(tokenFile)).toBe(TOKEN);
      expect(existsSync(tokenFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects alternate token-file paths before consuming them", () => {
    let consumed = false;
    const result = parseBrokerEnvironment(
      {
        OP_SERVICE_ACCOUNT_TOKEN_FILE: "/tmp/attacker-controlled-token",
        ONEPASSWORD_BROWSER_CONFIG: policy(),
      },
      () => {
        consumed = true;
        return TOKEN;
      },
    );

    expect(result).toMatchObject({ _tag: "err", error: { code: "missing_token" } });
    expect(consumed).toBe(false);
  });
});

describe("parseExpectedOrigin", () => {
  it("accepts only an exact canonical HTTPS origin", () => {
    expect(parseExpectedOrigin("https://accounts.lambdatest.com")).toBe(
      "https://accounts.lambdatest.com",
    );
    expect(parseExpectedOrigin("https://accounts.lambdatest.com/")).toBeUndefined();
    expect(parseExpectedOrigin("https://accounts.lambdatest.com/login")).toBeUndefined();
    expect(parseExpectedOrigin("https://user:pass@accounts.lambdatest.com")).toBeUndefined();
    expect(parseExpectedOrigin("http://accounts.lambdatest.com")).toBeUndefined();
  });
});
