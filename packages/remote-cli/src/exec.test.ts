import { EventEmitter } from "node:events";
import { describe, it, expect, vi, afterEach } from "vitest";
import { execCommand, execCommandStream } from "./exec.js";

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("node:child_process");
  vi.resetModules();
  vi.restoreAllMocks();
});

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

  it("does not enforce a Thor-side timeout", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    let callback: ((err: null, stdout: string, stderr: string) => void) | undefined;

    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(
        (
          _binary: string,
          _args: string[],
          _options: unknown,
          cb: (err: null, stdout: string, stderr: string) => void,
        ) => {
          callback = cb;
          return child;
        },
      ),
      spawn: vi.fn(),
    }));

    const { execCommand: mockedExecCommand } = await import("./exec.js");
    const resultPromise = mockedExecCommand("slow", [], "/tmp");

    await vi.advanceTimersByTimeAsync(60_001);
    expect(child.kill).not.toHaveBeenCalled();

    callback?.(null, "done", "");
    await expect(resultPromise).resolves.toEqual({ stdout: "done", stderr: "", exitCode: 0 });
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

  it("does not enforce a Thor-side streaming timeout", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    });

    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawn: vi.fn(() => child),
    }));

    const { execCommandStream: mockedExecCommandStream } = await import("./exec.js");
    const resultPromise = mockedExecCommandStream("slow", [], "/tmp", {
      onStdout: () => {},
      onStderr: () => {},
    });

    await vi.advanceTimersByTimeAsync(300_001);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit("close", 0);
    await expect(resultPromise).resolves.toBe(0);
  });
});
