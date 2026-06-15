import { GhIssueCreateApprovalArgsSchema } from "@thor/common";
import type { ApprovalAction } from "./approval-store.ts";
import {
  fail,
  type ApprovalExecResult,
  type ApprovalExecutor,
  type ApprovalOutcome,
  type ApprovalPlan,
  type ApprovalService,
} from "./approval-service.ts";
import { execCommand } from "./exec.ts";
import { registerCreatedIssueCorrelationAlias } from "./gh-issue-alias.ts";

/** The exact command an approved CLI action runs. */
export interface CliCommand {
  bin: string;
  args: string[];
  cwd: string;
}

/**
 * Configures one approvable CLI command (e.g. `gh issue create`) behind the
 * shared approval pipeline. Each CLI provides one definition; the generic
 * executor and request helper below do the rest. Add a new approvable CLI by
 * appending a definition to {@link CLI_APPROVAL_DEFINITIONS} — no new executor
 * or resolver wiring required.
 */
export interface CliApprovalDefinition {
  /** Approval store namespace; also the payload `proxyName`. */
  store: string;
  /** Approval tool id persisted in the action and matched by presentation. */
  tool: string;
  /** Human-facing label used in fail-closed messages (e.g. "gh issue create"). */
  displayName: string;
  /**
   * Validate + build the args persisted in the pending action from the request.
   * May throw to reject a malformed request. The stored args must capture the
   * exact, reviewed command (including any server-added flags).
   */
  buildRequestArgs(input: { cwd: string; args: string[] }): Record<string, unknown>;
  /**
   * Recover the command to run from a stored action at approval time. Return an
   * error string to fail closed (e.g. a corrupt stored action).
   */
  resolveCommand(action: ApprovalAction): CliCommand | { error: string };
  /** Optional side effect after a successful run (e.g. alias registration). */
  onSuccess?(action: ApprovalAction, command: CliCommand, stdout: string): void;
}

export interface CliApprovalRequest {
  cwd: string;
  args: string[];
  sessionId?: string;
  callId?: string;
}

async function runCliApproval(
  def: CliApprovalDefinition,
  action: ApprovalAction,
  execCommandFn: typeof execCommand,
): Promise<ApprovalOutcome> {
  const command = def.resolveCommand(action);
  if ("error" in command) {
    return { ok: false, stdout: "", stderr: command.error, sideEffectAttempted: false };
  }
  const result = await execCommandFn(command.bin, command.args, command.cwd);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      stdout: result.stdout,
      stderr: result.stderr || `${command.bin} exited with code ${result.exitCode}`,
      sideEffectAttempted: true,
    };
  }
  def.onSuccess?.(action, command, result.stdout);
  return { ok: true, stdout: result.stdout, stderr: "", sideEffectAttempted: true };
}

/**
 * Local executor for a CLI approval: runs the approved command directly via the
 * CLI. No MCP upstream is involved, so there is no resolution-time fail-closed
 * step — the plan executes the stored command.
 */
export function createCliApprovalExecutor(
  def: CliApprovalDefinition,
  execCommandFn: typeof execCommand,
): ApprovalExecutor {
  return {
    async resolve(action): Promise<ApprovalPlan> {
      return { logContext: {}, execute: () => runCliApproval(def, action, execCommandFn) };
    },
  };
}

/**
 * Validate a CLI command and post it for human approval through the shared
 * engine. Fails closed when no Thor session is bound. `input.args` must already
 * carry any server-added flags so the approved side effect matches the reviewed
 * command.
 */
export async function requestCliApproval(
  approvalService: ApprovalService,
  def: CliApprovalDefinition,
  input: CliApprovalRequest,
): Promise<ApprovalExecResult> {
  if (!input.sessionId) {
    return fail(`Approval required for "${def.displayName}": missing Thor session id`);
  }
  const args = def.buildRequestArgs({ cwd: input.cwd, args: input.args });
  return approvalService.createPending({
    storeName: def.store,
    tool: def.tool,
    displayName: def.displayName,
    args,
    sessionId: input.sessionId,
    ...(input.callId ? { callId: input.callId } : {}),
  });
}

/**
 * Pull display-only fields out of the effective `gh issue create` args so the
 * Slack approval card can show title/body/labels/assignees without re-parsing
 * the command. The full command is still stored and executed verbatim.
 */
function parseGhIssueDisplay(args: string[]): {
  title?: string;
  bodyPreview?: string;
  labels?: string[];
  assignees?: string[];
} {
  const values = (names: string[]) => {
    const found: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      const name = names.find((n) => arg === n || arg.startsWith(`${n}=`));
      if (!name) continue;
      if (arg === name && i + 1 < args.length) found.push(args[++i]);
      else if (arg.startsWith(`${name}=`)) found.push(arg.slice(name.length + 1));
    }
    return found;
  };
  const title = values(["--title", "-t"])[0];
  const body = values(["--body", "-b"])[0];
  const labels = values(["--label", "-l"]).flatMap((v) => v.split(",").filter(Boolean));
  const assignees = values(["--assignee", "-a"]).flatMap((v) => v.split(",").filter(Boolean));
  return {
    ...(title ? { title } : {}),
    ...(body ? { bodyPreview: body.length > 700 ? `${body.slice(0, 700)}…` : body } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(assignees.length > 0 ? { assignees } : {}),
  };
}

/** `gh issue create` — the first CLI command gated behind human approval. */
const ghIssueCreate: CliApprovalDefinition = {
  store: "gh",
  tool: "ghIssueCreate",
  displayName: "gh issue create",
  buildRequestArgs: ({ cwd, args }) =>
    GhIssueCreateApprovalArgsSchema.parse({ cwd, args, ...parseGhIssueDisplay(args) }),
  resolveCommand: (action) => {
    const parsed = GhIssueCreateApprovalArgsSchema.safeParse(action.args);
    if (!parsed.success) {
      return {
        error: `Stored gh issue create approval action ${action.id} is invalid: ${parsed.error.message}`,
      };
    }
    return { bin: "gh", args: parsed.data.args, cwd: parsed.data.cwd };
  },
  onSuccess: (action, command, stdout) =>
    registerCreatedIssueCorrelationAlias(action.origin?.sessionId, command.cwd, stdout),
};

/** Every CLI command gated behind approval. Add new CLIs here. */
export const CLI_APPROVAL_DEFINITIONS: CliApprovalDefinition[] = [ghIssueCreate];

export function getCliApprovalDefinition(store: string): CliApprovalDefinition {
  const def = CLI_APPROVAL_DEFINITIONS.find((d) => d.store === store);
  if (!def) throw new Error(`No CLI approval definition registered for store "${store}"`);
  return def;
}

/** Register every CLI approval definition's executor with the shared engine. */
export function registerCliApprovals(
  approvalService: ApprovalService,
  execCommandFn: typeof execCommand,
): void {
  for (const def of CLI_APPROVAL_DEFINITIONS) {
    approvalService.register(def.store, createCliApprovalExecutor(def, execCommandFn));
  }
}
