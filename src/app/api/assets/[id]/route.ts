import { boot, fail } from "@/lib/server/http";
import { getAsset } from "@/lib/server/repo";
import { assetPath } from "@/lib/server/vault";
import { createReadStream, existsSync, statSync } from "fs";
import { Readable } from "stream";

export const dynamic = "force-dynamic";

/**
 * Serve a vault file.
 *
 * The id is resolved against the tenant BEFORE the disk is touched, which is what makes
 * "the identifier is not an access right" (spec §7) true: a foreign or invented id never
 * reaches a path join. Files are streamed and range requests are honoured, because a
 * <video> element seeking a 40 MB clip issues one immediately.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = boot();
  const { id } = await params;

  const asset = getAsset(ctx, id);
  if (!asset) return fail("not found", 404, "not_found");
  const file = assetPath(ctx.tenantId, asset.file_name);
  if (!existsSync(file)) return fail("asset file is missing from the vault", 410, "gone");

  const size = statSync(file).size;
  const range = req.headers.get("range");
  const headers: Record<string, string> = {
    "Content-Type": asset.mime,
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `inline; filename="${asset.file_name}"`,
  };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    if (start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const stream = createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }

  const stream = createReadStream(file);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...headers, "Content-Length": String(size) },
  });
}
