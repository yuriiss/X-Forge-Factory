import { body, handle } from "@/lib/server/http";
import { getTenant, updateTenant } from "@/lib/server/repo";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async (ctx) => ({ tenant: getTenant(ctx) }));
}

/**
 * The operator's own limits (spec §2.1).
 *
 * `credit_floor` and `approval_threshold` belong to whoever's credits they are — the
 * engine ships a safe default and then gets out of the way. `status` is here so a tenant
 * that the reconciler parked in `safe_mode` can be switched back on by hand, which is the
 * only way out of it by design.
 */
export async function PATCH(req: Request) {
  return handle(async (ctx) => {
    const patch = await body<Record<string, unknown>>(req);
    const num = (k: string) => (patch[k] === undefined ? undefined : Math.max(0, Number(patch[k])));
    const tenant = updateTenant(ctx, {
      credit_floor: num("credit_floor"),
      approval_threshold: num("approval_threshold"),
      max_concurrent_jobs: num("max_concurrent_jobs"),
      rpm_limit: num("rpm_limit"),
      retention_days: num("retention_days"),
      video_enabled: patch.video_enabled === undefined ? undefined : patch.video_enabled ? 1 : 0,
      status: patch.status === "active" || patch.status === "safe_mode" || patch.status === "suspended" ? (patch.status as string) : undefined,
    });
    return { tenant };
  });
}
