import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@moco/protocol": path.join(rootDir, "packages/protocol/src/index.ts"),
      "@moco/recovery": path.join(rootDir, "packages/recovery/src/index.ts"),
      "@moco/env": path.join(rootDir, "packages/env/src/index.ts"),
      "@moco/hub": path.join(rootDir, "packages/hub/src/index.ts"),
      "@moco/cli": path.join(rootDir, "packages/cli/src/index.ts"),
    },
  },
  test: {
    include: [
      "tests/**/*.test.{ts,tsx}",
      "packages/*/test/**/*.test.{ts,tsx}",
      "packages/*/src/**/*.test.{ts,tsx}",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
