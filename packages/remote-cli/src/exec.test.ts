import { describe, it, expect } from "vitest";
import { execCommand, execCommandStream } from "./exec.js";

describe("execCommand", () => {
  it("captures stdout", async () => {
    const result = await execCommand("echo", ["hello"], "/tmp");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr", async () => {
    const result = await execCommand("node", ["-e", "process.stderr.write('oops')"], "/tmp");
    expect(result.stderr).toBe("oops");
  });

  it("returns exit code from failing command", async () => {
    const result = await execCommand("node", ["-e", "process.exit(42)"], "/tmp");
    expect(result.exitCode).toBe(42);
  });

  it("returns exit code 1 for missing binary", async () => {
    const result = await execCommand("nonexistent-binary-xyz", [], "/tmp");
    expect(result.exitCode).toBe(1);
  });
});

describe("execCommandStream", () => {
  it("streams stdout chunks", async () => {
    const chunks: string[] = [];
    const exitCode = await execCommandStream(
      "node",
      ["-e", 'process.stdout.write("a"); process.stdout.write("b")'],
      "/tmp",
      { onStdout: (c) => chunks.push(c), onStderr: () => {} },
    );
    expect(chunks.join("")).toBe("ab");
    expect(exitCode).toBe(0);
  });

  it("streams stderr chunks", async () => {
    const chunks: string[] = [];
    const exitCode = await execCommandStream(
      "node",
      ["-e", 'process.stderr.write("err1"); process.stderr.write("err2")'],
      "/tmp",
      { onStdout: () => {}, onStderr: (c) => chunks.push(c) },
    );
    expect(chunks.join("")).toBe("err1err2");
    expect(exitCode).toBe(0);
  });

  it("interleaves stdout and stderr", async () => {
    const events: Array<{ stream: string; data: string }> = [];
    await execCommandStream(
      "node",
      [
        "-e",
        `
        const { writeSync } = require("fs");
        writeSync(1, "out1");
        writeSync(2, "err1");
        writeSync(1, "out2");
        `,
      ],
      "/tmp",
      {
        onStdout: (d) => events.push({ stream: "stdout", data: d }),
        onStderr: (d) => events.push({ stream: "stderr", data: d }),
      },
    );
    const allStdout = events
      .filter((e) => e.stream === "stdout")
      .map((e) => e.data)
      .join("");
    const allStderr = events
      .filter((e) => e.stream === "stderr")
      .map((e) => e.data)
      .join("");
    expect(allStdout).toBe("out1out2");
    expect(allStderr).toBe("err1");
  });

  it("returns non-zero exit code", async () => {
    const exitCode = await execCommandStream("node", ["-e", "process.exit(7)"], "/tmp", {
      onStdout: () => {},
      onStderr: () => {},
    });
    expect(exitCode).toBe(7);
  });

  it("returns 1 for missing binary", async () => {
    const exitCode = await execCommandStream("nonexistent-binary-xyz", [], "/tmp", {
      onStdout: () => {},
      onStderr: () => {},
    });
    expect(exitCode).toBe(1);
  });
});
