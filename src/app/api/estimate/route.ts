import { body, handle } from "@/lib/server/http";
import { estimate } from "@/lib/server/engine";
import { getTenant, lastBalance, openReservationTotal } from "@/lib/server/repo";

export const dynamic = "force-dynamic";

/**
 * What would this cost, and would it be allowed?
 *
 * The forms call this as the operator changes parameters, so the button can say the real
 * number before anything is spent — and can say "this will need approval" before the
 * submit rather than after.
 */
export async function POST(req: Request) {
  return handle(async (ctx) => {
    const { kind, params } = await body<{ kind?: string; params?: Record<string, unknown> }>(req);
    if (!kind) throw new Error("kind is required");
    const est = await estimate(ctx, kind, params ?? {});
    const tenant = getTenant(ctx);
    const balance = lastBalance(ctx);
    const spendable = balance ? balance.available - openReservationTotal(ctx) : null;
    return {
      ...est,
      willNeedApproval: est.credits === null || est.credits > tenant.approval_threshold,
      approvalThreshold: tenant.approval_threshold,
      spendable,
      wouldBreachFloor: spendable !== null && est.credits !== null ? spendable - est.credits < tenant.credit_floor : false,
    };
  });
}
