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
});
