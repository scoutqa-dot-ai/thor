import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/auth-helper.ts"],
  format: "esm",
  target: "node22",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  // Keep the reviewed arbitrary-schema validator/dialects aligned with this broker artifact.
  noExternal: [/@thor\/.*/, /^ajv(?:-formats)?(?:\/|$)/],
  banner: {
    js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);',
  },
});
