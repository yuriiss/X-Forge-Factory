import { handle, q, qn } from "@/lib/server/http";
import { listAssets } from "@/lib/server/repo";
import { recentCreations } from "@/lib/server/magnific";
import { callTool, isConnected, parseOutline, textOf } from "@/lib/server/mcp";

export const dynamic = "force-dynamic";

/**
 * The library, from both sides.
 *
 * The vault holds what X-Forge generated and downloaded — those files are local, permanent
 * and playable. The account holds everything the operator has ever made anywhere, and its
 * URLs expire. Both are shown, labelled by origin, because a gallery that quietly mixes
 * them leaves the operator guessing which thumbnails will still resolve tomorrow.
 */
export async function GET(req: Request) {
  return handle(async (ctx) => {
    const scope = q(req, "scope", "vault");
    const kind = q(req, "kind", "all");
    const page = qn(req, "page", 1);
    const perPage = qn(req, "per_page", 24);

    if (scope === "account") {
      const rows = await recentCreations(ctx, perPage);
      return {
        scope,
        total: rows.length,
        items: rows.map((r) => ({
          id: String(r.id),
          origin: "account",
          label: r.name ?? "untitled",
          kind: guessKind(r),
          created: r.created_at ?? null,
          preview: pickPreview(r),
          tool: r.tool_name ?? null,
          reference: r.reference ?? null,
        })),
      };
    }

    if (scope === "folders") {
      if (!isConnected()) return { scope, folders: [], note: "folders live on the MCP session" };
      const r = await callTool("folders_list", {}, { timeoutMs: 45_000 });
      const rows = parseOutline(textOf(r), "reference");
      return {
        scope,
        folders: rows.map((f) => ({ reference: String(f.reference), name: String(f.name ?? "folder") })),
      };
    }

    if (scope === "spaces") {
      if (!isConnected()) return { scope, spaces: [], note: "spaces live on the MCP session" };
      const r = await callTool("spaces_list", {}, { timeoutMs: 45_000 });
      const rows = parseOutline(textOf(r), "identifier").concat(parseOutline(textOf(r), "reference"));
      return { scope, spaces: rows.map((s) => ({ id: String(s.identifier ?? s.reference), name: String(s.name ?? "space") })) };
    }

    const { rows, total } = listAssets(ctx, { kind, limit: perPage, offset: (page - 1) * perPage, query: q(req, "q") || undefined });
    return {
      scope: "vault",
      total,
      page,
      perPage,
      items: rows.map((a) => ({
        id: a.id,
        origin: "vault",
        label: a.label ?? a.model_id,
        kind: a.kind,
        mime: a.mime,
        bytes: a.bytes,
        created: a.created_at,
        jobId: a.job_id,
        url: `/api/assets/${a.id}`,
        model: a.model_id,
      })),
    };
  });
}

function guessKind(r: Record<string, unknown>): string {
  const t = String(r.tool_name ?? r.type ?? "").toLowerCase();
  if (t.includes("video")) return "video";
  if (t.includes("voice") || t.includes("audio") || t.includes("music")) return "audio";
  if (t.includes("3d")) return "3d";
  if (t.includes("svg")) return "vector";
  return "image";
}

/**
 * A thumbnail that will actually load.
 *
 * The recent-creations payload carries several URL-ish fields and not all of them are
 * images — `url` is often the gallery page. Only fields that look like files are used,
 * and a creation with none renders as a glyph rather than a broken image.
 */
function pickPreview(r: Record<string, unknown>): string | null {
  for (const k of ["thumbnail", "preview", "preview_url", "thumbnail_url", "image", "url"]) {
    const v = r[k];
    if (typeof v === "string" && /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?|$)/i.test(v)) return v;
  }
  return null;
}
