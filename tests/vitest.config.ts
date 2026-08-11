import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Unit tests run against a throwaway FORGE_HOME so a test never touches the operator's
 * real vault or database — and so every run starts from an empty schema, which is what
 * makes the isolation assertions meaningful rather than dependent on leftovers.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "../src") },
  },
  test: {
    include: ["unit/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./setup/env.ts"],
    testTimeout: 20_000,
    pool: "forks",
  },
});
