/**
 * SandboxManager — lifecycle management for Daytona sandboxes.
 *
 * Maps worktree paths to sandbox IDs. Handles:
 * - getOrCreate with per-worktree locking (D9)
 * - destroy on worktree removal
 * - reconcile on startup to clean up orphaned sandboxes (D8)
 */

import { existsSync } from "node:fs";
import { createLogger, logInfo, logError } from "@thor/common";
import type { SandboxProvider } from "./provider.js";

const log = createLogger("sandbox-manager");

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "node:22-slim";
const LABEL_THOR = "thor";
const LABEL_WORKTREE = "worktree";

export class SandboxManager {
  /** worktree path → sandbox ID */
  private sandboxes = new Map<string, string>();
  /** worktree path → in-flight creation promise (D9: per-worktree lock) */
  private creating = new Map<string, Promise<string>>();

  constructor(private provider: SandboxProvider) {}

  /**
   * Get existing sandbox for this worktree, or create one.
   * Concurrent calls for the same worktree await a single creation.
   */
  async getOrCreate(cwd: string): Promise<string> {
    // Fast path: already cached
    const existing = this.sandboxes.get(cwd);
    if (existing) return existing;

    // Lock path: another call is already creating for this worktree
    const inflight = this.creating.get(cwd);
    if (inflight) return inflight;

    // Create new sandbox
    const promise = this.doCreate(cwd);
    this.creating.set(cwd, promise);

    try {
      const sandboxId = await promise;
      this.sandboxes.set(cwd, sandboxId);
      return sandboxId;
    } finally {
      this.creating.delete(cwd);
    }
  }

  private async doCreate(cwd: string): Promise<string> {
    logInfo(log, "sandbox_creating", { cwd });
    const sandboxId = await this.provider.create({
      image: SANDBOX_IMAGE,
      labels: { [LABEL_THOR]: "true", [LABEL_WORKTREE]: cwd },
    });
    logInfo(log, "sandbox_created", { cwd, sandboxId });
    return sandboxId;
  }

  /** Get sandbox ID for a worktree, or null if none exists. */
  get(cwd: string): string | undefined {
    return this.sandboxes.get(cwd);
  }

  /** Destroy sandbox for a worktree (e.g. after git worktree remove). */
  async destroy(cwd: string): Promise<void> {
    const sandboxId = this.sandboxes.get(cwd);
    if (!sandboxId) return;

    logInfo(log, "sandbox_destroying", { cwd, sandboxId });
    this.sandboxes.delete(cwd);
    try {
      await this.provider.destroy(sandboxId);
    } catch (err) {
      logError(log, "sandbox_destroy_error", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Reconcile sandbox state on startup (D8).
   * Lists all Thor-labeled sandboxes, destroys orphans, re-populates the Map.
   */
  async reconcile(): Promise<void> {
    logInfo(log, "sandbox_reconcile_start", {});
    try {
      const sandboxes = await this.provider.list({ [LABEL_THOR]: "true" });

      for (const sb of sandboxes) {
        const worktree = sb.labels[LABEL_WORKTREE];
        if (!worktree || !existsSync(worktree)) {
          logInfo(log, "sandbox_reconcile_destroy_orphan", { sandboxId: sb.id, worktree });
          try {
            await this.provider.destroy(sb.id);
          } catch (err) {
            logError(
              log,
              "sandbox_reconcile_destroy_error",
              err instanceof Error ? err.message : String(err),
            );
          }
        } else {
          logInfo(log, "sandbox_reconcile_restore", { sandboxId: sb.id, worktree });
          this.sandboxes.set(worktree, sb.id);
        }
      }

      logInfo(log, "sandbox_reconcile_done", { count: this.sandboxes.size });
    } catch (err) {
      // Non-fatal: if Daytona is unreachable on startup, log and continue
      logError(log, "sandbox_reconcile_error", err instanceof Error ? err.message : String(err));
    }
  }
}
