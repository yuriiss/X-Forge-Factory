import { mkdirSync } from "fs";
import path from "path";
import os from "os";

/**
 * Where X-Forge keeps state.
 *
 * Two roots, because they answer to different owners. The engine's own state — database,
 * OAuth session, catalogue cache — lives under `FORGE_HOME` and is nobody's business but
 * the console's. Generated assets live under `FORGE_VAULT_DIR`, which is meant to be
 * pointed at somewhere the operator actually browses: an Obsidian vault, a Dropbox folder,
 * a project directory. Files there are named for humans and sorted by kind, because a
 * directory of `mso9jzhz_4acc80b357d5.jpg` is a database, not a library.
 */
export function forgeHome(): string {
  const dir = expandHome(process.env.FORGE_HOME) || path.join(os.homedir(), ".x-forge");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbFile(): string {
  return path.join(forgeHome(), "forge.db");
}

export function stateFile(name: string): string {
  return path.join(forgeHome(), name);
}

/** The root of the asset library. Defaults to the engine's own directory. */
export function vaultRoot(): string {
  const dir = expandHome(process.env.FORGE_VAULT_DIR) || path.join(forgeHome(), "vault");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A tenant's slice of the library.
 *
 * The single local operator gets the root itself, so their Obsidian vault reads
 * `X-FORGE/image/...` rather than `X-FORGE/local/image/...`. Any other tenant is
 * segmented by id, which is what spec §8 asks for and what keeps a second operator's
 * files from ever sharing a directory with the first's.
 */
export function tenantRoot(tenantId: string): string {
  const dir = tenantId === "local" ? vaultRoot() : path.join(vaultRoot(), tenantId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Subdirectory per kind. `3D` is capitalised because that is how people write it. */
const KIND_DIR: Record<string, string> = {
  image: "image",
  video: "video",
  audio: "audio",
  "3d": "3D",
  vector: "vector",
  file: "file",
};

export function kindDir(kind: string): string {
  return KIND_DIR[kind] ?? "file";
}

export function assetDir(tenantId: string, kind: string): string {
  const dir = path.join(tenantRoot(tenantId), kindDir(kind));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where assets lived before the library was split by kind — read only, for migration. */
export function legacyVaultDir(tenantId: string): string {
  return path.join(forgeHome(), "vault", tenantId);
}

/**
 * `~` is a shell convention, not a path.
 *
 * People write `~/Obsidian/X-FORGE` in an env file because that is what a home directory
 * looks like everywhere else. Passed through untouched it creates a directory literally
 * named "~" next to wherever the process started, and the operator's library quietly ends
 * up somewhere they will never find it.
 */
function expandHome(dir: string | undefined): string {
  const trimmed = (dir ?? "").trim();
  if (!trimmed) return "";
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}
