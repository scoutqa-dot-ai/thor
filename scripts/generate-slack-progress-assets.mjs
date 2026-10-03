#!/usr/bin/env node
// Offline export of the reviewed Katalon AI engine; never execute an unpinned source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Script, createContext } from "node:vm";

const SOURCE_SHA256 = "b7b9ce28728fb94f24cb311a79b1db5ea9f25db09863c329f3a438052bc3d3d7";
const SIZE = 64;
const FRAME_COUNT = 66;
const FRAME_DELAY_CS = 10; // 10 fps; exactly 3 + 1.8 + 1.8 seconds.
const { values } = parseArgs({
  options: { source: { type: "string" }, output: { type: "string" }, preview: { type: "string" } },
});
if (!values.source)
  throw new Error("Slack asset export requires --source /path/to/pinned/thinking-mark.jsx");
const sourcePath = resolve(values.source);
if ((await stat(sourcePath)).size > 100_000)
  throw new Error("Slack asset source exceeds 100 KB bound");
const sourceBytes = await readFile(sourcePath);
if (createHash("sha256").update(sourceBytes).digest("hex") !== SOURCE_SHA256) {
  throw new Error("Slack asset source checksum mismatch; no source evaluated or output written");
}
// The complete 1,597-line source was reviewed before authoring this exporter. Only
// its pure engine/geometry and original render closure run; no React/DOM hooks.
const source = sourceBytes.toString("utf8");
const engineEnd = source.indexOf("function useDark(host, force)");
const renderStart = source.indexOf("const render = (t) => {");
const renderEnd = source.indexOf("\n    };", renderStart) + "\n    };".length;
assert(engineEnd > 0 && renderStart > engineEnd && renderEnd > renderStart);
const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
new Script(
  `${source.slice(0, engineEnd)}
  globalThis.slackEngine = {
    points: POINTS.n, beat: BEAT, leaf: MARK_LEAF, spark: MARK_SPARK, box: MARK_BOX,
    render(mode, t, ctx) {
      const px = ${SIZE}, dpr = 1, isDark = false, rgb = parseTint('#0F8461');
      const m = MODES[mode], o = m.opts, solid = { current: { style: {} } };
      ${source.slice(renderStart, renderEnd)}
      render(t);
      return Number(solid.current.style.opacity);
    }
  };
`,
  { filename: "reviewed-pinned-thinking-mark-engine.js" },
).runInContext(context, { timeout: 1000 });
assert.equal(context.slackEngine.points, 839);
assert.equal(context.slackEngine.beat.dwell, 3);
assert.equal(context.slackEngine.beat.morph, 1.8);
const require = createRequire(new URL("../packages/runner/package.json", import.meta.url));
const sharp = require("sharp"); // Existing build-time dependency, no installation.
const output = values.output
  ? resolve(values.output)
  : fileURLToPath(new URL("../docker/ingress/static/", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "neo-slack-assets-"));
const previewTimes = [0, 1.5, 3, 3.9, 4.8, 5.7];
const previews = [];

async function renderSlackPng(mode, time) {
  const circles = [];
  let arc;
  // Record the original canvas painter in its z-sorted draw order. SVG is only
  // a rasterization transport for these instructions, not replacement artwork.
  context.ctx = {
    globalAlpha: 1,
    fillStyle: "",
    setTransform() {},
    clearRect() {},
    beginPath() {},
    arc(x, y, r) {
      arc = { x, y, r };
    },
    fill() {
      assert(arc && Object.values(arc).every(Number.isFinite));
      assert(arc.r > 0 && arc.r < SIZE && Math.abs(arc.x) < SIZE * 2 && Math.abs(arc.y) < SIZE * 2);
      circles.push(
        `<circle cx="${arc.x}" cy="${arc.y}" r="${arc.r}" fill="${this.fillStyle}" opacity="${this.globalAlpha}"/>`,
      );
    },
  };
  context.mode = mode;
  context.time = time;
  const opacity = new Script("slackEngine.render(mode, time, ctx)").runInContext(context, {
    timeout: 1000,
  });
  assert(circles.length <= 839 && opacity >= 0 && opacity <= 1);
  const { box, leaf, spark } = context.slackEngine;
  const w = SIZE * box.w,
    h = SIZE * box.h;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="#ffffff"/>${circles.join("")}<svg x="${(SIZE - w) / 2}" y="${(SIZE - h) / 2}" width="${w}" height="${h}" viewBox="0 0 47 42" opacity="${opacity}"><path d="${leaf}" fill="#0F8461"/><path d="${spark}" fill="#032118"/></svg></svg>`;
  return sharp(Buffer.from(svg), { density: 144 }).resize(SIZE, SIZE).png().toBuffer();
}
try {
  const assets = new Map();
  for (const mode of ["thinking", "working"]) {
    const paths = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const path = join(scratch, `${mode}-${String(i).padStart(3, "0")}.png`);
      await writeFile(path, await renderSlackPng(mode, i / 10));
      paths.push(path);
    }
    const gifPath = join(scratch, `neo-${mode}-v1.gif`);
    execFileSync(
      "magick",
      [
        "-limit",
        "memory",
        "128MiB",
        "-limit",
        "map",
        "256MiB",
        "-delay",
        String(FRAME_DELAY_CS),
        ...paths,
        "-loop",
        "0",
        "-strip",
        gifPath,
      ],
      { timeout: 60_000, maxBuffer: 1_000_000 },
    );
    const bytes = await readFile(gifPath);
    const metadata = await sharp(bytes, { animated: true }).metadata();
    assert.equal(metadata.width, SIZE);
    assert.equal(metadata.pageHeight, SIZE);
    assert.equal(metadata.pages, FRAME_COUNT);
    assert.equal(metadata.loop, 0);
    assert.deepEqual(metadata.delay, Array(FRAME_COUNT).fill(100));
    assert(bytes.length < 250_000, "Slack animation exceeds 250 KB bound");
    assets.set(`neo-${mode}-v1.gif`, bytes);
    if (values.preview)
      for (const time of previewTimes) previews.push(await renderSlackPng(mode, time));
  }
  assets.set("neo-ai-still-v1.png", await renderSlackPng("thinking", 4.8));
  assert(assets.get("neo-ai-still-v1.png").length < 25_000);
  // Publish only after all three bounded assets have successfully rendered.
  await mkdir(output, { recursive: true });
  for (const [name, bytes] of assets) {
    await writeFile(join(output, name), bytes);
    console.log(
      `${name}: ${bytes.length} bytes sha256=${createHash("sha256").update(bytes).digest("hex")}`,
    );
  }
  if (values.preview) {
    const preview = resolve(values.preview);
    await mkdir(preview, { recursive: true });
    await sharp({
      create: { width: SIZE * 6, height: SIZE * 2, channels: 3, background: "#ffffff" },
    })
      .composite(
        previews.map((input, i) => ({
          input,
          left: (i % 6) * SIZE,
          top: Math.floor(i / 6) * SIZE,
        })),
      )
      .png()
      .toFile(join(preview, "neo-slack-contact-sheet.png"));
    await writeFile(
      join(preview, "index.html"),
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Neo Slack motion review</title><h1>Neo Slack motion review</h1><p>Top: thinking torus. Bottom: working angular plate. Each row: ${previewTimes.join(", ")} seconds. At 4.8 seconds the original leaf and spark are solid.</p><img src="neo-slack-contact-sheet.png" width="384" height="128" alt="Two rows of six original AI mark frames: torus and angular plate morph into the solid leaf and spark, then back."><p>Fixed white DS page substrate; light-mode ink #0F8461 and spark #032118. Text labels remain required in Slack; playback and reduced motion are controlled by Slack.</p></html>`,
    );
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
