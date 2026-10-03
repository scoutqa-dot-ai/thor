#!/usr/bin/env node
// Static/export safety checks. Optional --source also proves offline byte reproduction.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { source: { type: "string" } } });
const sharp = createRequire(new URL("../packages/runner/package.json", import.meta.url))("sharp");
const exporter = fileURLToPath(new URL("./generate-slack-progress-assets.mjs", import.meta.url));
const names = ["neo-thinking-v1.gif", "neo-working-v1.gif", "neo-ai-still-v1.png"];
const assets = await Promise.all(
  names.map((name) => readFile(new URL(`../docker/ingress/static/${name}`, import.meta.url))),
);
const still = await sharp(assets[2]).removeAlpha().raw().toBuffer();
const stillRgba = await sharp(assets[2]).ensureAlpha().raw().toBuffer();
const colorCounts = new Map();
for (let i = 0; i < stillRgba.length; i += 4) {
  assert.equal(stillRgba[i + 3], 255, "Still mark must retain its opaque light substrate");
  const color = [...stillRgba.subarray(i, i + 3)].join(",");
  colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
}
assert(colorCounts.get("15,132,97") > 50, "Still mark must contain the original Forest leaf");
assert(colorCounts.get("3,33,24") > 25, "Still mark must contain the original near-black spark");
const firstFrames = [];
for (const bytes of assets.slice(0, 2)) {
  assert(bytes.length < 250_000);
  const metadata = await sharp(bytes, { animated: true }).metadata();
  assert.equal(metadata.format, "gif");
  assert.equal(metadata.width, 64);
  assert.equal(metadata.pageHeight, 64);
  assert.equal(metadata.pages, 66);
  assert.equal(metadata.loop, 0);
  assert.deepEqual(metadata.delay, Array(66).fill(100));
  assert.equal(
    metadata.delay.reduce((a, b) => a + b, 0),
    6600,
  );
  const raw = await sharp(bytes, { animated: true }).removeAlpha().raw().toBuffer();
  const frameSize = 64 * 64 * 3;
  const frames = Array.from({ length: 66 }, (_, i) =>
    raw.subarray(i * frameSize, (i + 1) * frameSize),
  );
  const unique = new Set(frames.map((frame) => createHash("sha256").update(frame).digest("hex")));
  assert(unique.size > 50);
  firstFrames.push(frames[0]);
  // Original handoff peaks at dwell + morph = 4.8s, not a dotted stand-in.
  const assembled = frames[48];
  const meanError =
    assembled.reduce((sum, value, i) => sum + Math.abs(value - still[i]), 0) / frameSize;
  assert(
    meanError < 2,
    "Slack GIF assembled frame must match the original solid PNG despite palette quantization",
  );
  assert.deepEqual([...frames[0].subarray(0, 3)], [255, 255, 255]);
  console.log(
    `PASS: 64px GIF / ${unique.size} unique frames / infinite loop / exact 6.6s beat / original solid handoff`,
  );
}
assert.notDeepEqual(
  firstFrames[0],
  firstFrames[1],
  "Thinking and working must have different actual silhouettes",
);
const metadata = await sharp(assets[2]).metadata();
assert.equal(metadata.format, "png");
assert.equal(metadata.width, 64);
assert.equal(metadata.height, 64);
assert.equal(metadata.hasAlpha, true);
assert(assets[2].length < 25_000);
const scratch = await mkdtemp(join(tmpdir(), "neo-slack-export-check-"));
try {
  const hostile = join(scratch, "unreviewed.jsx");
  const marker = join(scratch, "source-executed");
  const output = join(scratch, "output");
  await writeFile(
    hostile,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('UNREVIEWED_SOURCE_EXECUTED');`,
  );
  const denied = spawnSync(process.execPath, [exporter, "--source", hostile, "--output", output], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /Slack asset source checksum mismatch/);
  assert.doesNotMatch(denied.stderr, /UNREVIEWED_SOURCE_EXECUTED|require is not defined/);
  await assert.rejects(access(marker), { code: "ENOENT" });
  await assert.rejects(access(output), { code: "ENOENT" });
  console.log(
    "PASS: wrong-source checksum rejects before source execution/dependency loading/output creation",
  );
  if (values.source) {
    const regenerated = spawnSync(
      process.execPath,
      [exporter, "--source", values.source, "--output", output],
      { encoding: "utf8", timeout: 180_000 },
    );
    assert.equal(regenerated.status, 0, regenerated.stderr);
    for (let i = 0; i < names.length; i++)
      assert.deepEqual(await readFile(join(output, names[i])), assets[i]);
    console.log("PASS: pinned offline export reproduces all three committed asset bytes");
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
