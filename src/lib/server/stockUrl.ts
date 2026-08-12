import type { Ctx } from "./repo";
import { rest } from "./magnific";
import { callTool, isConnected } from "./mcp";

/**
 * Finding the file behind a stock item.
 *
 * The search results carry a thumbnail and, for sound effects, a playable file; everything
 * else needs a second call that returns a signed URL. That call is the provider's download
 * endpoint, which is also how a download is reported — so resolving a URL is not free on a
 * plan with a daily cap, and the console says so where it matters rather than resolving
 * quietly in the background.
 *
 * The endpoint is not where the published reference says it is and its answer is shaped
 * differently per library, so each candidate is tried in turn and the one that answers
 * wins. MCP is asked last: it knows the same items under different names.
 */

/** REST paths that have answered, in the order worth trying. */
const CANDIDATES: Record<string, string[]> = {
  images: ["/v1/resources/{id}/download", "/v1/resources/{id}/download/png"],
  videos: ["/v1/videos/{id}/download"],
  icons: ["/v1/icons/{id}/download", "/v1/icons/{id}/download/png"],
  music: ["/v1/music/{id}/download"],
  sfx: ["/v1/sound-effects/{id}/download"],
};

/** MCP's own name for each library. */
const MCP_TYPE: Record<string, string> = { images: "photo", videos: "video", icons: "icon" };

export function urlIn(value: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  if (typeof value === "string") return value.startsWith("http") ? value : null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = urlIn(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const field of ["url", "download_url", "href", "source", "data", "file_url"]) {
      const found = urlIn((value as Record<string, unknown>)[field], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export interface Resolved {
  url: string | null;
  /** Every path tried and what it said, so a failure names itself rather than shrugging. */
  attempts: string[];
}

export async function resolveStockUrl(ctx: Ctx, type: string, id: string, known?: string): Promise<Resolved> {
  if (known && known.startsWith("http")) return { url: known, attempts: ["given by the search result"] };

  const attempts: string[] = [];
  let url: string | null = null;

  for (const template of CANDIDATES[type] ?? []) {
    if (url) break;
    const path = template.replace("{id}", id);
    try {
      url = urlIn(await rest<unknown>(ctx, path));
      attempts.push(`${path} → ${url ? "ok" : "no url in the answer"}`);
    } catch (e) {
      attempts.push(`${path} → ${(e as Error).message.slice(0, 80)}`);
    }
  }

  if (!url && MCP_TYPE[type] && isConnected()) {
    try {
      url = urlIn(await callTool("stock_download", { id: Number(id), type: MCP_TYPE[type] }));
      attempts.push(`mcp stock_download → ${url ? "ok" : "no url in the answer"}`);
    } catch (e) {
      attempts.push(`mcp stock_download → ${(e as Error).message.slice(0, 80)}`);
    }
  }

  return { url, attempts };
}
