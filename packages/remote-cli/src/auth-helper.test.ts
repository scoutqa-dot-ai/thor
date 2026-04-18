import { describe, expect, it } from "vitest";
import { parseRemoteUrlFromAskpassPrompt } from "./auth-helper.js";

describe("parseRemoteUrlFromAskpassPrompt", () => {
  it("extracts the remote URL from a git password prompt", () => {
    expect(
      parseRemoteUrlFromAskpassPrompt(
        "Password for 'https://x-access-token@github.com/acme/web.git': ",
      ),
    ).toBe("https://x-access-token@github.com/acme/web.git");
  });

  it("extracts the remote URL from a username prompt", () => {
    expect(parseRemoteUrlFromAskpassPrompt("Username for 'https://github.com/acme/web': ")).toBe(
      "https://github.com/acme/web",
    );
  });

  it("returns undefined when the prompt does not include a quoted URL", () => {
    expect(parseRemoteUrlFromAskpassPrompt("Password: ")).toBeUndefined();
  });
});
