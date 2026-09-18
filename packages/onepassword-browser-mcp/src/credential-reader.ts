import {
  AutofillBehavior,
  createClient,
  ItemCategory,
  ItemFieldType,
  ItemState,
  type Client,
  type Item,
  type ItemOverview,
} from "@1password/sdk";
import {
  parseBrowserDestinationUrl,
  parseOnePasswordItemId,
  type BrowserOrigin,
  type BrowserUrl,
  type OnePasswordItemId,
  type OnePasswordVaultId,
} from "./config.ts";
import { OnePasswordAccessError } from "./errors.ts";
import { RedactedString, withRedactedString } from "./redacted.ts";
import { err, ok, type Result } from "./result.ts";

const MAX_LOGIN_TITLE_LENGTH = 200;
const MAX_MATCHING_LOGIN_ITEMS = 50;
const MAX_LOGIN_ITEM_FIELDS = 200;
const MAX_USERNAME_LENGTH = 512;
const MAX_PASSWORD_LENGTH = 4_096;
const TOTP_CODE_PATTERN = /^[0-9]{6,8}$/;
const UNSAFE_LOGIN_TITLE_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const ACTIVE_ITEMS_FILTER = {
  type: "ByState",
  content: { active: true, archived: false },
} as const;

/** Safe metadata for one exact-origin Login item; it contains no item fields. */
export interface LoginItemMetadata {
  readonly vaultId: OnePasswordVaultId;
  readonly itemId: OnePasswordItemId;
  readonly title: string;
  readonly origin: BrowserOrigin;
  readonly loginUrl: BrowserUrl;
}

/** Capability that obtains a newly computed TOTP only after the browser reaches MFA. */
export interface LoginTotpCapability {
  readonly getCurrentCode: () => Promise<Result<RedactedString, OnePasswordAccessError>>;
}

/** Credential-bearing Login item retained only inside the trusted broker. */
export interface LoginCredentials {
  readonly metadata: LoginItemMetadata;
  readonly username: RedactedString;
  readonly password: RedactedString;
  readonly totp?: LoginTotpCapability;
}

/** Selection approved by Slack and revalidated against a fresh full item read. */
export interface LoginCredentialSelection {
  readonly itemId: OnePasswordItemId;
  readonly origin: BrowserOrigin;
  readonly approvedTitle: string;
  readonly automateTotp?: boolean;
}

/** Read-only access to safe Login discovery and approval-gated credential loading. */
export interface ILoginCredentialReader {
  /** List safe metadata for active Login items whose sole website has this exact origin. */
  findLoginItems(
    origin: BrowserOrigin,
  ): Promise<Result<ReadonlyArray<LoginItemMetadata>, OnePasswordAccessError>>;

  /** Load one approved Login item and wrap its built-in username/password values. */
  getLoginCredentials(
    selection: LoginCredentialSelection,
  ): Promise<Result<LoginCredentials, OnePasswordAccessError>>;
}

interface OnePasswordClient {
  readonly items: Pick<Client["items"], "get" | "list">;
}

/** Construct the only SDK capability used by the read-only credential reader. */
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

function parseLoginTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.trim();
  return title &&
    title.length <= MAX_LOGIN_TITLE_LENGTH &&
    !UNSAFE_LOGIN_TITLE_CHARACTER.test(title)
    ? title
    : undefined;
}

function allowsBrokerExactOriginMatching(behavior: AutofillBehavior): boolean {
  return (
    behavior === AutofillBehavior.ExactDomain || behavior === AutofillBehavior.AnywhereOnWebsite
  );
}

function metadataFromOverview(
  item: ItemOverview,
  vaultId: OnePasswordVaultId,
): LoginItemMetadata | undefined {
  const itemId = parseOnePasswordItemId(item.id);
  const title = parseLoginTitle(item.title);
  if (
    !itemId ||
    !title ||
    item.vaultId !== vaultId ||
    item.category !== ItemCategory.Login ||
    item.state !== ItemState.Active ||
    !Array.isArray(item.websites) ||
    item.websites.length !== 1
  ) {
    return undefined;
  }

  const website = item.websites[0];
  if (!website || !allowsBrokerExactOriginMatching(website.autofillBehavior)) return undefined;
  const destination = parseBrowserDestinationUrl(website.url);
  if (destination._tag === "err") return undefined;

  return {
    vaultId,
    itemId,
    title,
    origin: destination.value.origin,
    loginUrl: destination.value.url,
  };
}

function metadataFromItem(
  item: Item,
  selection: LoginCredentialSelection,
  vaultId: OnePasswordVaultId,
): Result<LoginItemMetadata, OnePasswordAccessError> {
  const itemId = parseOnePasswordItemId(item.id);
  const title = parseLoginTitle(item.title);
  if (
    !itemId ||
    itemId !== selection.itemId ||
    item.vaultId !== vaultId ||
    item.category !== ItemCategory.Login ||
    !title ||
    title !== selection.approvedTitle ||
    !Array.isArray(item.websites) ||
    item.websites.length !== 1 ||
    !Array.isArray(item.fields) ||
    item.fields.length > MAX_LOGIN_ITEM_FIELDS
  ) {
    return err(new OnePasswordAccessError("item_invalid"));
  }

  const totpFieldCount = item.fields.filter(
    (field) => field?.fieldType === ItemFieldType.Totp,
  ).length;
  if (
    (selection.automateTotp && totpFieldCount !== 1) ||
    (!selection.automateTotp && totpFieldCount !== 0)
  ) {
    return err(new OnePasswordAccessError("item_invalid"));
  }

  const website = item.websites[0];
  if (!website || !allowsBrokerExactOriginMatching(website.autofillBehavior)) {
    return err(new OnePasswordAccessError("item_invalid"));
  }
  const destination = parseBrowserDestinationUrl(website.url);
  if (destination._tag === "err" || destination.value.origin !== selection.origin) {
    return err(new OnePasswordAccessError("item_invalid"));
  }

  return ok({
    vaultId,
    itemId,
    title,
    origin: destination.value.origin,
    loginUrl: destination.value.url,
  });
}

function isRootItemField(field: Item["fields"][number]): boolean {
  return field.sectionId === undefined || field.sectionId === "";
}

function findSingleBuiltInField(item: Item, fieldId: "username" | "password") {
  if (!Array.isArray(item.fields)) return undefined;
  const fields = item.fields.filter((field) => field?.id === fieldId && isRootItemField(field));
  return fields.length === 1 ? fields[0] : undefined;
}

function parseCredentialValue(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function parseCurrentTotpCode(item: Item): RedactedString | undefined {
  if (!Array.isArray(item.fields)) return undefined;
  const fields = item.fields.filter((field) => field?.fieldType === ItemFieldType.Totp);
  if (fields.length !== 1) return undefined;
  const details = fields[0]?.details;
  if (details?.type !== "Otp") return undefined;
  const code = details.content.code;
  return typeof code === "string" && TOTP_CODE_PATTERN.test(code)
    ? RedactedString.make(code)
    : undefined;
}

/** 1Password SDK adapter constrained to one vault and read-only item operations. */
export class OnePasswordLoginCredentialReader implements ILoginCredentialReader {
  readonly #vaultId: OnePasswordVaultId;
  readonly #serviceAccountToken: RedactedString;
  readonly #clientFactory: OnePasswordClientFactory;
  #client: Promise<OnePasswordClient> | undefined;

  /** Create a reader permanently scoped to the configured dedicated vault. */
  constructor(
    vaultId: OnePasswordVaultId,
    serviceAccountToken: RedactedString,
    clientFactory: OnePasswordClientFactory = createSdkClient,
  ) {
    this.#vaultId = vaultId;
    this.#serviceAccountToken = serviceAccountToken;
    this.#clientFactory = clientFactory;
  }

  async #getClient(): Promise<OnePasswordClient> {
    this.#client ??= this.#clientFactory(this.#serviceAccountToken);
    return this.#client;
  }

  async #readItem(itemId: OnePasswordItemId): Promise<Result<Item, OnePasswordAccessError>> {
    try {
      const client = await this.#getClient();
      return ok(await client.items.get(this.#vaultId, itemId));
    } catch {
      return err(new OnePasswordAccessError("unavailable"));
    }
  }

  async #requireActiveSelection(
    selection: LoginCredentialSelection,
  ): Promise<Result<void, OnePasswordAccessError>> {
    let overviews: ItemOverview[];
    try {
      const client = await this.#getClient();
      overviews = await client.items.list(this.#vaultId, ACTIVE_ITEMS_FILTER);
    } catch {
      return err(new OnePasswordAccessError("unavailable"));
    }
    const matches = overviews.filter((overview) => {
      const metadata = metadataFromOverview(overview, this.#vaultId);
      return (
        metadata?.itemId === selection.itemId &&
        metadata.title === selection.approvedTitle &&
        metadata.origin === selection.origin
      );
    });
    return matches.length === 1 ? ok(undefined) : err(new OnePasswordAccessError("item_invalid"));
  }

  async #getCurrentTotpCode(
    selection: LoginCredentialSelection,
  ): Promise<Result<RedactedString, OnePasswordAccessError>> {
    const active = await this.#requireActiveSelection(selection);
    if (active._tag === "err") return active;
    const item = await this.#readItem(selection.itemId);
    if (item._tag === "err") return item;
    const metadata = metadataFromItem(item.value, selection, this.#vaultId);
    if (metadata._tag === "err") return metadata;
    const code = parseCurrentTotpCode(item.value);
    return code ? ok(code) : err(new OnePasswordAccessError("credential_invalid"));
  }

  /** List safe metadata for active Login items whose Website exactly matches the origin. */
  async findLoginItems(
    origin: BrowserOrigin,
  ): Promise<Result<ReadonlyArray<LoginItemMetadata>, OnePasswordAccessError>> {
    try {
      const client = await this.#getClient();
      const overviews = await client.items.list(this.#vaultId, ACTIVE_ITEMS_FILTER);
      const matches: LoginItemMetadata[] = [];
      const itemIds = new Set<string>();

      for (const overview of overviews) {
        const metadata = metadataFromOverview(overview, this.#vaultId);
        if (!metadata || metadata.origin !== origin) continue;
        if (itemIds.has(metadata.itemId)) {
          return err(new OnePasswordAccessError("item_invalid"));
        }
        itemIds.add(metadata.itemId);
        matches.push(metadata);
        if (matches.length > MAX_MATCHING_LOGIN_ITEMS) {
          return err(new OnePasswordAccessError("item_invalid"));
        }
      }

      matches.sort((left, right) =>
        left.title === right.title
          ? left.itemId.localeCompare(right.itemId)
          : left.title.localeCompare(right.title),
      );
      return ok(matches);
    } catch {
      return err(new OnePasswordAccessError("unavailable"));
    }
  }

  /** Re-read and validate one approved item before returning wrapped credential values. */
  async getLoginCredentials(
    selection: LoginCredentialSelection,
  ): Promise<Result<LoginCredentials, OnePasswordAccessError>> {
    const active = await this.#requireActiveSelection(selection);
    if (active._tag === "err") return active;
    const item = await this.#readItem(selection.itemId);
    if (item._tag === "err") return item;
    const metadata = metadataFromItem(item.value, selection, this.#vaultId);
    if (metadata._tag === "err") return metadata;

    const username = findSingleBuiltInField(item.value, "username");
    const password = findSingleBuiltInField(item.value, "password");
    const usernameValue = parseCredentialValue(username?.value, MAX_USERNAME_LENGTH);
    const passwordValue = parseCredentialValue(password?.value, MAX_PASSWORD_LENGTH);
    const usernameTypeAllowed =
      username?.fieldType === ItemFieldType.Text || username?.fieldType === ItemFieldType.Email;
    if (
      !username ||
      !password ||
      !usernameTypeAllowed ||
      password.fieldType !== ItemFieldType.Concealed ||
      !usernameValue ||
      !passwordValue
    ) {
      return err(new OnePasswordAccessError("credential_invalid"));
    }

    return ok({
      metadata: metadata.value,
      username: RedactedString.make(usernameValue),
      password: RedactedString.make(passwordValue),
      ...(selection.automateTotp
        ? { totp: { getCurrentCode: () => this.#getCurrentTotpCode(selection) } }
        : {}),
    });
  }
}
