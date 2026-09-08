import { describe, expect, it } from "vitest";
import { parseGwsArgs } from "./policy-gws.js";

describe("Google Workspace read policy", () => {
  it.each([
    ["drive", "files", "list"],
    ["drive", "files", "get"],
    ["drive", "drives", "list"],
    ["drive", "permissions", "get"],
    ["drive", "comments", "list"],
    ["drive", "replies", "get"],
    ["drive", "revisions", "list"],
    ["docs", "documents", "get"],
    ["sheets", "spreadsheets", "get"],
    ["sheets", "spreadsheets", "values", "get"],
    ["sheets", "spreadsheets", "values", "batchGet"],
  ])("allows structured read %j", (...args) => {
    expect(parseGwsArgs([...args, "--params", '{"fields":"*"}'])).toEqual({
      ok: true,
      command: {
        args: [...args, "--params", '{"fields":"*"}', "--format", "json"],
        operation: args.join(" "),
        requiresCredentials: true,
      },
    });
  });

  it("preserves Sheets read filters and helper ranges", () => {
    expect(
      parseGwsArgs([
        "sheets",
        "spreadsheets",
        "getByDataFilter",
        '--params={"spreadsheetId":"id"}',
        "--json",
        '{"dataFilters":[{"a1Range":"Sheet1!A1:B2"}]}',
      ]).ok,
    ).toBe(true);
    expect(
      parseGwsArgs(["sheets", "+read", "--spreadsheet=id", "--range", "'Quarter 1'!A1:C10"]).ok,
    ).toBe(true);
  });

  it("bounds auto-pagination even when no limit is supplied", () => {
    for (const limit of [undefined, "1", "10"]) {
      const result = parseGwsArgs([
        "drive",
        "files",
        "list",
        "--page-all",
        ...(limit ? [`--page-limit=${limit}`] : []),
      ]);
      expect(result).toMatchObject({
        ok: true,
        command: {
          args: [
            "drive",
            "files",
            "list",
            "--page-all",
            "--page-limit",
            limit ?? "10",
            "--format",
            "json",
          ],
        },
      });
    }
  });

  it.each([
    ["--help"],
    ["--version"],
    ["drive", "--help"],
    ["docs", "documents", "get", "-h"],
    ["sheets", "+read", "--help"],
    ["schema", "sheets.spreadsheets.values.batchGet"],
  ])("allows credential-free discovery %j", (...args) => {
    expect(parseGwsArgs(args)).toMatchObject({ ok: true, command: { requiresCredentials: false } });
  });

  it.each(
    [
      undefined,
      null,
      {},
      [],
      [1],
      ["drive\0", "files", "list"],
      ["auth", "export", "--unmasked"],
      ["auth", "login", "--help"],
      ["gmail", "users", "messages", "list"],
      ["drive:v2", "files", "list"],
      ["drive", "files", "delete", "--help"],
      ["drive", "files", "create"],
      ["docs", "documents", "batchUpdate"],
      ["sheets", "+append"],
      ["sheets", "spreadsheets", "values", "update"],
      ["schema", "drive.files.delete"],
      ["schema", "drive"],
      ["drive", "files", "export", "--params", '{"mimeType":"text/plain"}'],
      ["drive", "files", "download"],
      ["drive", "files", "get", "--params", '{"alt":"media"}'],
      ["drive", "revisions", "get", "--params", '{"alt":["json","media"]}'],
      ["drive", "files", "list", "--params", '{"access_token":"secret"}'],
      ["drive", "files", "list", "--params", '{"callback":"function"}'],
      ["drive", "files", "list", "--params", "@/credentials.json"],
      ["drive", "files", "list", "--params", "[]"],
      ["drive", "files", "list", "--params", "null"],
      ["drive", "files", "list", "--params", "{bad"],
      ["drive", "files", "list", "--params", "{}", "--params={}"],
      ["drive", "files", "list", "--json", "{}"],
      ["sheets", "spreadsheets", "getByDataFilter", "--json", "@/credentials.json"],
      ["drive", "files", "list", "--format", "csv"],
      ["drive", "files", "list", "--page-all=true"],
      ["drive", "files", "list", "--page-limit", "2"],
      ["docs", "documents", "get", "--page-all"],
      ["sheets", "+read", "--spreadsheet", "id"],
      ["drive", "files", "list", "--", "--help"],
      ["--help", "drive", "files", "delete"],
    ].map((args) => ({ args })),
  )("denies unsafe or malformed input $args", ({ args }) => {
    expect(parseGwsArgs(args).ok).toBe(false);
  });

  it("denies all file/credential/transport switches in separate and equals forms", () => {
    for (const flag of [
      "--output",
      "-o",
      "--upload",
      "--dry-run",
      "--sanitize",
      "--account",
      "--api-version",
      "--fields",
      "--page-delay",
      "--future-flag",
    ]) {
      for (const suffix of [[flag, "/private/file"], [`${flag}=/private/file`]]) {
        const result = parseGwsArgs(["drive", "files", "list", ...suffix]);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).not.toContain("/private/file");
      }
    }
    for (const limit of ["0", "11", "99999999", "-1", "1.5", "01", "1e1"]) {
      expect(
        parseGwsArgs(["drive", "files", "list", "--page-all", `--page-limit=${limit}`]).ok,
      ).toBe(false);
    }
  });
});
