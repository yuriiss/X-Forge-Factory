import { handle } from "@/lib/server/http";
import { reconcile } from "@/lib/server/engine";

export const dynamic = "force-dynamic";

/** Run the reconciler now (spec §5) — drift past the threshold parks the tenant. */
export async function POST() {
  return handle(async (ctx) => reconcile(ctx));
}
