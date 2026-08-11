import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

/**
 * A disposable engine home for the unit suite.
 *
 * The tests exercise credential sealing, the ledger and the vault, all of which write to
 * disk. Pointing FORGE_HOME at a temp directory keeps them out of the operator's real
 * state and guarantees a clean schema per run.
 */
let dir = "";

export function setup() {
  dir = mkdtempSync(path.join(os.tmpdir(), "x-forge-test-"));
  process.env.FORGE_HOME = dir;
  process.env.FORGE_MASTER_KEY = "a".repeat(64);
  process.env.MAGNIFIC_API_KEY = "FPSXtestkey000000000000000000TEST";
  process.env.MAGNIFIC_WEBHOOK_SECRET = "whsec_testsecret_000000";
  process.env.FORGE_VIDEO_ENABLED = "1";
  process.env.FORGE_APPROVAL_THRESHOLD = "100";
}

export function teardown() {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
