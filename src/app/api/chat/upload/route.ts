import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { forgeHome } from "@/lib/server/paths";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * A file dropped into a chat.
 *
 * It is written to disk and its path goes into the prompt, because the CLIs on the other
 * end are agents with filesystem access: given a path, a model opens the file itself, at
 * full resolution, with whatever tool suits it. Inlining an image as base64 into the prompt
 * would cost tokens for something the model can already reach, and would not survive the
 * `--resume` of a later turn.
 *
 * Providers cannot do that — they have no filesystem — so an image also comes back as a
 * data URL, and the send route decides which of the two to use.
 */

const MAX_BYTES = 32 * 1024 * 1024;

/** Enough to know how to describe the file to a model that will read it. */
function kindOf(mime: string, name: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (/\.(md|txt|csv|json|ya?ml|log)$/i.test(name)) return "text";
  return "file";
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "no file" }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: "that file is larger than 32 MB" }, { status: 413 });

  const bytes = Buffer.from(await file.arrayBuffer());

  // The name is somebody else's, so it never reaches a path unexamined: only the basename
  // survives, and only characters that cannot climb out of the directory.
  const safe = path.basename(file.name).replace(/[^\w.-]/g, "_").slice(-80) || "attachment";
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = path.join(forgeHome(), "chat-files", stamp);
  mkdirSync(dir, { recursive: true });

  const unique = `${Date.now().toString(36)}_${safe}`;
  const full = path.join(dir, unique);
  writeFileSync(full, bytes);

  const kind = kindOf(file.type || "", safe);
  const dataUrl = kind === "image" && bytes.length <= 6 * 1024 * 1024 ? `data:${file.type};base64,${bytes.toString("base64")}` : undefined;

  return Response.json({ name: safe, path: full, kind, bytes: bytes.length, dataUrl });
}
