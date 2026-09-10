import { createClient, ItemFieldType, type Client, type Item } from "@1password/sdk";
import type { BrowserLoginPolicy, OnePasswordItemId, OnePasswordVaultId } from "./config.ts";
import { OnePasswordAccessError } from "./errors.ts";
import { RedactedString, withRedactedString } from "./redacted.ts";
import { err, ok, type Result } from "./result.ts";

export interface LoginFieldMetadata {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

export interface LoginMetadata {
  readonly vaultId: OnePasswordVaultId;
  readonly itemId: OnePasswordItemId;
  readonly title: string;
  readonly origin: string;
  readonly fields: ReadonlyArray<LoginFieldMetadata>;
}

export interface LoginCredentials {
  readonly metadata: LoginMetadata;
  readonly username: RedactedString;
  readonly password: RedactedString;
}

export interface ILoginCredentialReader {
  getMetadata(policy: BrowserLoginPolicy): Promise<Result<LoginMetadata, OnePasswordAccessError>>;
  getCredentials(
    policy: BrowserLoginPolicy,
  ): Promise<Result<LoginCredentials, OnePasswordAccessError>>;
}

interface OnePasswordClient {
  readonly items: Pick<Client["items"], "get">;
  readonly secrets: Pick<Client["secrets"], "resolve">;
}

export type OnePasswordClientFactory = (
  serviceAccountToken: RedactedString,
) => Promise<OnePasswordClient>;

async function createSdkClient(serviceAccountToken: RedactedString): Promise<OnePasswordClient> {
  return withRedactedString(serviceAccountToken, (auth) =>
    createClient({
      auth,
      integrationName: "Thor 1Password Browser Broker",
      integrationVersion: "v0.0.1",
    }),
  );
}

function itemHasOnlyApprovedOrigin(item: Item, origin: string): boolean {
  return (
    item.websites.length > 0 &&
    item.websites.every((website) => {
      try {
        return new URL(website.url).origin === origin;
      } catch {
        return false;
      }
    })
  );
}

function metadataForItem(
  item: Item,
  policy: BrowserLoginPolicy,
): Result<LoginMetadata, OnePasswordAccessError> {
  if (
    item.id !== policy.itemId ||
    item.vaultId !== policy.vaultId ||
    item.category !== "Login" ||
    !itemHasOnlyApprovedOrigin(item, policy.origin) ||
    item.fields.some((field) => field.fieldType === ItemFieldType.Totp)
  ) {
    return err(new OnePasswordAccessError("item_invalid"));
  }

  const usernameField = item.fields.find((field) => field.id === policy.usernameRef.fieldId);
  const passwordField = item.fields.find((field) => field.id === policy.passwordRef.fieldId);
  const usernameTypeAllowed =
    usernameField?.fieldType === "Text" || usernameField?.fieldType === "Email";
  if (
    !usernameField ||
    !passwordField ||
    !usernameTypeAllowed ||
    passwordField.fieldType !== "Concealed"
  ) {
    return err(new OnePasswordAccessError("item_invalid"));
  }

  return ok({
    vaultId: policy.vaultId,
    itemId: policy.itemId,
    title: item.title,
    origin: policy.origin,
    fields: item.fields.map((field) => ({
      id: field.id,
      name: field.title,
      type: field.fieldType,
    })),
  });
}

export class OnePasswordLoginCredentialReader implements ILoginCredentialReader {
  readonly #serviceAccountToken: RedactedString;
  readonly #clientFactory: OnePasswordClientFactory;
  #client: Promise<OnePasswordClient> | undefined;

  constructor(
    serviceAccountToken: RedactedString,
    clientFactory: OnePasswordClientFactory = createSdkClient,
  ) {
    this.#serviceAccountToken = serviceAccountToken;
    this.#clientFactory = clientFactory;
  }

  async #getClient(): Promise<OnePasswordClient> {
    this.#client ??= this.#clientFactory(this.#serviceAccountToken);
    return this.#client;
  }

  async #getItem(policy: BrowserLoginPolicy): Promise<Result<Item, OnePasswordAccessError>> {
    try {
      const client = await this.#getClient();
      return ok(await client.items.get(policy.vaultId, policy.itemId));
    } catch {
      return err(new OnePasswordAccessError("unavailable"));
    }
  }

  async getMetadata(
    policy: BrowserLoginPolicy,
  ): Promise<Result<LoginMetadata, OnePasswordAccessError>> {
    const item = await this.#getItem(policy);
    if (item._tag === "err") return item;
    return metadataForItem(item.value, policy);
  }

  async getCredentials(
    policy: BrowserLoginPolicy,
  ): Promise<Result<LoginCredentials, OnePasswordAccessError>> {
    const item = await this.#getItem(policy);
    if (item._tag === "err") return item;
    const metadata = metadataForItem(item.value, policy);
    if (metadata._tag === "err") return metadata;

    try {
      const client = await this.#getClient();
      const [username, password] = await Promise.all([
        client.secrets.resolve(policy.usernameRef.value),
        client.secrets.resolve(policy.passwordRef.value),
      ]);
      if (!username || !password) {
        return err(new OnePasswordAccessError("credential_invalid"));
      }
      return ok({
        metadata: metadata.value,
        username: RedactedString.make(username),
        password: RedactedString.make(password),
      });
    } catch {
      return err(new OnePasswordAccessError("unavailable"));
    }
  }
}
