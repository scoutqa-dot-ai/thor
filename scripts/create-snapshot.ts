/**
 * Manage Daytona snapshots — list existing or create from a Dockerfile / registry image.
 *
 * Usage:
 *   pnpm -F remote-cli exec tsx scripts/create-snapshot.ts --list
 *   pnpm -F remote-cli exec tsx scripts/create-snapshot.ts
 *   pnpm -F remote-cli exec tsx scripts/create-snapshot.ts --image ghcr.io/org/repo:tag
 *   pnpm -F remote-cli exec tsx scripts/create-snapshot.ts --name my-snapshot
 *
 * Environment:
 *   DAYTONA_API_KEY  — required (needs snapshot-create permission for --create)
 *   DAYTONA_API_URL  — optional (default: https://app.daytona.io/api)
 */

import { Daytona, Image } from "@daytonaio/sdk";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_NAME = "thor-sandbox-base";
const DEFAULT_DOCKERFILE = "docker/sandbox/Dockerfile";

const { values: args } = parseArgs({
  options: {
    list: { type: "boolean", default: false },
    image: { type: "string" },
    dockerfile: { type: "string", default: DEFAULT_DOCKERFILE },
    name: { type: "string", default: DEFAULT_NAME },
    cpu: { type: "string", default: "2" },
    mem: { type: "string", default: "4" },
    disk: { type: "string", default: "10" },
  },
});

const apiKey = process.env.DAYTONA_API_KEY;
if (!apiKey) {
  console.error("DAYTONA_API_KEY is required");
  process.exit(1);
}

const daytona = new Daytona({
  apiKey,
  apiUrl: process.env.DAYTONA_API_URL || "https://app.daytona.io/api",
});

async function list() {
  const result = await daytona.snapshot.list();
  console.log(`Snapshots (${result.total}):\n`);
  for (const s of result.items) {
    console.log(
      `  ${s.name.padEnd(35)} ${s.state.padEnd(12)} ${s.cpu}cpu ${s.mem}GiB ${s.disk}GiB disk`,
    );
  }
}

async function create() {
  const name = args.name ?? DEFAULT_NAME;
  const imageSource = args.image
    ? `registry: ${args.image}`
    : `Dockerfile: ${resolve(REPO_ROOT, args.dockerfile ?? DEFAULT_DOCKERFILE)}`;

  console.log(`Source:    ${imageSource}`);
  console.log(`Snapshot:  ${name}`);
  console.log(`Resources: ${args.cpu} CPU, ${args.mem} GiB RAM, ${args.disk} GiB disk`);
  console.log();

  // Delete existing snapshot with the same name, wait for removal
  try {
    const existing = await daytona.snapshot.get(name);
    console.log(`Snapshot "${name}" already exists (state: ${existing.state}). Deleting...`);
    await daytona.snapshot.delete(existing);
    // Daytona delete is eventual — poll until the name is free
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        await daytona.snapshot.get(name);
      } catch {
        break; // gone
      }
    }
    console.log("Deleted.\n");
  } catch {
    // Not found — will create fresh
  }

  const image = args.image
    ? args.image
    : Image.fromDockerfile(resolve(REPO_ROOT, args.dockerfile ?? DEFAULT_DOCKERFILE));

  console.log("Creating snapshot (this may take 10-15 minutes)...\n");

  const snapshot = await daytona.snapshot.create(
    {
      name,
      image,
      resources: {
        cpu: Number(args.cpu),
        memory: Number(args.mem),
        disk: Number(args.disk),
      },
    },
    {
      onLogs: (chunk) => process.stdout.write(chunk),
      timeout: 0,
    },
  );

  console.log();
  console.log("Snapshot created successfully.");
  console.log(`  Name:  ${snapshot.name}`);
  console.log(`  State: ${snapshot.state}`);
  console.log(`  ID:    ${snapshot.id}`);
  console.log();
  console.log(`To use: set DAYTONA_SNAPSHOT=${snapshot.name}`);
}

(args.list ? list() : create()).catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
