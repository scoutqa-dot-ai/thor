import { EventEmitter } from "node:events";
import { describe, it, expect, vi, afterEach } from "vitest";
import { execCommand, execCommandStream } from "./exec.ts";

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

    const { execCommand: mockedExecCommand } = await import("./exec.ts");
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

    const { execCommandStream: mockedExecCommandStream } = await import("./exec.ts");
    const resultPromise = mockedExecCommandStream("slow", [], "/tmp", {
      onStdout: () => {},
      onStderr: () => {},
    });

    await vi.advanceTimersByTimeAsync(300_001);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit("close", 0);
    await expect(resultPromise).resolves.toBe(0);
  });

  it("aborts with SIGTERM, cleans up the abort listener, and resolves on close", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      exitCode: null as number | null,
      kill: vi.fn((signal?: string) => {
        child.killed = true;
        return signal !== undefined;
      }),
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    });

    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawn: vi.fn(() => child),
    }));

    const { execCommandStream: mockedExecCommandStream } = await import("./exec.ts");
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    const resultPromise = mockedExecCommandStream(
      "slow",
      [],
      "/tmp",
      { onStdout: () => {}, onStderr: () => {} },
      { signal: controller.signal },
    );

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.exitCode = 143;
    child.emit("close", 143);
    await expect(resultPromise).resolves.toBe(143);
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("escalates to SIGKILL after a grace period when the child does not exit", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      exitCode: null as number | null,
      kill: vi.fn((signal?: string) => signal !== undefined),
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    });

    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawn: vi.fn(() => child),
    }));

    const { execCommandStream: mockedExecCommandStream } = await import("./exec.ts");
    const controller = new AbortController();

    const resultPromise = mockedExecCommandStream(
      "slow",
      [],
      "/tmp",
      { onStdout: () => {}, onStderr: () => {} },
      { signal: controller.signal },
    );

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.exitCode = 137;
    child.emit("close", 137);
    await expect(resultPromise).resolves.toBe(137);
  });

  it("clears the SIGKILL escalation timer when the child exits during the grace period", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      exitCode: null as number | null,
      kill: vi.fn((signal?: string) => signal !== undefined),
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    });

    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawn: vi.fn(() => child),
    }));

    const { execCommandStream: mockedExecCommandStream } = await import("./exec.ts");
    const controller = new AbortController();

    const resultPromise = mockedExecCommandStream(
      "slow",
      [],
      "/tmp",
      { onStdout: () => {}, onStderr: () => {} },
      { signal: controller.signal },
    );

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.exitCode = 143;
    child.emit("close", 143);
    await expect(resultPromise).resolves.toBe(143);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  });
});
