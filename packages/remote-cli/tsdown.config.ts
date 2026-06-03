import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/auth-helper.ts"],
  format: "esm",
  target: "node22",
  platform: "node",
  // Keep dist/*.js (not .mjs) so `node dist/index.js` and Docker stay unchanged.
  fixedExtension: false,
  sourcemap: true,
  clean: true,
  dts: false,
  // Inline workspace packages (e.g. @thor/common); their CJS deps like pino get
  // pulled in too. onlyBundle:false silences the informational bundled-deps notice.
  deps: { alwaysBundle: [/@thor\/.*/], onlyBundle: false },
  banner: {
    js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);',
  },
});
