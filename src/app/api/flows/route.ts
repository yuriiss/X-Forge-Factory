import { handle, q } from "@/lib/server/http";
import { listFlows } from "@/lib/server/magnific";

export const dynamic = "force-dynamic";

/**
 * Published Spaces pipelines.
 *
 * `/v1/ai/flows` is the catalogue of published tools; `/v1/ai/me/flows` is the operator's
 * own, drafts included. Both are offered because "mine" being empty is information — it
 * means nothing has been published from this account yet, not that flows are broken.
 */
export async function GET(req: Request) {
  return handle(async (ctx) => {
    const mine = q(req, "scope") === "mine";
    const flows = await listFlows(ctx, mine);
    return { scope: mine ? "mine" : "published", flows };
  });
}
