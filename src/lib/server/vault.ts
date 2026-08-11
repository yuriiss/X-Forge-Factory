import { createHash, randomBytes } from "crypto";
import {
  closeSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import path from "path";
import { addAsset, deleteAsset, getAsset, getJob, type Asset, type Ctx } from "./repo";
import { db } from "./db";
import { assetDir, kindDir, legacyVaultDir, tenantRoot } from "./paths";
import { logger } from "./logger";

/**
 * The vault: what X-Forge keeps after a job succeeds.
 *
 * Result URLs from Magnific are signed and expire in about a day, so an asset that is not
 * downloaded is an asset the operator paid for and will lose.
 *
 * Files are laid out to be READ BY A PERSON, because the point of pointing the vault at an
 * Obsidian folder is that it can be browsed there: sorted into `image/`, `video/`, `audio/`,
 * `3D/`, `vector/`, named `date_what-it-was_id.ext`, and accompanied by a note carrying the
 * prompt, the model, the cost and the job it came from. The database stores the path
 * relative to the tenant's root, so the library can be moved by moving the folder and
 * changing one environment variable.
 */

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "model/gltf-binary": "glb",
  "application/octet-stream": "bin",
};

export function kindOfMime(mime: string): Asset["kind"] {
  if (mime.startsWith("image/")) return mime === "image/svg+xml" ? "vector" : "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.includes("gltf") || mime.includes("model")) return "3d";
  return "file";
}

function extFor(mime: string, url: string): string {
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const fromUrl = url.split("?")[0].split(".").pop();
  return fromUrl && fromUrl.length <= 5 ? fromUrl.toLowerCase() : "bin";
}

/**
 * Resolve a stored path inside the tenant's library.
 *
 * Legacy rows hold a bare file name from when everything lived in one flat directory;
 * those still resolve, so an un-migrated database keeps working. The result is checked to
 * be inside the root — the value comes from the database and ends up in a path join, and
 * that is exactly the shape of a traversal bug even when nothing malicious is nearby.
 */
export function assetPath(tenantId: string, fileName: string): string {
  const root = fileName.includes("/") ? tenantRoot(tenantId) : legacyVaultDir(tenantId);
  const full = path.resolve(root, fileName);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error("asset path escapes the vault");
  return full;
}

/** `sweep image.mystic` → `sweep-image-mystic`, trimmed to something a file name can hold. */
function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "asset";
}

interface Naming {
  relPath: string;
  fullPath: string;
  baseName: string;
}

/** `image/2026-08-11_editorial-portrait_A1B2C3.jpg` — sortable, searchable, unique. */
function nameFor(ctx: Ctx, jobId: string, kind: string, ext: string): Naming {
  const job = getJob(ctx, jobId);
  const label = job?.label || job?.model_id || jobId;
  const date = new Date().toISOString().slice(0, 10);
  const unique = randomBytes(3).toString("hex").toUpperCase();
  const baseName = `${date}_${slug(label)}_${unique}`;
  const relPath = `${kindDir(kind)}/${baseName}.${ext}`;
  return { relPath, fullPath: path.join(assetDir(ctx.tenantId, kind), `${baseName}.${ext}`), baseName };
}

/**
 * Stream a signed URL into the vault.
 *
 * Streamed rather than buffered because a 1080p clip is tens of megabytes and there is no
 * reason to hold one in memory on the way to disk. The file lands under a temporary name
 * first: the real name depends on what the bytes turn out to be, and some endpoints
 * mislabel them.
 */
export async function downloadToVault(
  ctx: Ctx,
  jobId: string,
  url: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Asset> {
  const res = await fetch(url, { signal: opts.signal ?? AbortSignal.timeout(600_000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);

  const declared = (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
  const staging = path.join(tenantRoot(ctx.tenantId), `.incoming_${randomBytes(6).toString("hex")}`);

  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(staging));
  const bytes = statSync(staging).size;
  if (!bytes) {
    unlinkSync(staging);
    throw new Error("download produced an empty file");
  }

  // Some endpoints serve a finished PNG as `application/octet-stream` — the cutout from
  // background removal is one. Believing the header would file a perfectly good image
  // under "file" and render it as a download link the operator has to open elsewhere.
  const mime = sniff(staging) ?? declared;
  const kind = kindOfMime(mime);
  const naming = nameFor(ctx, jobId, kind, extFor(mime, url));
  renameSync(staging, naming.fullPath);

  const asset = addAsset(ctx, { jobId, kind, mime, bytes, fileName: naming.relPath, sourceUrl: url });
  writeNote(ctx, asset, naming.baseName);
  logger.info("vault", `stored ${naming.relPath} (${bytes}B, ${mime}${mime === declared ? "" : ` — declared ${declared}`})`);
  return asset;
}

/** Write bytes we already hold — uploads the operator dropped in. */
export function saveBytes(ctx: Ctx, jobId: string, bytes: Buffer, mime: string): Asset {
  const kind = kindOfMime(mime);
  const naming = nameFor(ctx, jobId, kind, extFor(mime, ""));
  writeFileSync(naming.fullPath, bytes);
  const asset = addAsset(ctx, { jobId, kind, mime, bytes: bytes.length, fileName: naming.relPath, sourceUrl: undefined });
  writeNote(ctx, asset, naming.baseName);
  return asset;
}

/**
 * The note beside the asset.
 *
 * An Obsidian vault full of images and nothing else is a folder; the note is what makes it
 * a library — the prompt that produced the file, what it cost, which job and which model,
 * all searchable and linkable. The embed renders the asset inline in Obsidian's preview.
 */
function writeNote(ctx: Ctx, asset: Asset, baseName: string): void {
  const job = getJob(ctx, asset.job_id);
  if (!job) return;

  const params = (() => {
    try {
      return JSON.parse(job.params_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const prompt = typeof params.prompt === "string" ? params.prompt : typeof params.text === "string" ? params.text : "";
  const fileName = asset.file_name.split("/").pop()!;

  const yaml = [
    "---",
    `created: ${asset.created_at}`,
    `kind: ${asset.kind}`,
    `capability: ${job.kind}`,
    `model: ${job.model_id}`,
    `credits: ${job.actual_credits ?? job.estimated_credits ?? ""}`,
    `via: ${viaOf(params)}`,
    `mime: ${asset.mime}`,
    `bytes: ${asset.bytes}`,
    `job: ${job.id}`,
    `asset: ${asset.id}`,
    `tags: [x-forge, ${asset.kind}]`,
    "---",
  ].join("\n");

  const body = [
    "",
    `# ${job.label || job.model_id}`,
    "",
    `![[${fileName}]]`,
    "",
    ...(prompt ? ["**Prompt**", "", `> ${prompt.replace(/\n/g, "\n> ")}`, ""] : []),
    "| | |",
    "|---|---|",
    `| capability | \`${job.kind}\` |`,
    `| model | ${job.model_id} |`,
    `| endpoint | ${job.provider_path ?? "mcp tool call"} |`,
    `| credits | ${job.actual_credits ?? job.estimated_credits ?? "—"} |`,
    `| provider task | ${job.provider_task_id ?? "—"} |`,
    "",
  ].join("\n");

  const notePath = path.join(path.dirname(assetPath(ctx.tenantId, asset.file_name)), `${baseName}.md`);
  writeFileSync(notePath, yaml + body, "utf8");
}

function viaOf(params: Record<string, unknown>): string {
  return typeof params.__via === "string" ? params.__via : "rest";
}

/** What the bytes actually are, for the handful of formats worth recognising. */
function sniff(file: string): string | null {
  const fd = openSync(file, "r");
  const head = Buffer.alloc(16);
  try {
    readSync(fd, head, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  if (head.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (head.subarray(0, 4).toString("ascii") === "glTF") return "model/gltf-binary";
  if (head.subarray(0, 3).equals(Buffer.from([0x49, 0x44, 0x33])) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (head.subarray(0, 5).toString("ascii") === "<?xml" || head.subarray(0, 4).toString("ascii") === "<svg") return "image/svg+xml";
  return null;
}

export function readAssetBytes(ctx: Ctx, id: string): { asset: Asset; bytes: Buffer } | null {
  const asset = getAsset(ctx, id);
  if (!asset) return null;
  const file = assetPath(ctx.tenantId, asset.file_name);
  if (!existsSync(file)) return null;
  return { asset, bytes: readFileSync(file) };
}

/** Remove the asset, and the note that only exists to describe it. */
export function removeAsset(ctx: Ctx, id: string): boolean {
  const asset = getAsset(ctx, id);
  if (!asset) return false;
  const file = assetPath(ctx.tenantId, asset.file_name);
  if (existsSync(file)) unlinkSync(file);
  const note = file.replace(/\.[^.]+$/, ".md");
  if (existsSync(note)) unlinkSync(note);
  deleteAsset(ctx, id);
  return true;
}

/* ------------------------------------------------------------ migration -- */

export interface MigrationReport {
  moved: number;
  missing: number;
  failed: number;
}

/**
 * Move a flat legacy vault into the library layout.
 *
 * Runs at boot and is idempotent: rows already holding a path are skipped, a file that is
 * no longer on disk is left alone rather than erased from the database, and nothing is
 * ever overwritten. `rename` first because the usual case is one filesystem; a copy is the
 * fallback when the library lives on another device.
 */
export function migrateVault(ctx: Ctx): MigrationReport {
  const rows = db()
    .prepare("SELECT id, job_id, kind, mime, file_name, created_at FROM forge_assets WHERE tenant_id = ? AND file_name NOT LIKE '%/%'")
    .all(ctx.tenantId) as unknown as { id: string; job_id: string; kind: string; mime: string; file_name: string; created_at: string }[];

  const report: MigrationReport = { moved: 0, missing: 0, failed: 0 };
  if (!rows.length) return report;

  for (const row of rows) {
    const from = path.join(legacyVaultDir(ctx.tenantId), row.file_name);
    if (!existsSync(from)) {
      report.missing++;
      continue;
    }
    try {
      const ext = row.file_name.split(".").pop() || extFor(row.mime, "");
      const job = getJob(ctx, row.job_id);
      const label = job?.label || job?.model_id || row.job_id;
      const date = (row.created_at || new Date().toISOString()).slice(0, 10);
      const unique = row.id.slice(-6).toUpperCase();
      const baseName = `${date}_${slug(label)}_${unique}`;
      const relPath = `${kindDir(row.kind)}/${baseName}.${ext}`;
      const to = path.join(assetDir(ctx.tenantId, row.kind), `${baseName}.${ext}`);
      if (existsSync(to)) {
        report.failed++;
        continue;
      }

      try {
        renameSync(from, to);
      } catch {
        copyFileSync(from, to);
        unlinkSync(from);
      }

      db().prepare("UPDATE forge_assets SET file_name = ? WHERE id = ?").run(relPath, row.id);
      const asset = getAsset(ctx, row.id);
      if (asset) writeNote(ctx, asset, baseName);
      report.moved++;
    } catch (e) {
      logger.warn("vault", `migration failed for ${row.id}: ${(e as Error).message}`);
      report.failed++;
    }
  }

  logger.info("vault", `migrated ${report.moved} asset(s) into the library · ${report.missing} missing · ${report.failed} skipped`);
  return report;
}

/** What the library holds, for the Developers panel. */
export function vaultUsage(ctx: Ctx): { bytes: number; files: number; byKind: Record<string, { files: number; bytes: number }> } {
  const rows = db()
    .prepare("SELECT kind, COUNT(*) AS files, COALESCE(SUM(bytes),0) AS bytes FROM forge_assets WHERE tenant_id = ? GROUP BY kind")
    .all(ctx.tenantId) as unknown as { kind: string; files: number; bytes: number }[];
  const byKind: Record<string, { files: number; bytes: number }> = {};
  let bytes = 0;
  let files = 0;
  for (const r of rows) {
    byKind[r.kind] = { files: r.files, bytes: r.bytes };
    bytes += r.bytes;
    files += r.files;
  }
  return { bytes, files, byKind };
}

/** A short-lived signature so an asset URL is not a permanent capability (spec §7). */
export function signAsset(id: string, ttlMs = 6 * 60 * 60_000): string {
  const exp = Date.now() + ttlMs;
  const sig = createHash("sha256").update(`${id}.${exp}.${process.env.FORGE_MASTER_KEY ?? ""}`).digest("hex").slice(0, 24);
  return `${exp}.${sig}`;
}

export function verifyAssetSignature(id: string, token: string): boolean {
  const [expRaw, sig] = (token || "").split(".");
  const exp = Number(expRaw);
  if (!exp || Date.now() > exp) return false;
  const expect = createHash("sha256").update(`${id}.${exp}.${process.env.FORGE_MASTER_KEY ?? ""}`).digest("hex").slice(0, 24);
  return sig === expect;
}
