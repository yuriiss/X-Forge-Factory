import { defineConfig } from "@playwright/test";

/**
 * The UI suite drives the console that is already running on 7777 — the same process the
 * API suite exercised, with the same real account behind it. Nothing is mocked, because a
 * console that only works against a mock is exactly the thing this project set out not to
 * build.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.XFORGE_BASE ?? "http://127.0.0.1:7777",
    headless: true,
    viewport: { width: 1680, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
