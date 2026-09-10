import { AutofillBehavior, ItemCategory, ItemFieldType, type Item } from "@1password/sdk";
import { describe, expect, it } from "vitest";
import { parseBrokerEnvironment, SERVICE_ACCOUNT_TOKEN_FILE } from "./config.ts";
import { OnePasswordLoginCredentialReader } from "./credential-reader.ts";
import { RedactedString } from "./redacted.ts";

const VAULT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ORIGIN = "https://accounts.lambdatest.com";
const USERNAME = "audit-user@example.com";
const PASSWORD = "secret-password-fixture";

function parsedPolicy() {
  const result = parseBrokerEnvironment(
    {
      OP_SERVICE_ACCOUNT_TOKEN_FILE: SERVICE_ACCOUNT_TOKEN_FILE,
      ONEPASSWORD_BROWSER_CONFIG: JSON.stringify({
        vault_id: VAULT_ID,
        item_id: ITEM_ID,
        origin: ORIGIN,
        login_url: `${ORIGIN}/login`,
        username_ref: `op://${VAULT_ID}/${ITEM_ID}/username`,
        password_ref: `op://${VAULT_ID}/${ITEM_ID}/password`,
        selectors: { username: "#u", password: "#p", submit: "#s" },
        success_path_prefix: "/dashboard",
      }),
    },
    () => "ops_fixture_service_account_token",
  );
  if (result._tag === "err") throw result.error;
  return result.value.policy;
}

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: ITEM_ID,
    title: "TestMu audit",
    category: ItemCategory.Login,
    vaultId: VAULT_ID,
    fields: [
      {
        id: "username",
        title: "username",
        fieldType: ItemFieldType.Text,
        value: USERNAME,
      },
      {
        id: "password",
        title: "password",
        fieldType: ItemFieldType.Concealed,
        value: PASSWORD,
      },
    ],
    sections: [],
    notes: "notes-secret-fixture",
    tags: ["tag-secret-fixture"],
    websites: [
      {
        url: `${ORIGIN}/login`,
        label: "website",
        autofillBehavior: AutofillBehavior.ExactDomain,
      },
    ],
    version: 1,
    files: [],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("OnePasswordLoginCredentialReader", () => {
  it("projects metadata without values, notes, tags, or unapproved websites", async () => {
    const reader = new OnePasswordLoginCredentialReader(
      RedactedString.make("ops_fixture_service_account_token"),
      async () => ({
        items: { get: async () => item() },
        secrets: {
          resolve: async (reference: string) =>
            reference.endsWith("/username") ? USERNAME : PASSWORD,
        },
      }),
    );

    const result = await reader.getMetadata(parsedPolicy());
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        itemId: ITEM_ID,
        vaultId: VAULT_ID,
        title: "TestMu audit",
        origin: ORIGIN,
      },
    });
    const serialized = JSON.stringify(result);
    for (const secret of [USERNAME, PASSWORD, "notes-secret-fixture", "tag-secret-fixture"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it.each([
    ["wrong vault", { vaultId: "c".repeat(26) }],
    ["wrong category", { category: ItemCategory.SecureNote }],
    [
      "wrong website",
      {
        websites: [
          {
            url: "https://evil.example/login",
            label: "website",
            autofillBehavior: AutofillBehavior.ExactDomain,
          },
        ],
      },
    ],
    [
      "an additional website origin",
      {
        websites: [
          {
            url: `${ORIGIN}/login`,
            label: "website",
            autofillBehavior: AutofillBehavior.ExactDomain,
          },
          {
            url: "https://evil.example/login",
            label: "other website",
            autofillBehavior: AutofillBehavior.ExactDomain,
          },
        ],
      },
    ],
    [
      "a TOTP field",
      {
        fields: [
          { id: "username", title: "username", fieldType: ItemFieldType.Text, value: USERNAME },
          {
            id: "password",
            title: "password",
            fieldType: ItemFieldType.Concealed,
            value: PASSWORD,
          },
          { id: "otp", title: "one-time password", fieldType: ItemFieldType.Totp, value: "seed" },
        ],
      },
    ],
    [
      "password field not concealed",
      {
        fields: [
          { id: "username", title: "username", fieldType: ItemFieldType.Text, value: USERNAME },
          { id: "password", title: "password", fieldType: ItemFieldType.Text, value: PASSWORD },
        ],
      },
    ],
  ])("rejects an item with %s", async (_label, overrides) => {
    const reader = new OnePasswordLoginCredentialReader(
      RedactedString.make("ops_fixture_service_account_token"),
      async () => ({
        items: { get: async () => item(overrides) },
        secrets: { resolve: async () => PASSWORD },
      }),
    );

    await expect(reader.getCredentials(parsedPolicy())).resolves.toMatchObject({
      _tag: "err",
      error: { code: "item_invalid" },
    });
  });

  it("discards SDK error causes instead of returning credential-shaped text", async () => {
    const cause = "SDK failed with token ops_leaked and password secret-password-fixture";
    const reader = new OnePasswordLoginCredentialReader(
      RedactedString.make("ops_fixture_service_account_token"),
      async () => ({
        items: {
          get: async () => {
            throw new Error(cause);
          },
        },
        secrets: { resolve: async () => PASSWORD },
      }),
    );

    const result = await reader.getMetadata(parsedPolicy());
    expect(result).toMatchObject({ _tag: "err", error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain(cause);
    expect(JSON.stringify(result)).not.toContain("ops_leaked");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });
});
