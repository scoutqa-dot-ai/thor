import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
  resolve: {
    alias: {
      "@thor/common": resolve(__dirname, "packages/common/src/index.ts"),
    },
  },
});
