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
          preview: pick(v, ["thumbnails", "thumbnail", "image"]),
          clip: pick(v, ["previews"]),
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
          // The music library returns a `cover_url` on a bucket that answers 403 to
          // everyone, so mapping it only produces a broken-image icon. Sound effects are
          // the ones with a real file, and that one plays.
          preview: null,
          clip: pick(m, ["file_url", "preview_url", "preview"]),
          url: String(m.file_url ?? m.preview ?? m.url ?? ""),
          tags: (m.genres as { name?: string }[] | undefined)?.map((g) => g.name).filter(Boolean) ?? [],
        })),
      };
    }

    const content = q(req, "content");
    const j = (await searchStock(ctx, {
      term,
      limit: String(limit),
      page: String(page),
      ...(content ? { [`filters[content_type][${content}]`]: "1" } : {}),
    })) as { data?: Record<string, unknown>[] };
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

/**
 * The first usable image URL under any of `keys`.
 *
 * Each library buries it differently — a resource has `image.source.url`, a video has an
 * array of `thumbnails` sorted small to large, an icon has a plain string — so this walks
 * one object or array deep rather than assuming a shape. It used to stop at the first
 * object and return null, which is why every photo tile was blank while the icons worked.
 */
function pick(o: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const found = urlIn(o[key], 0);
    if (found) return found;
  }
  return null;
}

function urlIn(value: unknown, depth: number): string | null {
  if (depth > 3) return null;
  if (typeof value === "string") return value.startsWith("http") ? https(value) : null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = urlIn(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const field of ["url", "source", "src", "thumbnail", "large", "small"]) {
      const found = urlIn(record[field], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Provider thumbnails come back as `http://` on some libraries. The console is local so a
 * browser loads them either way, but an operator who puts it behind TLS would see every
 * tile blocked as mixed content, and these hosts all answer on https.
 */
function https(url: string): string {
  return url.startsWith("http://") ? `https://${url.slice(7)}` : url;
}

function describeResource(r: Record<string, unknown>): string {
  const type = (r.image as { type?: string } | undefined)?.type ?? r.type ?? "photo";
  const lic = (r.licenses as { type?: string }[] | undefined)?.[0]?.type;
  return [String(type), lic].filter(Boolean).join(" · ");
}
