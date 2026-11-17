import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vigil/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@vigil/wallet": fileURLToPath(new URL("./packages/wallet/src/index.ts", import.meta.url)),
      "@vigil/watchtower": fileURLToPath(
        new URL("./packages/watchtower/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/index.ts", "packages/*/src/main.ts"],
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    },
  },
});
