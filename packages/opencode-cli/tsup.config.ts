import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "remote-cli": "src/remote-cli.ts",
    "proxy-cli": "src/proxy-cli.ts",
  },
  format: "esm",
  target: "node22",
  platform: "node",
  splitting: false,
  sourcemap: false,
  clean: true,
  outExtension: () => ({ js: ".mjs" }),
  banner: { js: "#!/usr/bin/env node" },
  // Bundle everything into standalone .mjs files
  noExternal: [/.*/],
});
