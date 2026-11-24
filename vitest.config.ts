import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vigil/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@vigil/batcher": fileURLToPath(new URL("./packages/batcher/src/index.ts", import.meta.url)),
      "@vigil/memo": fileURLToPath(new URL("./packages/memo/src/index.ts", import.meta.url)),
      "@vigil/monitor": fileURLToPath(new URL("./packages/monitor/src/index.ts", import.meta.url)),
      "@vigil/api": fileURLToPath(new URL("./packages/api/src/index.ts", import.meta.url)),
      "@vigil/console": fileURLToPath(new URL("./packages/console/src/index.ts", import.meta.url)),
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
      // Excluded: entry points, generated code, and thin on-chain glue that is exercised
      // against the testnet instead of in unit tests.
      exclude: [
        "packages/*/src/index.ts",
        "packages/*/src/main.ts",
        "packages/receipts/src/abi.ts",
        "packages/receipts/src/contract.ts",
        "packages/receipts/src/deployer.ts",
        // Vendored third-party code, kept byte for byte as released.
        "packages/*/src/vendor/**",
      ],
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    },
  },
});
