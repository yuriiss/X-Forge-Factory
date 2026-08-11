import { body, handle } from "@/lib/server/http";
import { rest } from "@/lib/server/magnific";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Train a Soul reference — a character or a style the generators can then be told to use.
 *
 * Two endpoints, one shape: `/v1/ai/loras/characters` additionally wants a `gender`, which
 * `/v1/ai/loras/styles` does not accept. Both want a name, a quality and the training
 * images; the fields are only discoverable from the validation error, which is why they
 * are pinned here rather than inferred at the call site.
 *
 * Training is slow and asynchronous on Magnific's side. This starts it and reports what
 * came back; the trained reference then appears in the list once the provider marks it
 * completed, which is where the console reads status from rather than polling a job it
 * does not own.
 */
export async function POST(req: Request) {
  return handle(async (ctx) => {
    const input = await body<{ type?: string; name?: string; gender?: string; quality?: string; images?: string[] }>(req);
    const type = input.type === "style" ? "styles" : "characters";

    if (!input.name?.trim()) throw new Error("a name is required — this is what you will type in a prompt");
    if (!input.images?.length) throw new Error("training images are required");

    const payload: Record<string, unknown> = {
      name: input.name.trim(),
      quality: input.quality ?? "medium",
      images: input.images,
      ...(type === "characters" ? { gender: input.gender ?? "unspecified" } : {}),
    };

    const result = await rest(ctx, `/v1/ai/loras/${type}`, { body: payload });
    return { started: true, type, result };
  });
}
