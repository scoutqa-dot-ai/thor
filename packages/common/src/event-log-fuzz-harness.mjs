import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const [, , workerIdRaw, recordsPerProcRaw, worklogDir] = process.argv;
const workerId = Number.parseInt(workerIdRaw, 10);
const recordsPerProc = Number.parseInt(recordsPerProcRaw, 10);
const path = `${worklogDir}/sessions/fuzz.jsonl`;
mkdirSync(dirname(path), { recursive: true });

for (let i = 0; i < recordsPerProc; i++) {
  const record = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    type: "opencode_event",
    event: { worker: workerId, idx: i, id: randomUUID(), payload: "x".repeat(64) },
  };
  appendFileSync(path, JSON.stringify(record) + "\n");
}

process.exit(0);
