import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  platform: "node",
  // Keep dist/index.js (not .mjs) so `node dist/index.js` and Docker stay unchanged.
  fixedExtension: false,
  sourcemap: true,
  clean: true,
  // Apps don't ship type declarations.
  dts: false,
  // Inline workspace packages (e.g. @thor/common); their CJS deps like pino get
  // pulled in too. onlyBundle:false silences the informational bundled-deps notice.
  deps: { alwaysBundle: [/@thor\/.*/], onlyBundle: false },
  // pino (inlined via @thor/common) uses CJS require("os") at runtime.
  // Inject a real createRequire-based shim so CJS deps work in the ESM bundle.
  banner: {
    js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);',
  },
});
