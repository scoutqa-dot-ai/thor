import express, { type Express, type Request, type Response } from "express";
import { readFileSync, writeFileSync, renameSync, statSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createLogger,
  logError,
  logInfo,
  logWarn,
  validateWorkspaceConfig,
  type WorkspaceConfig,
} from "@thor/common";
import { renderConfigPage, renderStatusFragment, type Issue } from "./views.js";

const log = createLogger("admin");

export interface AdminAppConfig {
  configPath: string;
  auditLogPath: string;
}

export function createAdminApp(cfg: AdminAppConfig): Express {
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: "256kb" }));
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/admin/config", (req: Request, res: Response) => {
    const { text, mtime, error } = readConfigText(cfg.configPath);
    res.type("html").send(
      renderConfigPage({
        raw: text,
        mtime,
        user: req.header("X-Vouch-User") ?? null,
        readError: error,
        parseError: null,
        issues: [],
        savedAt: null,
        savedBy: null,
      }),
    );
  });

  app.post("/admin/config", (req: Request, res: Response) => {
    const raw = typeof req.body?.config === "string" ? req.body.config : "";
    const isHtmx = req.header("HX-Request") === "true";
    const user = req.header("X-Vouch-User") ?? null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respondError(res, isHtmx, raw, user, `JSON parse error: ${msg}`, []);
      return;
    }

    const result = validateWorkspaceConfig(parsed);
    if (!result.ok) {
      respondError(res, isHtmx, raw, user, "Validation failed", result.issues);
      return;
    }

    const serialized = JSON.stringify(result.data, null, 2) + "\n";
    try {
      atomicWrite(cfg.configPath, serialized);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(log, "config_write_failed", { error: msg, user });
      respondError(res, isHtmx, raw, user, `Write failed: ${msg}`, []);
      return;
    }

    const savedAt = new Date().toISOString();
    logInfo(log, "config_saved", { user, savedAt });
    appendAudit(cfg.auditLogPath, {
      ts: savedAt,
      user,
      event: "config_saved",
      bytes: Buffer.byteLength(serialized, "utf-8"),
      config: result.data,
    });

    if (isHtmx) {
      res
        .type("html")
        .send(renderStatusFragment({ savedAt, savedBy: user, error: null, issues: [] }));
      return;
    }
    res.redirect("/admin/config");
  });

  // Any other path redirects to the config editor.
  app.use((_req, res) => {
    res.redirect("/admin/config");
  });

  return app;
}

function readConfigText(path: string): {
  text: string;
  mtime: string | null;
  error: string | null;
} {
  try {
    const text = readFileSync(path, "utf-8");
    const mtime = statSync(path).mtime.toISOString();
    return { text, mtime, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: "", mtime: null, error: msg };
  }
}

function atomicWrite(path: string, data: string): void {
  const tmp = join(dirname(path), `.config.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o644 });
  renameSync(tmp, path);
}

interface AuditEntry {
  ts: string;
  user: string | null;
  event: "config_saved";
  bytes: number;
  config: WorkspaceConfig;
}

function appendAudit(path: string, entry: AuditEntry): void {
  try {
    appendFileSync(path, JSON.stringify(entry) + "\n", { encoding: "utf-8", mode: 0o644 });
  } catch (err) {
    // Non-fatal: the primary config write already succeeded. We must not
    // fail the HTTP response after the rename, since the new config is
    // already live for every other service.
    logWarn(log, "audit_append_failed", {
      path,
      user: entry.user,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function respondError(
  res: Response,
  isHtmx: boolean,
  raw: string,
  user: string | null,
  message: string,
  issues: Issue[],
): void {
  if (isHtmx) {
    res
      .status(400)
      .type("html")
      .send(renderStatusFragment({ savedAt: null, savedBy: null, error: message, issues }));
    return;
  }
  res
    .status(400)
    .type("html")
    .send(
      renderConfigPage({
        raw,
        mtime: null,
        user,
        readError: null,
        parseError: message,
        issues,
        savedAt: null,
        savedBy: null,
      }),
    );
}
