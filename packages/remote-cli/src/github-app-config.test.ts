import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const helperPath = join(process.cwd(), "packages/remote-cli/bin/github-app-config.sh");

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function writeConfig(data: unknown): string {
  tempDir = mkdtempSync(join(tmpdir(), "thor-github-config-"));
  const configPath = join(tempDir, "config.json");
  writeFileSync(configPath, JSON.stringify(data), "utf8");
  return configPath;
}

function helperResult(configPath: string): string {
  return execFileSync(
    "sh",
    [
      "-c",
      '. "$1"; if thor_has_github_app_config "$2"; then printf true; else printf false; fi',
      "sh",
      helperPath,
      configPath,
    ],
    { encoding: "utf8" },
  );
}

describe("thor_has_github_app_config", () => {
  it("returns true for migrated owner installation config", () => {
    const configPath = writeConfig({
      repos: { thor: {} },
      owners: { acme: { github_app_installation_id: 123456 } },
    });

    expect(helperResult(configPath)).toBe("true");
  });

  it("returns false for repos-only config", () => {
    const configPath = writeConfig({
      repos: { thor: {} },
    });

    expect(helperResult(configPath)).toBe("false");
  });

  it("returns false when owners is present but empty", () => {
    const configPath = writeConfig({
      repos: { thor: {} },
      owners: {},
    });

    expect(helperResult(configPath)).toBe("false");
  });
});
