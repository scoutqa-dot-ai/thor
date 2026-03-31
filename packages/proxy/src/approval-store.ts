/**
 * Filesystem-based approval store.
 *
 * One JSON file per action, segmented by date:
 *   data/approvals/2026-03-12/{actionId}.json
 *
 * Each file contains the full lifecycle: created as "pending",
 * updated in-place on resolution.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";

const ApprovalActionSchema = z.object({
  id: z.string(),
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
    private readonly fallbackDirs: string[] = [],
  ) {}

  /** Create a pending approval action. Returns the action. */
  create(tool: string, args: Record<string, unknown>): ApprovalAction {
    const now = new Date();
    const action: ApprovalAction = {
      id: randomUUID(),
      status: "pending",
      tool,
      args,
      createdAt: now.toISOString(),
      dateSegment: now.toISOString().slice(0, 10),
    };
    this.write(action);
    return action;
  }

  /** Get an action by ID. Scans date directories (most recent first), including fallback dirs. */
  get(id: string): ApprovalAction | undefined {
    // Search primary dir, then fallback dirs (for legacy approval actions)
    for (const dir of [this.baseDir, ...this.fallbackDirs]) {
      const dateDirs = this.listDateDirsIn(dir);
      for (const dateDir of dateDirs) {
        const filePath = join(dir, dateDir, `${id}.json`);
        if (existsSync(filePath)) {
          return ApprovalActionSchema.parse(JSON.parse(readFileSync(filePath, "utf-8")));
        }
      }
    }
    return undefined;
  }

  /** Update an action in-place. */
  update(action: ApprovalAction): void {
    this.write(action);
  }

  /** Resolve an action as approved or rejected. Returns the updated action, or undefined if not found/already resolved. */
  resolve(
    id: string,
    decision: "approved" | "rejected",
    reviewer?: string,
    reason?: string,
  ): ApprovalAction | undefined {
    const action = this.get(id);
    if (!action || action.status !== "pending") return undefined;

    action.status = decision;
    action.resolvedAt = new Date().toISOString();
    action.reviewer = reviewer;
    if (reason) action.reason = reason;

    this.write(action);
    return action;
  }

  private write(action: ApprovalAction): void {
    const dir = join(this.baseDir, action.dateSegment);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${action.id}.json`), JSON.stringify(action, null, 2) + "\n");
  }

  /** List date directories in reverse order (most recent first). */
  private listDateDirsIn(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
  }
}
