import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@luck-cays/shared": resolve(import.meta.dirname, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    globalSetup: ["./tests/helpers/global-setup.ts"],
    setupFiles: ["./tests/helpers/env.ts"],
    // One SQLite file, so test files must not run concurrently against it. The
    // concurrency tests still run many operations in parallel inside a single file,
    // which is the thing actually under test.
    fileParallelism: false,
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
