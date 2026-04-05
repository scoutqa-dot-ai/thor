import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  // Don't bundle node_modules — only inline workspace packages like @thor/common
  noExternal: [/@thor\/.*/],
  // pino (inlined via @thor/common) uses CJS require("os") at runtime.
  // tsup's default ESM shim throws on dynamic require of Node builtins.
  // Inject a real createRequire-based shim so CJS deps work in the ESM bundle.
  banner: {
    js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);',
  },
});
