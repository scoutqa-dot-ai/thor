#!/usr/bin/env node
// Deterministic original Neo artwork. Existing v3 URLs remain compatibility aliases.
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
const require = createRequire(new URL("../packages/runner/package.json", import.meta.url));
const sharp = require("sharp");
const directory = new URL("../docker/ingress/static/", import.meta.url);
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Neo"><rect x="8" y="8" width="240" height="240" rx="48" fill="#071a13"/><path d="M64 184V72l128 112V72" fill="none" stroke="#4ade80" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/><circle cx="214" cy="42" r="9" fill="#bbf7d0"/></svg>`;
async function png(size) {
  return sharp(Buffer.from(icon)).resize(size, size).png().toBuffer();
}
function ico(bytes) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 48;
  header[7] = 48;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(bytes.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, bytes]);
}
const assets = new Map([
  ["favicon-v4.svg", Buffer.from(icon)],
  ["favicon-96x96-v4.png", await png(96)],
  ["favicon-v4.ico", ico(await png(48))],
  ["apple-touch-icon-v4.png", await png(180)],
  ["web-app-manifest-192x192-v4.png", await png(192)],
  ["web-app-manifest-512x512-v4.png", await png(512)],
]);
const legacy = new Map([
  ["favicon-v3.svg", "favicon-v4.svg"],
  ["favicon-96x96-v3.png", "favicon-96x96-v4.png"],
  ["favicon-v3.ico", "favicon-v4.ico"],
  ["apple-touch-icon-v3.png", "apple-touch-icon-v4.png"],
  ["web-app-manifest-192x192.png", "web-app-manifest-192x192-v4.png"],
  ["web-app-manifest-512x512.png", "web-app-manifest-512x512-v4.png"],
]);
for (const [name, bytes] of assets) await writeFile(new URL(name, directory), bytes);
for (const [name, target] of legacy) await writeFile(new URL(name, directory), assets.get(target));
const share = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#071a13"/><path d="M0 525H1200M0 105H1200M120 0V630M1080 0V630" stroke="#163a29" stroke-width="2"/><g transform="translate(110 170) scale(1.12)">${icon.replace(/<svg[^>]*>/, "").replace("</svg>", "")}</g><g fill="none" stroke="#bbf7d0" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"><path d="M455 325V232l68 93V232M555 232h65M555 232v93h65M555 279h58"/><ellipse cx="693" cy="279" rx="40" ry="47"/></g><path d="M455 385h310" stroke="#4ade80" stroke-width="5"/><circle cx="790" cy="385" r="9" fill="#4ade80"/></svg>`;
await writeFile(
  new URL("social-share.png", directory),
  await sharp(Buffer.from(share)).png().toBuffer(),
);
console.log("Generated Neo SVG/PNG/ICO/social assets and legacy URL aliases");
