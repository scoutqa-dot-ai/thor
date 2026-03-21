import { z } from "zod/v4";

export const SandboxStatusSchema = z.enum([
  "creating",
  "ready",
  "busy",
  "stopped",
  "error",
  "destroying",
]);

export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

export const SandboxIdentitySchema = z.object({
  worktreePath: z.string().min(1),
  repo: z.string().optional(),
  branch: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
});

export type SandboxIdentity = z.infer<typeof SandboxIdentitySchema>;

export const SandboxPreviewSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().optional(),
});

export type SandboxPreview = z.infer<typeof SandboxPreviewSchema>;

export const SandboxRecordSchema = z.object({
  version: z.literal(1),
  provider: z.string().min(1),
  sandboxId: z.string().min(1),
  identity: SandboxIdentitySchema,
  status: SandboxStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastAttachedAt: z.string().optional(),
  lastMaterializedAt: z.string().optional(),
  lastError: z.string().optional(),
  preview: SandboxPreviewSchema.optional(),
  metadata: z.record(z.string(), z.string()).default({}),
});

export type SandboxRecord = z.infer<typeof SandboxRecordSchema>;

export interface SandboxExecRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SandboxExecEvent {
  type: "stdout" | "stderr" | "status";
  data: string;
}

export interface SandboxExecResult {
  exitCode: number;
  output?: string;
}

export interface SandboxMaterializeRequest {
  worktreePath: string;
  baseRef?: string;
  includeUncommitted?: boolean;
}

export interface SandboxExportResult {
  filesChanged: number;
  filesDeleted: number;
  artifactPaths: string[];
}

export interface SandboxProvider {
  readonly providerName: string;
  findByWorktree(identity: SandboxIdentity): Promise<SandboxRecord | undefined>;
  create(identity: SandboxIdentity): Promise<SandboxRecord>;
  get(sandboxId: string): Promise<SandboxRecord | undefined>;
  stop(sandboxId: string): Promise<void>;
  resume(sandboxId: string): Promise<SandboxRecord>;
  destroy(sandboxId: string): Promise<void>;
  exec(
    sandboxId: string,
    request: SandboxExecRequest,
    onEvent?: (event: SandboxExecEvent) => void,
  ): Promise<SandboxExecResult>;
  materializeWorkspace(sandboxId: string, request: SandboxMaterializeRequest): Promise<void>;
  exportWorkspace(sandboxId: string, worktreePath: string): Promise<SandboxExportResult>;
  getPreview(sandboxId: string, port: number): Promise<SandboxPreview>;
}
