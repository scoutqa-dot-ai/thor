import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";

const ApprovalActionSchema = z.object({
  id: z.string(),
  upstream: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  dateSegment: z.string(),
  resolvedAt: z.string().optional(),
  reviewer: z.string().optional(),
  result: z.any().optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
});

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

export class ApprovalStore {
  constructor(
    private readonly baseDir: string,
    private readonly upstream: string,
  ) {}

  create(tool: string, args: Record<string, unknown>): ApprovalAction {
    const now = new Date();
    const action: ApprovalAction = {
      id: randomUUID(),
      upstream: this.upstream,
      status: "pending",
      tool,
      args,
      createdAt: now.toISOString(),
      dateSegment: now.toISOString().slice(0, 10),
    };
    this.write(action);
    return action;
  }

  get(id: string): ApprovalAction | undefined {
    const dateDirs = this.listDateDirsIn(this.baseDir);
    for (const dateDir of dateDirs) {
      const filePath = join(this.baseDir, dateDir, `${id}.json`);
      if (existsSync(filePath)) {
        return ApprovalActionSchema.parse(JSON.parse(readFileSync(filePath, "utf-8")));
      }
    }
    return undefined;
  }

  update(action: ApprovalAction): void {
    this.write(action);
  }

  resolve(
    id: string,
    decision: "approved" | "rejected",
    reviewer?: string,
    reason?: string,
  ): ApprovalAction | undefined {
    const action = this.get(id);
    if (!action || action.status !== "pending") return undefined;
    return this.resolveLoaded(action, decision, reviewer, reason);
  }

  resolveLoaded(
    action: ApprovalAction,
    decision: "approved" | "rejected",
    reviewer?: string,
    reason?: string,
  ): ApprovalAction {
    action.status = decision;
    action.resolvedAt = new Date().toISOString();
    action.reviewer = reviewer;
    if (reason) action.reason = reason;

    this.write(action);
    return action;
  }

  listPending(): ApprovalAction[] {
    const pending: ApprovalAction[] = [];
    const dateDirs = this.listDateDirsIn(this.baseDir);
    for (const dateDir of dateDirs) {
      const dirPath = join(this.baseDir, dateDir);
      let files: string[];
      try {
        files = readdirSync(dirPath).filter((file) => file.endsWith(".json"));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const action = ApprovalActionSchema.parse(
            JSON.parse(readFileSync(join(dirPath, file), "utf-8")),
          );
          if (action.status === "pending") pending.push(action);
        } catch {
          // Skip corrupt files.
        }
      }
    }
    return pending;
  }

  private write(action: ApprovalAction): void {
    const dir = join(this.baseDir, action.dateSegment);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${action.id}.json`), JSON.stringify(action, null, 2) + "\n");
  }

  private listDateDirsIn(dir: string): string[] {
    try {
      return readdirSync(dir)
        .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
}
