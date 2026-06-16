import { describe, expect, it, vi } from "vitest";
import type { ConfigLoader, ExecResult } from "@thor/common";
import type { ApprovalAction } from "./approval-store.ts";
import type { ApprovalService } from "./approval-service.ts";
import type { execCommand } from "./exec.ts";
import {
  createCliApprovalExecutor,
  getCliApprovalDefinition,
  requestCliApproval,
  type CliApprovalDefinition,
} from "./cli-approval.ts";

// A synthetic, non-gh CLI. The point of these tests is to prove the framework
// is genuinely CLI-agnostic — gh's own behavior is covered end-to-end through
// the HTTP endpoints in mcp-handler.test.ts / gh-disclaimer.test.ts.
function fakeCliDefinition(onSuccess?: CliApprovalDefinition["onSuccess"]): CliApprovalDefinition {
  return {
    store: "faketool",
    tool: "fakeToolRun",
    displayName: "faketool run",
    buildRequestArgs: ({ cwd, args }) => ({ cwd, args, marker: "built" }),
    resolveCommand: (action) =>
      action.args.broken
        ? { error: "stored action invalid" }
        : { bin: "faketool", args: ["run", "--x"], cwd: "/work" },
    ...(onSuccess ? { onSuccess } : {}),
  };
}

function pendingAction(args: Record<string, unknown>): ApprovalAction {
  return {
    id: "019e0000-0000-7000-8000-000000000001",
    upstream: "faketool",
    status: "pending",
    tool: "fakeToolRun",
    args,
    origin: { sessionId: "s1" },
    createdAt: "2026-06-02T00:00:00.000Z",
    dateSegment: "2026-06-02",
  };
}

function execStub(result: ExecResult) {
  return vi.fn(async () => result) as unknown as typeof execCommand;
}

// The fake CLI definition does not read config, so a no-op loader suffices.
const fakeDeps = { getConfig: (() => ({ users: [] })) as unknown as ConfigLoader };

describe("cli-approval framework", () => {
  describe("createCliApprovalExecutor", () => {
    it("runs the resolved command and fires onSuccess on a clean exit", async () => {
      const onSuccess = vi.fn();
      const exec = execStub({ stdout: "https://issue/1", stderr: "", exitCode: 0 });
      const executor = createCliApprovalExecutor(fakeCliDefinition(onSuccess), exec, fakeDeps);

      const action = pendingAction({});
      const plan = await executor.resolve(action);
      const outcome = await plan.execute();

      expect(exec).toHaveBeenCalledWith("faketool", ["run", "--x"], "/work", {});
      expect(outcome).toEqual({
        ok: true,
        stdout: "https://issue/1",
        stderr: "",
        sideEffectAttempted: true,
      });
      expect(onSuccess).toHaveBeenCalledWith(
        action,
        { bin: "faketool", args: ["run", "--x"], cwd: "/work" },
        "https://issue/1",
      );
    });

    it("reports a non-zero exit as an attempted failure without firing onSuccess", async () => {
      const onSuccess = vi.fn();
      const exec = execStub({ stdout: "partial", stderr: "", exitCode: 3 });
      const executor = createCliApprovalExecutor(fakeCliDefinition(onSuccess), exec, fakeDeps);

      const outcome = await (await executor.resolve(pendingAction({}))).execute();

      expect(outcome).toEqual({
        ok: false,
        stdout: "partial",
        stderr: "faketool exited with code 3",
        sideEffectAttempted: true,
      });
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("fails closed without running the command when the stored action is unusable", async () => {
      const exec = execStub({ stdout: "", stderr: "", exitCode: 0 });
      const executor = createCliApprovalExecutor(fakeCliDefinition(), exec, fakeDeps);

      const outcome = await (await executor.resolve(pendingAction({ broken: true }))).execute();

      expect(outcome).toEqual({
        ok: false,
        stdout: "",
        stderr: "stored action invalid",
        sideEffectAttempted: false,
      });
      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe("requestCliApproval", () => {
    it("fails closed and never creates a pending action without a Thor session", async () => {
      const createPending = vi.fn();
      const service = { createPending } as unknown as ApprovalService;

      const result = await requestCliApproval(service, fakeCliDefinition(), {
        cwd: "/w",
        args: ["run"],
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Approval required for "faketool run": missing Thor session id',
      );
      expect(createPending).not.toHaveBeenCalled();
    });

    it("builds the definition's args and posts a pending approval for its store", async () => {
      const createPending = vi.fn(async () => ({ stdout: "queued", stderr: "", exitCode: 0 }));
      const service = { createPending } as unknown as ApprovalService;

      const result = await requestCliApproval(service, fakeCliDefinition(), {
        cwd: "/w",
        args: ["run"],
        sessionId: "s1",
        callId: "c1",
      });

      expect(createPending).toHaveBeenCalledWith({
        storeName: "faketool",
        tool: "fakeToolRun",
        displayName: "faketool run",
        args: { cwd: "/w", args: ["run"], marker: "built" },
        sessionId: "s1",
        callId: "c1",
      });
      expect(result.stdout).toBe("queued");
    });
  });

  describe("getCliApprovalDefinition", () => {
    it("resolves the registered gh definition", () => {
      const def = getCliApprovalDefinition("gh");
      expect(def.tool).toBe("ghIssueCreate");
      expect(def.displayName).toBe("gh issue create");
    });

    it("throws for an unregistered store rather than silently routing to MCP", () => {
      expect(() => getCliApprovalDefinition("nope")).toThrow(
        'No CLI approval definition registered for store "nope"',
      );
    });
  });
});
