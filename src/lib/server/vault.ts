import { createHash, randomBytes } from "crypto";
import { closeSync, createWriteStream, existsSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import path from "path";
import { addAsset, deleteAsset, getAsset, type Asset, type Ctx } from "./repo";
import { vaultDir } from "./paths";
import { logger } from "./logger";

/**
 * The vault: what X-Forge keeps after a job succeeds.
 *
 * Result URLs from Magnific are signed and expire in about a day, so an asset that is not
 * downloaded is an asset the operator paid for and will lose. Files are written under a
 * per-tenant directory with random names, outside the web root (spec §8) — the only way
 * out is a route handler that resolves the id against the tenant first.
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

export function assetPath(tenantId: string, fileName: string): string {
  return path.join(vaultDir(tenantId), fileName);
}

/**
 * Stream a signed URL into the vault.
 *
 * Streamed rather than buffered because a 1080p clip is tens of megabytes and the console
 * has no reason to hold one in memory to write it to disk.
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
  const fileName = `${Date.now().toString(36)}_${randomBytes(6).toString("hex")}.${extFor(declared, url)}`;
  const dest = assetPath(ctx.tenantId, fileName);

  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
  const bytes = statSync(dest).size;
  if (!bytes) {
    unlinkSync(dest);
    throw new Error("download produced an empty file");
  }

  // Some endpoints serve a finished PNG as `application/octet-stream` — the cutout from
  // background removal is one. Believing the header would file a perfectly good image
  // under "file" and render it as a download link the operator has to open elsewhere.
  const mime = sniff(dest) ?? declared;
  const finalName = mime === declared ? fileName : renameTo(ctx.tenantId, fileName, extFor(mime, url));

  logger.info("vault", `stored ${finalName} (${bytes}B, ${mime}${mime === declared ? "" : ` — declared ${declared}`}) for job ${jobId}`);
  return addAsset(ctx, { jobId, kind: kindOfMime(mime), mime, bytes, fileName: finalName, sourceUrl: url });
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

function renameTo(tenantId: string, fileName: string, ext: string): string {
  const next = `${fileName.replace(/\.[^.]+$/, "")}.${ext}`;
  renameSync(assetPath(tenantId, fileName), assetPath(tenantId, next));
  return next;
}

/** Write bytes we already hold — uploads the operator dropped in, and MCP inline data. */
export function saveBytes(
  ctx: Ctx,
  jobId: string,
  bytes: Buffer,
  mime: string,
): Asset {
  const fileName = `${Date.now().toString(36)}_${randomBytes(6).toString("hex")}.${extFor(mime, "")}`;
  writeFileSync(assetPath(ctx.tenantId, fileName), bytes);
  return addAsset(ctx, { jobId, kind: kindOfMime(mime), mime, bytes: bytes.length, fileName, sourceUrl: undefined });
}

export function readAssetBytes(ctx: Ctx, id: string): { asset: Asset; bytes: Buffer } | null {
  const asset = getAsset(ctx, id);
  if (!asset) return null;
  const file = assetPath(ctx.tenantId, asset.file_name);
  if (!existsSync(file)) return null;
  return { asset, bytes: readFileSync(file) };
}

export function removeAsset(ctx: Ctx, id: string): boolean {
  const asset = getAsset(ctx, id);
  if (!asset) return false;
  const file = assetPath(ctx.tenantId, asset.file_name);
  if (existsSync(file)) unlinkSync(file);
  deleteAsset(ctx, id);
  return true;
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
