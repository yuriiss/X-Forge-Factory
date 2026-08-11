import { defineConfig } from "vitest/config";

/**
 * API tests talk to a running X-Forge on 127.0.0.1:7777 with the operator's real key.
 *
 * They spend credits, so every generation in here uses the cheapest model that exercises
 * the path — a five-credit image rather than a fifteen-hundred-credit video. The point is
 * that the wiring works end to end, and that is just as true at five credits.
 */
export default defineConfig({
  test: {
    include: ["api/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 60_000,
    pool: "forks",
    fileParallelism: false,
  },
});
