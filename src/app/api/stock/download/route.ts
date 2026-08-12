import { handle, body } from "@/lib/server/http";
import { MagnificError } from "@/lib/server/magnific";
import { resolveStockUrl } from "@/lib/server/stockUrl";
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

export async function POST(req: Request) {
  const input = await body<Body>(req);

  return handle(async (ctx) => {
    if (!/^[\w-]+$/.test(String(input.id))) throw new MagnificError("bad item id", 400, "invalid_params");

    const { url: source, attempts } = await resolveStockUrl(ctx, input.type, String(input.id), input.url);

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
