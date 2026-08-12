#!/usr/bin/env node
/**
 * Remove the stock downloads made while testing that feature.
 *
 *   node scripts/remove-test-downloads.mjs --dry-run
 *   node scripts/remove-test-downloads.mjs
 *
 * A one-off, written as a script rather than typed into a shell because it deletes files:
 * the dry run prints exactly what would go, and each asset takes its markdown note and its
 * database row with it rather than leaving one of the three behind.
 *
 * It reads the database directly instead of importing the console's own modules — those are
 * TypeScript with extensionless imports, which Node's type stripping will not resolve — so
 * the three deletions are spelled out here in the same order `removeAsset` does them.
 *
 * Scoped to jobs whose kind begins with `stock.`: nothing the operator generated has that
 * shape, and the scope is printed before anything is touched.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dry = process.argv.includes("--dry-run");

const home = process.env.FORGE_HOME?.replace(/^~/, os.homedir()) ?? path.join(os.homedir(), ".x-forge");
const vault = process.env.FORGE_VAULT_DIR?.replace(/^~/, os.homedir()) ?? path.join(os.homedir(), "Obsidian", "X-FORGE");
const db = new DatabaseSync(path.join(home, "forge.db"));

const jobs = db.prepare("SELECT id, kind, label FROM forge_jobs WHERE tenant_id = 'local' AND kind LIKE 'stock.%' ORDER BY created_at").all();

if (!jobs.length) {
  console.log("nothing to remove");
  process.exit(0);
}

let files = 0;
for (const job of jobs) {
  const assets = db.prepare("SELECT id, file_name, bytes FROM forge_assets WHERE job_id = ?").all(job.id);

  for (const asset of assets) {
    const file = path.join(vault, asset.file_name);
    const note = file.replace(/\.[^.]+$/, ".md");
    console.log(`${dry ? "would remove" : "removing"}  ${asset.file_name}  (${asset.bytes} B)  ← ${job.label}`);

    if (!dry) {
      if (existsSync(file)) unlinkSync(file);
      if (existsSync(note)) unlinkSync(note);
      db.prepare("DELETE FROM forge_assets WHERE id = ?").run(asset.id);
    }
    files += 1;
  }

  if (!dry) {
    db.prepare("DELETE FROM forge_job_events WHERE job_id = ?").run(job.id);
    db.prepare("DELETE FROM forge_jobs WHERE id = ? AND tenant_id = 'local'").run(job.id);
  }
}

console.log(`\n${dry ? "would remove" : "removed"} ${files} file(s) and ${jobs.length} job row(s)`);
