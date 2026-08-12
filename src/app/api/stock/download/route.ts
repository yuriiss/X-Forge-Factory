import { handle, body } from "@/lib/server/http";
import { MagnificError, rest } from "@/lib/server/magnific";
import { callTool, isConnected } from "@/lib/server/mcp";
import { createJob, transition } from "@/lib/server/repo";
import { downloadToVault } from "@/lib/server/vault";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Downloading a stock item into the vault.
 *
 * The point of a stock library reached over an API is that the file arrives here, not that
 * the console links to a web page where somebody clicks a button. So this asks the provider
 * for the signed URL, fetches the bytes, and files them in the Obsidian vault beside
 * everything else X-Forge has made — same naming, same markdown note, same gallery.
 *
 * It costs no credits below a Business plan; it costs one of that plan's hundred daily
 * downloads. The provider's terms ask that every unique download is reported, which is what
 * asking it for the URL does.
 *
 * The signed-URL endpoint is not where the published reference says it is, and its shape
 * differs per library, so each candidate path is tried in turn and the one that answers is
 * used. Sound effects skip the lookup entirely: their search result already carries a
 * playable file.
 */

interface Body extends Record<string, unknown> {
  type: string;
  id: string;
  /** For sound effects, the file the search already handed us. */
  url?: string;
  title?: string;
}

/** The REST paths that have answered for each library, in the order worth trying. */
const CANDIDATES: Record<string, string[]> = {
  images: ["/v1/resources/{id}/download", "/v1/resources/{id}/download/png"],
  videos: ["/v1/videos/{id}/download"],
  icons: ["/v1/icons/{id}/download", "/v1/icons/{id}/download/png"],
  music: ["/v1/music/{id}/download"],
  sfx: ["/v1/sound-effects/{id}/download"],
};

/** MCP's own name for each library, used when REST has nothing to say. */
const MCP_TYPE: Record<string, string> = { images: "photo", videos: "video", icons: "icon" };

function urlIn(value: unknown, depth = 0): string | null {
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

export async function POST(req: Request) {
  const input = await body<Body>(req);

  return handle(async (ctx) => {
    if (!/^[\w-]+$/.test(String(input.id))) throw new MagnificError("bad item id", 400, "invalid_params");

    let source = input.url && input.url.startsWith("http") ? input.url : null;
    const attempts: string[] = [];

    for (const template of CANDIDATES[input.type] ?? []) {
      if (source) break;
      const path = template.replace("{id}", String(input.id));
      try {
        source = urlIn(await rest<unknown>(ctx, path));
        attempts.push(`${path} → ${source ? "ok" : "no url in the answer"}`);
      } catch (e) {
        attempts.push(`${path} → ${(e as Error).message.slice(0, 80)}`);
      }
    }

    // MCP knows this one under a different name and a different shape; it is worth asking
    // before telling an operator the file cannot be had.
    if (!source && MCP_TYPE[input.type] && isConnected()) {
      try {
        const answer = await callTool("stock_download", { id: Number(input.id), type: MCP_TYPE[input.type] });
        source = urlIn(answer);
        attempts.push(`mcp stock_download → ${source ? "ok" : "no url in the answer"}`);
      } catch (e) {
        attempts.push(`mcp stock_download → ${(e as Error).message.slice(0, 80)}`);
      }
    }

    if (!source) {
      throw new MagnificError(
        `the provider gave no download URL for this ${input.type} item. Tried: ${attempts.join(" · ")}`,
        502,
        "no_download_url",
      );
    }

    // A row in the queue so the file has a provenance, and so a download shows up in the
    // same place as everything else that put a file in the vault. It charges nothing: the
    // ledger is for credits, and this is not one.
    const { job } = createJob(ctx, {
      idemKey: `stock:${input.type}:${input.id}`,
      kind: `stock.${input.type}`,
      modelId: "stock",
      params: { id: input.id, type: input.type },
      label: input.title?.slice(0, 80) || `stock ${input.type} ${input.id}`,
      estimatedCredits: 0,
      providerPath: attempts[attempts.length - 1] ?? "stock",
    });

    const asset = await downloadToVault(ctx, job.id, source);
    for (const to of ["validating", "budget_check", "queued", "reserved", "submitted", "running", "downloading", "succeeded"] as const) {
      try {
        transition(ctx, job.id, to, "stock download");
      } catch {
        /* the file is already in the vault; a state row is bookkeeping, not the work */
      }
    }

    return { jobId: job.id, asset };
  });
}
