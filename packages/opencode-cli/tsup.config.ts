import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "remote-cli": "src/remote-cli.ts",
  },
  format: "esm",
  target: "node22",
  platform: "node",
  splitting: false,
  sourcemap: false,
  clean: true,
  outExtension: () => ({ js: ".mjs" }),
  banner: {
    js: '#!/usr/bin/env node\nimport{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);',
  },
  // Bundle everything into standalone .mjs files
  noExternal: [/.*/],
});
