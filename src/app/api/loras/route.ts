import { handle } from "@/lib/server/http";
import { listLoras } from "@/lib/server/magnific";
import { callTool, isConnected, parseOutline, textOf } from "@/lib/server/mcp";
import { kvGet, kvSet } from "@/lib/server/repo";

export const dynamic = "force-dynamic";

interface LoraRecord {
  id?: number;
  name?: string;
  type?: string;
  preview?: string;
  training?: { status?: string };
  [k: string]: unknown;
}

/**
 * Trained references: LoRAs from REST, plus the Library (characters, styles, products,
 * locations) from MCP.
 *
 * They are two different systems that do the same job for the operator, so both are read
 * and tagged with where they came from — a picker that showed only one would look empty
 * for an account that uses the other.
 */
interface CachedRefs {
  at: number;
  rows: { id: string; name: string; type: string; group: string; status: string; preview: string | null; origin: "rest" }[];
}

/**
 * `/v1/ai/loras` takes twelve seconds on this account — it returns every reference the
 * operator has ever trained, and that is the provider's own latency, not ours. A picker
 * that blanks for twelve seconds every time the view is opened is unusable, and the list
 * changes only when a training finishes, so it is cached for a few minutes and refreshed
 * on demand with `?refresh=1`.
 */
const REFS_TTL_MS = 5 * 60_000;

export async function GET(req: Request) {
  return handle(async (ctx) => {
    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    const cached = kvGet<CachedRefs>(ctx, "loras_cache");
    if (!refresh && cached && Date.now() - cached.at < REFS_TTL_MS) {
      return { references: cached.rows, library: [], cached: true };
    }

    const loras = (await listLoras(ctx)) as Record<string, LoraRecord[]>;
    const flat = Object.entries(loras).flatMap(([group, rows]) =>
      (Array.isArray(rows) ? rows : []).map((r) => ({
        id: String(r.id ?? r.name ?? ""),
        name: String(r.name ?? "reference"),
        type: String(r.type ?? group),
        group,
        status: String(r.training?.status ?? "ready"),
        preview: typeof r.preview === "string" ? r.preview : null,
        origin: "rest" as const,
      })),
    );

    // The Library is a second, slower source. It is given a short budget and dropped if it
    // misses it: the panel's job is to show the operator's references, and eleven seconds
    // of blank picker while an optional extra loads is worse than an incomplete list that
    // renders immediately. `libraryTimedOut` says which happened, so the view can be honest.
    let library: { id: string; name: string; type: string; origin: "mcp" }[] = [];
    let libraryTimedOut = false;
    if (isConnected()) {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000));
      const read = callTool("library_list", {}, { timeoutMs: 8_000 })
        .then((r) =>
          parseOutline(textOf(r), "identifier").map((x) => ({
            id: String(x.identifier),
            name: String(x.name ?? "item"),
            type: String(x.type ?? "library"),
            origin: "mcp" as const,
          })),
        )
        .catch(() => []);
      const won = await Promise.race([read, timeout]);
      if (won === null) libraryTimedOut = true;
      else library = won;
    }

    kvSet(ctx, "loras_cache", { at: Date.now(), rows: flat } satisfies CachedRefs);
    return { references: flat, library, libraryTimedOut, cached: false };
  });
}
