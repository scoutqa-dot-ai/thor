import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(import.meta.dirname, "10-thor-admin-emails.envsh");

function renderAdminRegex(input: string): string {
  return execFileSync(
    "sh",
    ["-c", `. "${scriptPath}"; printf '%s' "$THOR_ADMIN_EMAILS_REGEX"`],
    {
      cwd: resolve(import.meta.dirname, "..", ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        THOR_ADMIN_EMAILS: input,
      },
    },
  );
}

describe("10-thor-admin-emails.envsh", () => {
  it("keeps the final email when multiple admins are configured", () => {
    expect(renderAdminRegex("son.dao@katalon.com,duy.pham@katalon.com")).toBe(
      "son\\.dao@katalon\\.com|duy\\.pham@katalon\\.com",
    );
  });

  it("trims whitespace and skips empty entries", () => {
    expect(renderAdminRegex("  son.dao@katalon.com , , duy.pham@katalon.com  ")).toBe(
      "son\\.dao@katalon\\.com|duy\\.pham@katalon\\.com",
    );
  });
});
