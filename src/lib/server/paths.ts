import { mkdirSync } from "fs";
import path from "path";
import os from "os";

/**
 * Where X-Forge keeps state.
 *
 * Everything lives under one root so the whole console can be wiped, backed up or moved
 * with a single directory, and the vault sits OUTSIDE the web root (spec §8) — assets are
 * only ever reachable through a route handler that checks the tenant first, never by
 * guessing a path under /public.
 */
export function forgeHome(): string {
  const dir = expandHome(process.env.FORGE_HOME) || path.join(os.homedir(), ".x-forge");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * `~` is a shell convention, not a path.
 *
 * People write `~/.x-forge` in an env file because that is what a home directory looks
 * like everywhere else. Passed through untouched it creates a directory literally named
 * "~" next to wherever the process happened to start, and the operator's vault quietly
 * ends up somewhere they will never find it.
 */
function expandHome(dir: string | undefined): string {
  const trimmed = (dir ?? "").trim();
  if (!trimmed) return "";
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

export function dbFile(): string {
  return path.join(forgeHome(), "forge.db");
}

/** Per-tenant asset directory. Segmented by tenant, random file names (spec §8). */
export function vaultDir(tenantId: string): string {
  const dir = path.join(forgeHome(), "vault", tenantId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function stateFile(name: string): string {
  forgeHome();
  return path.join(forgeHome(), name);
}
