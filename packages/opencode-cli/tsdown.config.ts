import { defineConfig } from "tsdown";

const baseConfig = {
  format: "esm",
  target: "node22",
  platform: "node",
  sourcemap: false,
  clean: true,
  dts: false,
  outExtensions: () => ({ js: ".mjs" }),
  banner: {
    js: '#!/usr/bin/env node\nimport{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);',
  },
  // Bundle everything into standalone .mjs files. onlyBundle:false silences the
  // informational notice about bundling node_modules deps.
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
} satisfies Parameters<typeof defineConfig>[0];

export default defineConfig([
  {
    ...baseConfig,
    entry: {
      "remote-cli": "src/remote-cli.ts",
    },
  },
  {
    ...baseConfig,
    clean: false,
    entry: {
      "slack-upload": "src/slack-upload.ts",
    },
  },
]);
