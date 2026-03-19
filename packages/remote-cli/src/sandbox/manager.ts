/**
 * SandboxManager — lifecycle management for Daytona sandboxes.
 *
 * Always queries the remote API for sandbox state — no in-memory cache.
 * Only keeps in-flight creation promises to deduplicate concurrent requests (D9).
 */

import { createLogger, logInfo, logError } from "@thor/common";
import type { SandboxProvider } from "./provider.js";

const log = createLogger("sandbox-manager");

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "daytona-medium";
const LABEL_THOR = "thor";
const LABEL_WORKTREE = "worktree";

export class SandboxManager {
  /** worktree path → in-flight creation promise (D9: per-worktree lock) */
  private creating = new Map<string, Promise<string>>();

  constructor(private provider: SandboxProvider) {}

  /**
   * Get existing sandbox for this worktree, or create one.
   * Concurrent calls for the same worktree await a single creation.
   */
  async getOrCreate(cwd: string): Promise<string> {
    // Check remote for existing sandbox
    const existing = await this.find(cwd);
    if (existing) return existing;

    // Lock path: another call is already creating for this worktree
    const inflight = this.creating.get(cwd);
    if (inflight) return inflight;

    // Create new sandbox
    const promise = this.doCreate(cwd);
    this.creating.set(cwd, promise);

    try {
      return await promise;
    } finally {
      this.creating.delete(cwd);
    }
  }

  /** Find sandbox ID for a worktree by querying the remote API. */
  async find(cwd: string): Promise<string | undefined> {
    try {
      const sandboxes = await this.provider.list({
        [LABEL_THOR]: "true",
        [LABEL_WORKTREE]: cwd,
      });
      return sandboxes[0]?.id;
    } catch (err) {
      logError(log, "sandbox_find_error", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  private async doCreate(cwd: string): Promise<string> {
    const labels = { [LABEL_THOR]: "true", [LABEL_WORKTREE]: cwd };

    logInfo(log, "sandbox_creating", { cwd });
    const sandboxId = await this.provider.create({ image: SANDBOX_IMAGE, labels });
    logInfo(log, "sandbox_created", { cwd, sandboxId });
    return sandboxId;
  }

  /** Destroy sandbox for a worktree (e.g. after git worktree remove). */
  async destroy(cwd: string): Promise<void> {
    const sandboxId = await this.find(cwd);
    if (!sandboxId) return;

    logInfo(log, "sandbox_destroying", { cwd, sandboxId });
    try {
      await this.provider.destroy(sandboxId);
    } catch (err) {
      logError(log, "sandbox_destroy_error", err instanceof Error ? err.message : String(err));
    }
  }
}
