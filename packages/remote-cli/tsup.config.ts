import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/auth-helper.ts"],
  format: "esm",
  target: "node22",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [/@thor\/.*/],
  banner: {
    js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);',
  },
});
