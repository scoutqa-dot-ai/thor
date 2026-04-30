import { existsSync, mkdirSync, readdirSync, rmSync, statSync, createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const root = process.env.WORKLOG_DIR || "/workspace/worklog";
const sessionsDir = join(root, "sessions");
const archiveAfterDays = Number.parseInt(process.env.SESSION_LOG_ARCHIVE_DAYS || "30", 10);
const deleteAfterDays = Number.parseInt(process.env.SESSION_LOG_DELETE_DAYS || "90", 10);
const now = Date.now();

function ageDays(path: string): number {
  return (now - statSync(path).mtimeMs) / 86_400_000;
}

async function gzipFile(path: string): Promise<void> {
  const target = `${path}.gz`;
  if (existsSync(target)) return;
  await pipeline(createReadStream(path), createGzip(), createWriteStream(target));
  rmSync(path);
}

async function main(): Promise<void> {
  mkdirSync(sessionsDir, { recursive: true });
  for (const name of readdirSync(sessionsDir)) {
    const path = join(sessionsDir, name);
    if (!statSync(path).isFile()) continue;
    const age = ageDays(path);
    if (name.endsWith(".jsonl.gz") && age >= deleteAfterDays) {
      rmSync(path);
    } else if (name.endsWith(".jsonl") && age >= archiveAfterDays) {
      await gzipFile(path);
    }
  }

  for (const name of readdirSync(root)) {
    if (name.startsWith("tmp.")) rmSync(join(root, name), { force: true, recursive: true });
  }
}

main().catch((err) => {
  console.error(`[session-log-janitor] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
