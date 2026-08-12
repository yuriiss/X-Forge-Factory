import { body, handle } from "@/lib/server/http";
import { MagnificError } from "@/lib/server/magnific";
import { resolveStockUrl } from "@/lib/server/stockUrl";

export const dynamic = "force-dynamic";

/**
 * The playable URL for one stock item, without saving it.
 *
 * Sound effects come with their file in the search result; music does not, and the only
 * place the provider hands one over is the download endpoint. So a preview costs the same
 * call a download does, which is worth knowing on a plan with a hundred a day — hence a
 * button the operator presses per track rather than a list that resolves twenty-four rows
 * the moment it renders.
 */
export async function POST(req: Request) {
  const input = await body<{ type: string; id: string; url?: string }>(req);

  return handle(async (ctx) => {
    if (!/^[\w-]+$/.test(String(input.id))) throw new MagnificError("bad item id", 400, "invalid_params");

    const { url, attempts } = await resolveStockUrl(ctx, input.type, String(input.id), input.url);
    if (!url) throw new MagnificError(`no playable file for this item. Tried: ${attempts.join(" · ")}`, 502, "no_url");
    return { url };
  });
}
