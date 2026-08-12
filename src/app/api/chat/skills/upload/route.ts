import { installFromDir } from "@/lib/server/skills";
import { unzip } from "@/lib/server/miniZip";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Upload your own skill — a zip, a folder picked file-by-file, or a lone SKILL.md.
 *
 * This endpoint exists to take arbitrary bytes from an operator's disk and turn them into
 * something installFromDir can scan, safely: every entry is checked against the same rules
 * before a single byte lands in quarantine, and the quarantine directory is removed however
 * the request ends. installFromDir is the same gate the registry path goes through, so
 * nothing reaches the live skills directory without a scan in between.
 */

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

export async function POST(req: Request) {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: `request body over the ${MAX_BODY_BYTES}-byte cap` }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return Response.json({ error: `not a valid multipart upload: ${(e as Error).message}` }, { status: 400 });
  }

  const agentId = (form.get("agentId") as string) || "claude";
  const force = form.get("force") === "1";
  const reason = (form.get("reason") as string) || "";
  const files = form.getAll("files").filter((v): v is File => v instanceof File);

  if (!files.length) return Response.json({ error: "no files in upload" }, { status: 400 });
  if (files.length > MAX_ENTRIES) {
    return Response.json({ error: `${files.length} files, over the ${MAX_ENTRIES}-entry cap` }, { status: 413 });
  }
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_BODY_BYTES) {
    return Response.json({ error: `upload totals ${totalBytes} bytes, over the ${MAX_BODY_BYTES}-byte cap` }, { status: 413 });
  }

  const pen = mkdtempSync(path.join(os.tmpdir(), "x-forge-skill-upload-"));
  try {
    const skipped: string[] = [];

    if (files.length === 1 && files[0].name.toLowerCase().endsWith(".zip")) {
      // ZIP support is a hand-rolled central-directory reader over node:zlib's raw inflate
      // (src/lib/server/miniZip.ts), not adm-zip — that package is not in package.json and
      // this endpoint does not add a dependency for it. The alternative allowed by the same
      // reasoning would have been to refuse zips outright and accept only folder/SKILL.md
      // uploads; the reader was small enough that refusing felt like the worse trade.
      const buf = Buffer.from(await files[0].arrayBuffer());
      const result = unzip(buf, pen, { maxEntries: MAX_ENTRIES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_BODY_BYTES });
      skipped.push(...result.skipped.map((s) => `${s.path}: ${s.reason}`));
      if (!result.written.length) {
        return Response.json({ error: "zip contained nothing installable", skipped }, { status: 400 });
      }
    } else {
      for (const file of files) {
        const rel = file.name;
        const bad = badEntryPath(rel);
        if (bad) {
          skipped.push(`${rel}: ${bad}`);
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          skipped.push(`${rel}: exceeds the ${MAX_FILE_BYTES}-byte per-file cap`);
          continue;
        }
        const dest = path.join(pen, rel);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
      }
    }

    const result = installFromDir(agentId, pen, force, reason);
    return Response.json({ ...result, skipped }, { status: result.ok ? 200 : result.outcome === "REJECT" ? 403 : 409 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  } finally {
    rmSync(pen, { recursive: true, force: true });
  }
}

/** The same three refusals miniZip.ts applies to zip entries, applied here to the raw
 * filenames a folder-picker upload carries — one set of rules, enforced on both paths. */
function badEntryPath(name: string): string | null {
  if (name.includes("\0")) return "contains a NUL byte";
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return "absolute path";
  if (name.split("/").includes("..")) return "path traversal";
  if (name.startsWith("__MACOSX/")) return "macOS resource fork metadata";
  return null;
}
