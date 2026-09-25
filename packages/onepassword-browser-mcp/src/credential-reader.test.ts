import {
  AutofillBehavior,
  ItemCategory,
  ItemFieldType,
  ItemState,
  type Item,
  type ItemOverview,
} from "@1password/sdk";
import { describe, expect, it } from "vitest";
import {
  parseBrokerEnvironment,
  parseBrowserDestinationUrl,
  parseOnePasswordItemId,
  SERVICE_ACCOUNT_TOKEN_FILE,
} from "./config.ts";
import { OnePasswordLoginCredentialReader } from "./credential-reader.ts";
import { RedactedString, withRedactedString } from "./redacted.ts";

const VAULT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_ITEM_ID = "cccccccccccccccccccccccccc";
const ORIGIN = "https://accounts.example.com";
const USERNAME = "audit-user@example.com";
const PASSWORD = "secret-password-fixture";
const TOTP_CODE = "123456";
const TOTP_URI = "otpauth://totp/fixture?secret=fixture-seed";
const TOKEN = "ops_fixture_service_account_token";

function parsedEnvironment() {
  const result = parseBrokerEnvironment(
    {
      OP_SERVICE_ACCOUNT_TOKEN_FILE: SERVICE_ACCOUNT_TOKEN_FILE,
      ONEPASSWORD_BROWSER_VAULT_ID: VAULT_ID,
    },
    () => TOKEN,
  );
  if (result._tag === "err") throw result.error;
  return result.value;
}

function destinationOrigin() {
  const result = parseBrowserDestinationUrl(`${ORIGIN}/dashboard`);
  if (result._tag === "err") throw result.error;
  return result.value.origin;
}

function parsedItemId() {
  const itemId = parseOnePasswordItemId(ITEM_ID);
  if (!itemId) throw new Error("invalid item ID fixture");
  return itemId;
}

function overview(overrides: Partial<ItemOverview> = {}): ItemOverview {
  return {
    id: ITEM_ID,
    title: "Example audit",
    category: ItemCategory.Login,
    vaultId: VAULT_ID,
    websites: [
      {
        url: `${ORIGIN}/login`,
        label: "website",
        autofillBehavior: AutofillBehavior.ExactDomain,
      },
    ],
    tags: ["private-tag-fixture"],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    state: ItemState.Active,
    ...overrides,
  };
}

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: ITEM_ID,
    title: "Example audit",
    category: ItemCategory.Login,
    vaultId: VAULT_ID,
    fields: [
      {
        id: "username",
        title: "username",
        fieldType: ItemFieldType.Email,
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
    notes: "private-notes-fixture",
    tags: ["private-tag-fixture"],
    websites: overview().websites,
    version: 1,
    files: [],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}
function totpField(code = TOTP_CODE) {
  return {
    id: "otp",
    title: "one-time password",
    fieldType: ItemFieldType.Totp,
    value: TOTP_URI,
    details: { type: "Otp" as const, content: { code } },
  };
}

function readerWith(input: {
  overviews?: ItemOverview[];
  overviewReads?: ItemOverview[][];
  fullItem?: Item;
  listFailure?: Error;
  getFailure?: Error;
}) {
  const environment = parsedEnvironment();
  let listCalls = 0;
  let getCalls = 0;
  const reader = new OnePasswordLoginCredentialReader(
    environment.vaultId,
    RedactedString.make(TOKEN),
    async () => ({
      items: {
        list: async (vaultId: string) => {
          listCalls += 1;
          expect(vaultId).toBe(VAULT_ID);
          if (input.listFailure) throw input.listFailure;
          return input.overviewReads?.[listCalls - 1] ?? input.overviews ?? [overview()];
        },
        get: async (vaultId: string, itemId: string) => {
          getCalls += 1;
          expect(vaultId).toBe(VAULT_ID);
          expect(itemId).toBe(ITEM_ID);
          if (input.getFailure) throw input.getFailure;
          return input.fullItem ?? item();
        },
      },
    }),
  );
  return {
    reader,
    counts: () => ({ listCalls, getCalls }),
  };
}

describe("OnePasswordLoginCredentialReader discovery", () => {
  it("lists active Login overviews and projects exact-origin metadata without full item reads", async () => {
    const h = readerWith({
      overviews: [
        overview({
          id: OTHER_ITEM_ID,
          title: "Second account",
          websites: [
            {
              ...overview().websites[0],
              autofillBehavior: AutofillBehavior.AnywhereOnWebsite,
            },
          ],
        }),
        overview(),
        overview({
          id: "d".repeat(26),
          title: "Other origin",
          websites: [
            {
              url: "https://other.example/login",
              label: "website",
              autofillBehavior: AutofillBehavior.ExactDomain,
            },
          ],
        }),
      ],
    });

    const result = await h.reader.findLoginItems(destinationOrigin());
    expect(result).toMatchObject({
      _tag: "ok",
      value: [
        {
          itemId: ITEM_ID,
          title: "Example audit",
          origin: ORIGIN,
          loginUrl: `${ORIGIN}/login`,
        },
        {
          itemId: OTHER_ITEM_ID,
          title: "Second account",
          origin: ORIGIN,
          loginUrl: `${ORIGIN}/login`,
        },
      ],
    });
    expect(h.counts()).toEqual({ listCalls: 1, getCalls: 0 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-tag-fixture");
    expect(serialized).not.toContain(USERNAME);
    expect(serialized).not.toContain(PASSWORD);
  });

  it("does not inherit 1Password subdomain matching from AnywhereOnWebsite", async () => {
    const subdomain = parseBrowserDestinationUrl("https://sub.accounts.example.com/dashboard");
    if (subdomain._tag === "err") throw subdomain.error;
    const h = readerWith({
      overviews: [
        overview({
          websites: [
            {
              ...overview().websites[0],
              autofillBehavior: AutofillBehavior.AnywhereOnWebsite,
            },
          ],
        }),
      ],
    });

    await expect(h.reader.findLoginItems(subdomain.value.origin)).resolves.toEqual({
      _tag: "ok",
      value: [],
    });
  });

  it("omits overviews that cannot safely authorize exact-origin Login autofill", async () => {
    const h = readerWith({
      overviews: [
        overview({ category: ItemCategory.SecureNote }),
        overview({ state: ItemState.Archived }),
        overview({ vaultId: "d".repeat(26) }),
        overview({ title: "Audit\u202eLogin" }),
        overview({ websites: [] }),
        overview({
          websites: [
            ...overview().websites,
            {
              url: "https://evil.example/login",
              label: "other",
              autofillBehavior: AutofillBehavior.ExactDomain,
            },
          ],
        }),
        overview({
          websites: [
            {
              ...overview().websites[0],
              autofillBehavior: AutofillBehavior.Never,
            },
          ],
        }),
        overview({
          websites: [
            {
              ...overview().websites[0],
              url: `${ORIGIN}/login?token=unsafe`,
            },
          ],
        }),
      ],
    });

    await expect(h.reader.findLoginItems(destinationOrigin())).resolves.toEqual({
      _tag: "ok",
      value: [],
    });
  });

  it("fails closed rather than returning an unbounded matching-account list", async () => {
    const overviews = Array.from({ length: 51 }, (_, index) =>
      overview({ id: index.toString(36).padStart(26, "a") }),
    );
    const h = readerWith({ overviews });

    await expect(h.reader.findLoginItems(destinationOrigin())).resolves.toMatchObject({
      _tag: "err",
      error: { code: "item_invalid" },
    });
  });
});

describe("OnePasswordLoginCredentialReader credential loading", () => {
  it("returns a fresh-code capability for one explicitly approved TOTP field", async () => {
    const h = readerWith({
      fullItem: item({ fields: [...item().fields, totpField()] }),
    });
    const selection = {
      itemId: parsedItemId(),
      origin: destinationOrigin(),
      approvedTitle: "Example audit",
      automateTotp: true,
    };

    const result = await h.reader.getLoginCredentials(selection);
    expect(result).toMatchObject({ _tag: "ok", value: { totp: {} } });
    expect(h.counts()).toEqual({ listCalls: 1, getCalls: 1 });
    expect(JSON.stringify(result)).not.toContain(TOTP_CODE);
    expect(JSON.stringify(result)).not.toContain(TOTP_URI);
    if (result._tag === "err" || !result.value.totp) return;

    const currentCode = await result.value.totp.getCurrentCode();
    expect(currentCode._tag).toBe("ok");
    expect(h.counts()).toEqual({ listCalls: 2, getCalls: 2 });
    expect(JSON.stringify(currentCode)).not.toContain(TOTP_CODE);
    expect(JSON.stringify(currentCode)).not.toContain(TOTP_URI);
    if (currentCode._tag === "ok") {
      await expect(withRedactedString(currentCode.value, (value) => value)).resolves.toBe(
        TOTP_CODE,
      );
    }
  });

  it("rejects an automated-TOTP request when the item has no TOTP field", async () => {
    const h = readerWith({});
    await expect(
      h.reader.getLoginCredentials({
        itemId: parsedItemId(),
        origin: destinationOrigin(),
        approvedTitle: "Example audit",
        automateTotp: true,
      }),
    ).resolves.toMatchObject({ _tag: "err", error: { code: "item_invalid" } });
  });

  it("rejects an archived item before reading password-bearing fields", async () => {
    const h = readerWith({ overviews: [overview({ state: ItemState.Archived })] });

    await expect(
      h.reader.getLoginCredentials({
        itemId: parsedItemId(),
        origin: destinationOrigin(),
        approvedTitle: "Example audit",
      }),
    ).resolves.toMatchObject({ _tag: "err", error: { code: "item_invalid" } });
    expect(h.counts()).toEqual({ listCalls: 1, getCalls: 0 });
  });

  it("revalidates that the approved TOTP item is still active before reading a fresh code", async () => {
    const h = readerWith({
      overviewReads: [[overview()], [overview({ state: ItemState.Archived })]],
      fullItem: item({ fields: [...item().fields, totpField()] }),
    });
    const credentials = await h.reader.getLoginCredentials({
      itemId: parsedItemId(),
      origin: destinationOrigin(),
      approvedTitle: "Example audit",
      automateTotp: true,
    });
    if (credentials._tag === "err" || !credentials.value.totp) {
      throw new Error("missing TOTP capability fixture");
    }

    await expect(credentials.value.totp.getCurrentCode()).resolves.toMatchObject({
      _tag: "err",
      error: { code: "item_invalid" },
    });
    expect(h.counts()).toEqual({ listCalls: 2, getCalls: 1 });
  });

  it("fails closed when 1Password cannot compute a bounded numeric TOTP code", async () => {
    const h = readerWith({
      fullItem: item({ fields: [...item().fields, totpField("not-a-code")] }),
    });
    const credentials = await h.reader.getLoginCredentials({
      itemId: parsedItemId(),
      origin: destinationOrigin(),
      approvedTitle: "Example audit",
      automateTotp: true,
    });
    if (credentials._tag === "err" || !credentials.value.totp) {
      throw new Error("missing TOTP capability fixture");
    }

    await expect(credentials.value.totp.getCurrentCode()).resolves.toMatchObject({
      _tag: "err",
      error: { code: "credential_invalid" },
    });
  });

  it("accepts AnywhereOnWebsite while retaining Thor's exact-origin boundary", async () => {
    const h = readerWith({
      fullItem: item({
        websites: [
          {
            ...overview().websites[0],
            autofillBehavior: AutofillBehavior.AnywhereOnWebsite,
          },
        ],
      }),
    });

    await expect(
      h.reader.getLoginCredentials({
        itemId: parsedItemId(),
        origin: destinationOrigin(),
        approvedTitle: "Example audit",
      }),
    ).resolves.toMatchObject({ _tag: "ok" });
  });

  it("revalidates a fresh full item and wraps only built-in username/password fields", async () => {
    const h = readerWith({});
    const result = await h.reader.getLoginCredentials({
      itemId: parsedItemId(),
      origin: destinationOrigin(),
      approvedTitle: "Example audit",
    });

    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        metadata: { itemId: ITEM_ID, title: "Example audit", origin: ORIGIN },
      },
    });
    expect(h.counts()).toEqual({ listCalls: 1, getCalls: 1 });
    expect(JSON.stringify(result)).not.toContain(USERNAME);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it.each([
    ["changed title", { title: "Renamed after approval" }],
    ["wrong category", { category: ItemCategory.SecureNote }],
    ["wrong vault", { vaultId: "d".repeat(26) }],
    [
      "disabled website autofill",
      {
        websites: [
          {
            ...overview().websites[0],
            autofillBehavior: AutofillBehavior.Never,
          },
        ],
      },
    ],
    [
      "mixed website origins",
      {
        websites: [
          ...overview().websites,
          {
            url: "https://evil.example/login",
            label: "other",
            autofillBehavior: AutofillBehavior.ExactDomain,
          },
        ],
      },
    ],
    [
      "TOTP field",
      {
        fields: [
          ...item().fields,
          { id: "otp", title: "one-time password", fieldType: ItemFieldType.Totp, value: "seed" },
        ],
      },
    ],
  ])("rejects a full item with %s", async (_label, overrides) => {
    const h = readerWith({ fullItem: item(overrides) });
    const result = await h.reader.getLoginCredentials({
      itemId: parsedItemId(),
      origin: destinationOrigin(),
      approvedTitle: "Example audit",
    });
    expect(result).toMatchObject({ _tag: "err", error: { code: "item_invalid" } });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it.each([
    ["empty", ""],
    ["named", "login-fields"],
  ])("accepts canonical credential IDs with %s SDK sections", async (_label, sectionId) => {
    const h = readerWith({
      fullItem: item({
        fields: item().fields.map((field) => ({ ...field, sectionId })),
      }),
    });

    await expect(
      h.reader.getLoginCredentials({
        itemId: parsedItemId(),
        origin: destinationOrigin(),
        approvedTitle: "Example audit",
      }),
    ).resolves.toMatchObject({ _tag: "ok" });
  });

  it.each([
    [
      "duplicate username",
      {
        fields: [
          ...item().fields,
          { id: "username", title: "other", fieldType: ItemFieldType.Text, value: "other" },
        ],
      },
    ],
    [
      "non-concealed password",
      {
        fields: item().fields.map((field) =>
          field.id === "password" ? { ...field, fieldType: ItemFieldType.Text } : field,
        ),
      },
    ],
    [
      "empty credential",
      {
        fields: item().fields.map((field) =>
          field.id === "password" ? { ...field, value: "" } : field,
        ),
      },
    ],
    [
      "title-only credential lookalike",
      {
        fields: item().fields.map((field) =>
          field.id === "password" ? { ...field, id: "custom-password", title: "password" } : field,
        ),
      },
    ],
    [
      "oversized credential",
      {
        fields: item().fields.map((field) =>
          field.id === "password" ? { ...field, value: "p".repeat(4_097) } : field,
        ),
      },
    ],
  ])("rejects %s", async (_label, overrides) => {
    const h = readerWith({ fullItem: item(overrides) });
    const result = await h.reader.getLoginCredentials({
      itemId: parsedItemId(),
      origin: destinationOrigin(),
      approvedTitle: "Example audit",
    });
    expect(result).toMatchObject({ _tag: "err", error: { code: "credential_invalid" } });
  });

  it("discards SDK causes instead of returning credential-shaped error text", async () => {
    const cause = new Error(`SDK failed with token ${TOKEN} and password ${PASSWORD}`);
    const h = readerWith({ listFailure: cause, getFailure: cause });

    const discovery = await h.reader.findLoginItems(destinationOrigin());
    const credentials = await h.reader.getLoginCredentials({
      itemId: parsedItemId(),
      origin: destinationOrigin(),
      approvedTitle: "Example audit",
    });
    expect(discovery).toMatchObject({ _tag: "err", error: { code: "unavailable" } });
    expect(credentials).toMatchObject({ _tag: "err", error: { code: "unavailable" } });
    expect(JSON.stringify({ discovery, credentials })).not.toContain(TOKEN);
    expect(JSON.stringify({ discovery, credentials })).not.toContain(PASSWORD);
  });
});
