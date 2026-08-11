import { handle, q, qn } from "@/lib/server/http";
import { searchIcons, searchStock, searchStockMusic, searchStockSfx, searchStockVideos } from "@/lib/server/magnific";

export const dynamic = "force-dynamic";

/**
 * Stock search across the four libraries the key can reach.
 *
 * Each library answers in its own shape — `data[]` for resources and icons, `results[]`
 * with a `count` for music and sound effects — so each is normalised here rather than in
 * the view, which would otherwise need four renderers for one grid.
 */
export async function GET(req: Request) {
  return handle(async (ctx) => {
    const type = q(req, "type", "images");
    const term = q(req, "q");
    const limit = qn(req, "limit", 20);
    const page = qn(req, "page", 1);

    if (type === "icons") {
      const j = (await searchIcons(ctx, { term, per_page: String(limit), page: String(page) })) as { data?: Record<string, unknown>[] };
      return {
        type,
        items: (j.data ?? []).map((i) => ({
          id: String(i.id),
          title: String(i.name ?? "icon"),
          preview: pick(i, ["thumbnails", "free_svg", "preview"]),
          meta: String((i.style as { name?: string } | undefined)?.name ?? "icon"),
          url: String(i.free_svg ?? ""),
        })),
      };
    }

    if (type === "videos") {
      const j = (await searchStockVideos(ctx, { term, limit: String(limit), page: String(page) })) as { data?: Record<string, unknown>[] };
      return {
        type,
        items: (j.data ?? []).map((v) => ({
          id: String(v.id),
          title: String(v.name ?? v.title ?? "clip"),
          preview: pick(v, ["thumbnail", "preview", "image"]),
          meta: String(v.resolution ?? v.duration ?? "video"),
          url: String(v.url ?? ""),
        })),
      };
    }

    if (type === "music" || type === "sfx") {
      const j = (await (type === "music" ? searchStockMusic : searchStockSfx)(ctx, {
        term,
        limit: String(limit),
        page: String(page),
      })) as { results?: Record<string, unknown>[]; count?: number };
      return {
        type,
        total: j.count ?? null,
        items: (j.results ?? []).map((m) => ({
          id: String(m.id),
          title: String(m.title ?? "track"),
          meta: String(m.time ?? (m.duration ? `${m.duration}s` : "")),
          preview: null,
          url: String(m.preview ?? m.url ?? ""),
          tags: (m.genres as { name?: string }[] | undefined)?.map((g) => g.name).filter(Boolean) ?? [],
        })),
      };
    }

    const j = (await searchStock(ctx, { term, limit: String(limit), page: String(page) })) as { data?: Record<string, unknown>[] };
    return {
      type: "images",
      items: (j.data ?? []).map((r) => ({
        id: String(r.id),
        title: String(r.title ?? "resource"),
        preview: pick(r, ["image", "thumbnail", "preview"]),
        meta: describeResource(r),
        url: String(r.url ?? ""),
      })),
    };
  });
}

function pick(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.startsWith("http")) return v;
    if (v && typeof v === "object") {
      const nested = (v as Record<string, unknown>).source ?? (v as Record<string, unknown>).url;
      if (typeof nested === "string" && nested.startsWith("http")) return nested;
      if (Array.isArray(v) && typeof v[0] === "object") {
        const first = (v[0] as Record<string, unknown>).url;
        if (typeof first === "string") return first;
      }
    }
  }
  return null;
}

function describeResource(r: Record<string, unknown>): string {
  const type = (r.image as { type?: string } | undefined)?.type ?? r.type ?? "photo";
  const lic = (r.licenses as { type?: string }[] | undefined)?.[0]?.type;
  return [String(type), lic].filter(Boolean).join(" · ");
}
