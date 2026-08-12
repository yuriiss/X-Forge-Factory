import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * A minimal ZIP reader for the skill-upload endpoint.
 *
 * adm-zip is not in package.json, and this project does not take on a dependency for one
 * endpoint's convenience — see src/app/api/chat/skills/upload/route.ts. What a skill zip
 * actually needs is small enough to write by hand: read the central directory (the part of
 * a zip that is authoritative about what is in it, even when a local header lies), then
 * inflate each entry with node:zlib's own raw inflate. Only the two compression methods
 * real tooling produces — stored (0) and deflate (8) — are supported; anything else, and
 * anything zip64, is reported rather than guessed at.
 */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export interface UnzipLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface UnzipResult {
  written: string[];
  skipped: { path: string; reason: string }[];
}

export function unzip(buf: Buffer, destDir: string, limits: UnzipLimits): UnzipResult {
  if (buf.length < 22) throw new Error("not a zip file (too short to hold a directory record)");
  const eocdOffset = findEOCD(buf);
  if (eocdOffset < 0) throw new Error("not a zip file (no end-of-central-directory record)");

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralOffset = buf.readUInt32LE(eocdOffset + 16);
  if (totalEntries === 0xffff || centralOffset === 0xffffffff) throw new Error("zip64 archives are not supported");
  if (totalEntries > limits.maxEntries) throw new Error(`zip holds ${totalEntries} entries, over the ${limits.maxEntries} cap`);

  const written: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let totalWritten = 0;

  let p = centralOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error("malformed central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    // The Unix mode bits live in the top 16 bits of the external-attributes field; a
    // directory entry has no bytes of its own, only the files inside it that follow.
    const isDir = rawName.endsWith("/") || ((externalAttrs >>> 16) & 0o170000) === 0o040000;

    const bad = badEntryPath(rawName);
    if (bad) {
      skipped.push({ path: rawName, reason: bad });
      continue;
    }
    if (isDir) continue;

    if (uncompressedSize > limits.maxFileBytes) {
      skipped.push({ path: rawName, reason: `exceeds the per-file cap (${uncompressedSize} bytes)` });
      continue;
    }
    if (totalWritten + uncompressedSize > limits.maxTotalBytes) {
      skipped.push({ path: rawName, reason: "would exceed the total decompressed-size cap" });
      continue;
    }

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`malformed local header for ${rawName}`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      try {
        // maxOutputLength is the actual guard against a bomb: a compressed entry that
        // claims a small uncompressedSize but inflates to far more throws here instead of
        // running the process out of memory.
        data = zlib.inflateRawSync(compressed, { maxOutputLength: limits.maxFileBytes });
      } catch (e) {
        skipped.push({ path: rawName, reason: `could not inflate: ${(e as Error).message}` });
        continue;
      }
    } else {
      skipped.push({ path: rawName, reason: `unsupported compression method ${method}` });
      continue;
    }

    // Belt as well as braces: the name has already been checked, but the only statement
    // worth trusting about a path is one made after resolving it. Anything that does not
    // land under the quarantine directory is refused rather than written somewhere else.
    const dest = path.resolve(destDir, rawName);
    if (dest !== path.resolve(destDir) && !dest.startsWith(path.resolve(destDir) + path.sep)) {
      skipped.push({ path: rawName, reason: "resolves outside the upload directory" });
      continue;
    }

    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    written.push(rawName);
    totalWritten += data.length;
  }

  return { written, skipped };
}

function findEOCD(buf: Buffer): number {
  const maxCommentLen = 65535;
  const start = Math.max(0, buf.length - 22 - maxCommentLen);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** The same three rules the folder-picker path enforces on raw filenames, applied here too
 * so a zip cannot smuggle in what a plain file list is refused for. */
function badEntryPath(name: string): string | null {
  if (name.includes("\0")) return "contains a NUL byte";
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return "absolute path";
  // A backslash is an ordinary character in a POSIX filename and a separator on Windows,
  // so `..\..\evil` walks out of the directory on one platform and merely looks odd on the
  // other. Refusing it everywhere costs nothing: no real skill has one in a path.
  if (name.includes("\\")) return "backslash in path";
  if (name.split("/").includes("..")) return "path traversal";
  if (name.startsWith("__MACOSX/")) return "macOS resource fork metadata";
  return null;
}
