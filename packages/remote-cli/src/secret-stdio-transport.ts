import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { StdioSecretInput } from "@thor/common";

export interface SecretStdioServerParameters {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly secretInput: StdioSecretInput;
}

/**
 * MCP stdio transport that writes one secret through an anonymous child file
 * descriptor. The spawned process receives only the SDK's safe env allowlist;
 * the secret is never present in its environment or command line.
 */
export class SecretStdioClientTransport implements Transport {
  readonly #server: Omit<SecretStdioServerParameters, "secretInput">;
  readonly #readBuffer = new ReadBuffer();
  readonly #secretFd: 3;
  #secretContents: string | undefined;
  #process: ChildProcess | undefined;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(server: SecretStdioServerParameters) {
    const { secretInput, ...safeServer } = server;
    this.#server = safeServer;
    this.#secretFd = secretInput.fd;
    this.#secretContents = secretInput.getContents();
  }

  async start(): Promise<void> {
    if (this.#process) throw new Error("SecretStdioClientTransport already started");
    const secretContents = this.#secretContents;
    this.#secretContents = undefined;
    if (secretContents === undefined) throw new Error("Secret stdio input is unavailable");

    await new Promise<void>((resolve, reject) => {
      let startSettled = false;
      const child = spawn(this.#server.command, this.#server.args, {
        env: { ...getDefaultEnvironment(), ...this.#server.env },
        stdio: ["pipe", "pipe", "inherit", "pipe"],
        shell: false,
        windowsHide: process.platform === "win32",
      });
      this.#process = child;

      const rejectStart = (error: Error): void => {
        if (!startSettled) {
          startSettled = true;
          reject(error);
        }
      };

      child.once("error", (error) => {
        rejectStart(error);
        this.onerror?.(error);
      });
      child.once("spawn", () => {
        const secretStream = child.stdio[this.#secretFd] as Writable | null;
        if (!secretStream) {
          rejectStart(new Error("Secret stdio descriptor was not created"));
          child.kill();
          return;
        }
        secretStream.once("error", (error) => {
          rejectStart(error);
          this.onerror?.(error);
          child.kill();
        });
        secretStream.end(secretContents, () => {
          if (!startSettled) {
            startSettled = true;
            resolve();
          }
        });
      });
      child.once("close", () => {
        this.#process = undefined;
        if (!startSettled) rejectStart(new Error("Secret stdio child exited during startup"));
        this.onclose?.();
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.#readBuffer.append(chunk);
          this.#processReadBuffer();
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          void this.close();
        }
      });
      child.stdout?.on("error", (error) => this.onerror?.(error));
    });
  }

  #processReadBuffer(): void {
    while (true) {
      const message = this.#readBuffer.readMessage();
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  async close(): Promise<void> {
    if (this.#process) {
      const processToClose = this.#process;
      this.#process = undefined;
      const closePromise = new Promise<void>((resolve) => {
        processToClose.once("close", () => resolve());
      });
      try {
        processToClose.stdin?.end();
      } catch {
        // Continue with termination below.
      }
      await Promise.race([
        closePromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
      ]);
      if (processToClose.exitCode === null) {
        try {
          processToClose.kill("SIGTERM");
        } catch {
          // Process exited between the exit-code check and signal.
        }
        await Promise.race([
          closePromise,
          new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
        ]);
      }
      if (processToClose.exitCode === null) {
        try {
          processToClose.kill("SIGKILL");
        } catch {
          // Process exited between the exit-code check and signal.
        }
      }
    }
    this.#readBuffer.clear();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#process?.stdin;
    if (!stdin) throw new Error("Not connected");
    const serialized = serializeMessage(message);
    if (stdin.write(serialized)) return;
    await new Promise<void>((resolve) => stdin.once("drain", resolve));
  }
}
