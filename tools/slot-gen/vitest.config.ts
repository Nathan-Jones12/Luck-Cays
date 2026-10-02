import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@luck-cays/shared/slots/types": resolve(
        import.meta.dirname,
        "../../packages/shared/src/slots/types.ts",
      ),
      "@luck-cays/shared/slots/engine": resolve(
        import.meta.dirname,
        "../../packages/shared/src/slots/engine.ts",
      ),
      "@luck-cays/shared/slots/exact": resolve(
        import.meta.dirname,
        "../../packages/shared/src/slots/exact.ts",
      ),
    },
  },
  test: { environment: "node" },
});
