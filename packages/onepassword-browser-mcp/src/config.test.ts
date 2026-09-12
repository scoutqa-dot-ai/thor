import { describe, expect, it } from "vitest";
import {
  consumeServiceAccountTokenFile,
  parseBrokerEnvironment,
  parseBrowserDestinationUrl,
  parseOnePasswordItemId,
  SERVICE_ACCOUNT_TOKEN_FILE,
} from "./config.ts";

const VAULT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN = "ops_fixture_service_account_token";
const TOKEN_ENV = { OP_SERVICE_ACCOUNT_TOKEN_FILE: SERVICE_ACCOUNT_TOKEN_FILE };

function parse(env: NodeJS.ProcessEnv) {
  return parseBrokerEnvironment(env, () => TOKEN);
}

describe("parseBrokerEnvironment", () => {
  it("parses one dedicated vault and redacts the service-account token", () => {
    const result = parse({
      ...TOKEN_ENV,
      ONEPASSWORD_BROWSER_VAULT_ID: VAULT_ID,
    });

    expect(result).toMatchObject({ _tag: "ok", value: { vaultId: VAULT_ID } });
    if (result._tag === "err") return;
    expect(String(result.value.serviceAccountToken)).toBe("[REDACTED]");
    expect(JSON.stringify(result.value)).not.toContain(TOKEN);
  });

  it.each([
    [{ ONEPASSWORD_BROWSER_VAULT_ID: VAULT_ID }, "missing_token"],
    [TOKEN_ENV, "missing_vault"],
    [{ ...TOKEN_ENV, ONEPASSWORD_BROWSER_VAULT_ID: "not-a-vault-id" }, "invalid_vault"],
  ])("fails closed for partial or invalid startup configuration", (env, code) => {
    const result = parse(env);
    expect(result).toMatchObject({ _tag: "err", error: { code } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("consumes and deletes the one-shot service-account token file", () => {
    let removed = false;
    expect(
      consumeServiceAccountTokenFile({
        read: () => `  ${TOKEN}\n`,
        remove: () => {
          removed = true;
        },
      }),
    ).toBe(TOKEN);
    expect(removed).toBe(true);
  });

  it("rejects alternate token-file paths before consuming them", () => {
    let consumed = false;
    const result = parseBrokerEnvironment(
      {
        OP_SERVICE_ACCOUNT_TOKEN_FILE: "/tmp/attacker-controlled-token",
        ONEPASSWORD_BROWSER_VAULT_ID: VAULT_ID,
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

describe("browser credential domain parsing", () => {
  it("canonicalizes HTTPS page URLs while preserving an exact origin and path", () => {
    const result = parseBrowserDestinationUrl(" https://accounts.example.com/login ");
    expect(result).toEqual({
      _tag: "ok",
      value: {
        url: "https://accounts.example.com/login",
        origin: "https://accounts.example.com",
      },
    });

    expect(parseBrowserDestinationUrl("https://accounts.example.com")).toMatchObject({
      _tag: "ok",
      value: { url: "https://accounts.example.com/" },
    });
  });

  it.each([
    "http://accounts.example.com/login",
    "https://user:pass@accounts.example.com/login",
    "https://accounts.example.com/login?token=secret",
    "https://accounts.example.com/login#secret",
    "not a url",
  ])("rejects unsafe browser destination %s", (url) => {
    expect(parseBrowserDestinationUrl(url)).toMatchObject({
      _tag: "err",
      error: { code: "invalid_destination" },
    });
  });

  it("parses only 26-character lowercase 1Password item IDs", () => {
    expect(parseOnePasswordItemId(ITEM_ID)).toBe(ITEM_ID);
    expect(parseOnePasswordItemId(ITEM_ID.toUpperCase())).toBeUndefined();
    expect(parseOnePasswordItemId("short")).toBeUndefined();
  });
});
