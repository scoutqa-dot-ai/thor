import { describe, expect, it } from "vitest";
import { parseRemoteUrlFromAskpassPrompt, resolveOwnerFromAskpassPrompt } from "./auth-helper.js";

describe("parseRemoteUrlFromAskpassPrompt", () => {
  it("extracts the remote URL from a git password prompt", () => {
    expect(
      parseRemoteUrlFromAskpassPrompt(
        "Password for 'https://x-access-token@github.com/acme/web.git': ",
      ),
    ).toBe("https://x-access-token@github.com/acme/web.git");
  });

  it("returns undefined when the prompt does not include a quoted URL", () => {
    expect(parseRemoteUrlFromAskpassPrompt("Password: ")).toBeUndefined();
  });

  it("resolves the owner from clone credential prompts", () => {
    expect(
      resolveOwnerFromAskpassPrompt(
        "Password for 'https://x-access-token@github.com/acme/web.git': ",
        "/workspace/repos/web",
      ),
    ).toBe("acme");
  });

  it("cannot resolve owner from host-only clone credential prompts without an existing remote", () => {
    expect(
      resolveOwnerFromAskpassPrompt(
        "Password for 'https://x-access-token@github.com': ",
        "/path/that/does/not/exist",
      ),
    ).toBeUndefined();
  });
});
