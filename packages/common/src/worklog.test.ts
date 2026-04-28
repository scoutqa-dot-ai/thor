import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendJsonlWorklog } from "./worklog.js";

describe("appendJsonlWorklog", () => {
  const originalWorklogDir = process.env.WORKLOG_DIR;
  const originalWorklogEnabled = process.env.WORKLOG_ENABLED;
  let testDir = "";

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "thor-worklog-"));
    process.env.WORKLOG_DIR = testDir;
    process.env.WORKLOG_ENABLED = "true";
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });

    if (originalWorklogDir === undefined) delete process.env.WORKLOG_DIR;
    else process.env.WORKLOG_DIR = originalWorklogDir;

    if (originalWorklogEnabled === undefined) delete process.env.WORKLOG_ENABLED;
    else process.env.WORKLOG_ENABLED = originalWorklogEnabled;
  });

  it("appends multiple entries into the same day JSONL file", () => {
    appendJsonlWorklog("inbound-events", { id: 1, provider: "slack" });
    appendJsonlWorklog("inbound-events", { id: 2, provider: "github" });

    const day = new Date().toISOString().slice(0, 10);
    const outputPath = join(testDir, day, "jsonl", "inbound-events.jsonl");
    const content = readFileSync(outputPath, "utf8");
    const lines = content.trimEnd().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1, provider: "slack" });
    expect(JSON.parse(lines[1])).toEqual({ id: 2, provider: "github" });
    expect(content.endsWith("\n")).toBe(true);
  });
});
