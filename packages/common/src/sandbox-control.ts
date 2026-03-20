import type {
  SandboxIdentity,
  SandboxMaterializeRequest,
  SandboxProvider,
  SandboxRecord,
} from "./sandboxes.js";

export type EnsureSandboxAction = "created" | "resumed" | "reused";
export type SandboxProviderOperation = "lookup" | "create" | "resume" | "materialize" | "destroy";

export interface EnsureSandboxOptions {
  materialize?: "if-created" | "always" | "never";
  materializeRequest?: Omit<SandboxMaterializeRequest, "worktreePath">;
}

export interface EnsureSandboxResult {
  action: EnsureSandboxAction;
  materialized: boolean;
  record: SandboxRecord;
}

export class SandboxProviderError extends Error {
  readonly providerName: string;
  readonly operation: SandboxProviderOperation;

  constructor(providerName: string, operation: SandboxProviderOperation, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${providerName} sandbox ${operation} failed: ${detail}`, { cause });
    this.name = "SandboxProviderError";
    this.providerName = providerName;
    this.operation = operation;
  }
}

export async function ensureSandboxForWorktree(
  provider: SandboxProvider,
  identity: SandboxIdentity,
  options: EnsureSandboxOptions = {},
): Promise<EnsureSandboxResult> {
  const materializeMode = options.materialize ?? "if-created";

  let existing: SandboxRecord | undefined;
  try {
    existing = await provider.findByWorktree(identity);
  } catch (error) {
    throw new SandboxProviderError(provider.providerName, "lookup", error);
  }

  let action: EnsureSandboxAction;
  let record: SandboxRecord;

  if (!existing) {
    try {
      record = await provider.create(identity);
    } catch (error) {
      throw new SandboxProviderError(provider.providerName, "create", error);
    }
    action = "created";
  } else if (existing.status === "stopped") {
    try {
      record = await provider.resume(existing.sandboxId);
    } catch (error) {
      throw new SandboxProviderError(provider.providerName, "resume", error);
    }
    action = "resumed";
  } else {
    record = existing;
    action = "reused";
  }

  const shouldMaterialize =
    materializeMode === "always" || (materializeMode === "if-created" && action === "created");

  if (shouldMaterialize) {
    try {
      await provider.materializeWorkspace(record.sandboxId, {
        worktreePath: identity.worktreePath,
        ...options.materializeRequest,
      });
    } catch (error) {
      throw new SandboxProviderError(provider.providerName, "materialize", error);
    }
  }

  return {
    action,
    materialized: shouldMaterialize,
    record,
  };
}

export async function destroySandboxForWorktree(
  provider: SandboxProvider,
  identity: SandboxIdentity,
): Promise<boolean> {
  let existing: SandboxRecord | undefined;
  try {
    existing = await provider.findByWorktree(identity);
  } catch (error) {
    throw new SandboxProviderError(provider.providerName, "lookup", error);
  }

  if (!existing) {
    return false;
  }

  try {
    await provider.destroy(existing.sandboxId);
  } catch (error) {
    throw new SandboxProviderError(provider.providerName, "destroy", error);
  }

  return true;
}
