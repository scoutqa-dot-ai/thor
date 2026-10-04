import {
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  openSync,
  closeSync,
  fstatSync,
} from "node:fs";
import { join } from "node:path";
import { ExecResultSchema, isUuidV7, mintAnchor, type ExecResult } from "@thor/common";
import { z } from "zod/v4";
import { GenericMcpApprovalSchema, type GenericMcpApproval } from "@thor/common";
import {
  acquireApprovalFileLock,
  ensurePrivateApprovalDirectory,
  replacePrivateApprovalJson,
  flushApprovalDirectory,
} from "./mcp-approval-owner.js";

const ApprovalActionSchema = z
  .object({
    id: z.string(),
    upstream: z.string(),
    status: z.enum(["pending", "approved", "rejected"]),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    origin: z
      .object({
        sessionId: z.string().min(1).optional(),
        trigger: z
          .object({
            anchorId: z.string().min(1),
            triggerId: z.string().min(1).optional(),
          })
          .optional(),
      })
      .optional(),
    createdAt: z.string(),
    dateSegment: z.string(),
    resolvedAt: z.string().optional(),
    reviewer: z.string().optional(),
    result: ExecResultSchema.optional(),
    error: z.string().optional(),
    reason: z.string().optional(),
    notification: z
      .object({
        provider: z.literal("slack"),
        channel: z.string().min(1),
        threadTs: z.string().min(1),
        messageTs: z.string().min(1).optional(),
        postedAt: z.string().min(1).optional(),
      })
      .optional(),
  })
  .superRefine((action, ctx) => {
    if (action.status === "approved" && !action.result) {
      ctx.addIssue({
        code: "custom",
        message: "approved approval actions must include a valid ExecResult result",
        path: ["result"],
      });
    }
  });

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

export class ApprovalStore {
  constructor(
    private readonly baseDir: string,
    private readonly upstream: string,
  ) {}

  buildPending(
    tool: string,
    args: Record<string, unknown>,
    origin?: ApprovalAction["origin"],
    notification?: ApprovalAction["notification"],
  ): ApprovalAction {
    const now = new Date();
    return {
      id: mintAnchor(),
      upstream: this.upstream,
      status: "pending",
      tool,
      args,
      ...(origin && (origin.sessionId || origin.trigger) && { origin }),
      ...(notification && { notification }),
      createdAt: now.toISOString(),
      dateSegment: now.toISOString().slice(0, 10),
    };
  }

  get(id: string): ApprovalAction | undefined {
    // IDs are minted by mintAnchor() (UUIDv7). Reject anything else before any
    // FS work — defends against path-traversal probes and catches caller bugs.
    if (!isUuidV7(id)) return undefined;
    const dateDirs = this.listDateDirsIn(this.baseDir);
    for (const dateDir of dateDirs) {
      const filePath = join(this.baseDir, dateDir, `${id}.json`);
      if (existsSync(filePath)) {
        const raw: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
        if (typeof raw === "object" && raw !== null && ("version" in raw || "operation" in raw))
          throw new Error("Versioned approval cannot use legacy reader");
        return ApprovalActionSchema.parse(raw);
      }
    }
    return undefined;
  }

  update(action: ApprovalAction): void {
    this.write(action);
  }

  reject(id: string, reviewer?: string, reason?: string): ApprovalAction | undefined {
    const action = this.get(id);
    if (!action || action.status !== "pending") return undefined;
    return this.rejectLoaded(action, reviewer, reason);
  }

  rejectLoaded(action: ApprovalAction, reviewer?: string, reason?: string): ApprovalAction {
    action.status = "rejected";
    action.resolvedAt = new Date().toISOString();
    action.reviewer = reviewer;
    if (reason) action.reason = reason;

    this.write(action);
    return action;
  }

  approveLoaded(
    action: ApprovalAction,
    result: ExecResult,
    reviewer?: string,
    reason?: string,
  ): ApprovalAction {
    action.status = "approved";
    action.resolvedAt = new Date().toISOString();
    action.reviewer = reviewer;
    action.result = ExecResultSchema.parse(result);
    delete action.error;
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
          const raw: unknown = JSON.parse(readFileSync(join(dirPath, file), "utf-8"));
          if (typeof raw === "object" && raw !== null && ("version" in raw || "operation" in raw))
            continue;
          const action = ApprovalActionSchema.parse(raw);
          if (action.status === "pending") pending.push(action);
        } catch {
          // Skip corrupt files.
        }
      }
    }
    return pending;
  }

  /** New representation selection is explicit; malformed versioned records never parse as legacy. */
  getGeneric(id: string): GenericMcpApproval | undefined {
    if (!isUuidV7(id)) return undefined;
    ensurePrivateApprovalDirectory(this.baseDir);
    for (const date of this.listDateDirsIn(this.baseDir)) {
      ensurePrivateApprovalDirectory(join(this.baseDir, date));
      const path = join(this.baseDir, date, `${id}.json`);
      if (!existsSync(path)) continue;
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.size > 128 * 1024 ||
          stat.nlink !== 1 ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o7777) !== 0o600
        )
          throw new Error("MCP approval record permissions invalid");
        const text = readFileSync(fd, "utf8");
        const raw: unknown = JSON.parse(text);
        const record = GenericMcpApprovalSchema.parse(raw);
        // Version 1 private records are emitted only by this canonical writer. Duplicate
        // fields or a decoder-stripped payload cannot downgrade consumed proof to pending.
        if (text !== JSON.stringify(record) + "\n")
          throw new Error("MCP approval record encoding invalid");
        if (record.id !== id || record.dateSegment !== date)
          throw new Error("MCP approval record identity invalid");
        return record;
      } finally {
        closeSync(fd);
      }
    }
    return undefined;
  }

  /** Atomic file/directory-flushed writes belong only to the new private root. */
  updateGeneric(action: GenericMcpApproval): void {
    const record = GenericMcpApprovalSchema.parse(action);
    ensurePrivateApprovalDirectory(this.baseDir);
    const dir = join(this.baseDir, record.dateSegment);
    ensurePrivateApprovalDirectory(dir);
    flushApprovalDirectory(this.baseDir);
    replacePrivateApprovalJson(join(dir, `${record.id}.json`), record);
  }

  /** One stable inode guards read, durable claim, I/O and result replacement. Busy never grants dispatch. */
  async withGenericLock<T>(
    id: string,
    work: () => Promise<T>,
  ): Promise<{ status: "ok"; value: T } | { status: "busy" }> {
    if (!isUuidV7(id)) return { status: "busy" };
    const locks = join(this.baseDir, "locks");
    ensurePrivateApprovalDirectory(locks);
    const release = await acquireApprovalFileLock(join(locks, `${id}.lock`));
    if (!release) return { status: "busy" };
    try {
      return { status: "ok", value: await work() };
    } finally {
      release();
    }
  }

  /** Private storage listing is internal; the service must filter every returned projection by reader scope. */
  listGeneric(): GenericMcpApproval[] {
    const records: GenericMcpApproval[] = [];
    for (const date of this.listDateDirsIn(this.baseDir)) {
      for (const file of readdirSync(join(this.baseDir, date)).filter((file) =>
        file.endsWith(".json"),
      )) {
        const record = this.getGeneric(file.slice(0, -5));
        if (record) records.push(record);
      }
    }
    return records;
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
