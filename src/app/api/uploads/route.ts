import { handle, q } from "@/lib/server/http";
import { listAssets } from "@/lib/server/repo";
import { listUploads, uploadBytes } from "@/lib/server/magnific";
import { importFileAsCreation, isConnected } from "@/lib/server/mcp";
import { kindOfMime, saveBytes } from "@/lib/server/vault";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Take a file from the operator and make it usable everywhere.
 *
 * One drop, three results, because the three consumers each want something different:
 *   · the vault copy, so the console can show it and re-use it without a network hop;
 *   · a base64 data URL for the REST endpoints, which accept image bytes inline;
 *   · a creation identifier for the MCP tools, which accept nothing else.
 *
 * The staging URL is requested too — `remove-background` refuses base64 and needs a
 * publicly reachable image, which is the one case where a local file is not enough.
 */
export async function POST(req: Request) {
  return handle(async (ctx) => {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("no file in the request");

    const bytes = Buffer.from(await file.arrayBuffer());
    const mime = file.type || "application/octet-stream";
    const wantCreation = String(form.get("creation") ?? "") === "1";
    const wantStaging = String(form.get("staging") ?? "") === "1";

    // `job_id` is a label here, not a foreign key — an upload is not a job, but the vault
    // wants every asset attached to something so the gallery can group it.
    const asset = saveBytes(ctx, "upload", bytes, mime);

    let creationIdentifier: string | null = null;
    if (wantCreation && isConnected()) {
      creationIdentifier = await importFileAsCreation(bytes, mime).catch(() => null);
    }

    let assetUrl: string | null = null;
    if (wantStaging) {
      assetUrl = await uploadBytes(ctx, bytes, mime).catch(() => null);
    }

    return {
      asset: { id: asset.id, url: `/api/assets/${asset.id}`, mime, bytes: asset.bytes, kind: kindOfMime(mime) },
      dataUrl: bytes.length < 12 * 1024 * 1024 ? `data:${mime};base64,${bytes.toString("base64")}` : null,
      creationIdentifier,
      assetUrl,
      note:
        bytes.length >= 12 * 1024 * 1024
          ? "file is too large to inline as base64 — use the creation identifier or the staged URL"
          : undefined,
    };
  });
}

/** What is staged provider-side, and what is in the local vault. */
export async function GET(req: Request) {
  return handle(async (ctx) => {
    if (q(req, "scope") === "vault") {
      const { rows, total } = listAssets(ctx, { limit: 50 });
      return { scope: "vault", total, items: rows.map((a) => ({ id: a.id, mime: a.mime, bytes: a.bytes, url: `/api/assets/${a.id}`, created: a.created_at })) };
    }
    const staged = (await listUploads(ctx)) as { files?: unknown[] };
    return { scope: "staging", files: staged.files ?? [] };
  });
}
