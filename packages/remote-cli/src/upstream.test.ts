import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectUpstream,
  ONEPASSWORD_BROWSER_TOKEN_FILE,
  resolveOnePasswordBrowserUpstream,
} from "./upstream.js";

const SECRET_FIXTURE = fileURLToPath(
  new URL("./__fixtures__/secret-stdio-mcp-server.mjs", import.meta.url),
);

describe("1Password browser stdio upstream", () => {
  afterEach(() => {
    delete process.env.THOR_SECRET_LEAK;
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
  });

  it("delivers a one-shot child secret on fd 3 without adding it to the child env", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "secret-fd-fixture";
    const { client, tools } = await connectUpstream("secret-stdio-test", {
      kind: "stdio",
      command: process.execPath,
      args: [SECRET_FIXTURE],
      env: {},
      secretInput: { fd: 3, getContents: () => "secret-fd-fixture" },
    });

    try {
      expect(tools.map((tool) => tool.name)).toEqual(["secret_received_outside_env"]);
    } finally {
      await client.close();
    }
  });

  it("keeps the service-account token out of child env, argv, and serialization", () => {
    const token = "ops_fixture_service_account_token";
    const vaultId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const config = resolveOnePasswordBrowserUpstream({
      OP_SERVICE_ACCOUNT_TOKEN: token,
      ONEPASSWORD_BROWSER_VAULT_ID: vaultId,
    });

    expect(config?.kind).toBe("stdio");
    if (!config || config.kind !== "stdio") throw new Error("expected stdio config");
    expect(config.command).toBe("bwrap");
    expect(config.args).not.toContain(token);
    expect(config.env).toEqual({
      OP_SERVICE_ACCOUNT_TOKEN_FILE: ONEPASSWORD_BROWSER_TOKEN_FILE,
      ONEPASSWORD_BROWSER_VAULT_ID: vaultId,
    });
    expect(Object.values(config.env)).not.toContain(token);
    expect(JSON.stringify(config)).not.toContain(token);
    expect(config.secretInput.getContents()).toBe(token);
  });

  it("is unavailable when absent and rejects partial credential bundles", () => {
    expect(resolveOnePasswordBrowserUpstream({})).toBeUndefined();
    expect(() =>
      resolveOnePasswordBrowserUpstream({ OP_SERVICE_ACCOUNT_TOKEN: "token-only" }),
    ).toThrow(/ONEPASSWORD_BROWSER_VAULT_ID/);
    expect(() =>
      resolveOnePasswordBrowserUpstream({
        ONEPASSWORD_BROWSER_VAULT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toThrow(/OP_SERVICE_ACCOUNT_TOKEN/);
  });
});
