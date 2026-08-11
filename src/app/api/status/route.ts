import { handle } from "@/lib/server/http";
import { credentialStatus, getTenant, lastBalance, listJobs, openReservationTotal, spentToday } from "@/lib/server/repo";
import { refreshBalance, shaperState } from "@/lib/server/engine";
import { isConnected, readAuth } from "@/lib/server/mcp";
import { verifyKey } from "@/lib/server/magnific";
import { vaultUsage } from "@/lib/server/vault";
import { vaultRoot } from "@/lib/server/paths";

export const dynamic = "force-dynamic";

/**
 * The REST reachability probe is cached.
 *
 * The dashboard polls this endpoint, and every probe is a real authenticated call that
 * counts against the operator's 50-per-minute key limit — the shaper then refuses actual
 * work because a status light was being kept warm. A minute-old answer is honest for a
 * connectivity indicator, and any genuine failure surfaces on the next job anyway.
 */
let restProbe: { ok: boolean; at: number } | null = null;
const PROBE_TTL_MS = 60_000;

/**
 * One call that answers "is this console actually wired up".
 *
 * The dashboard's status line, credit gauge, rate meters and service list all come from
 * here, so they always agree with each other — three panels each fetching their own truth
 * is how a UI ends up showing "connected" next to "no credential".
 */
export async function GET() {
  return handle(async (ctx) => {
    const tenant = getTenant(ctx);
    const cred = credentialStatus(ctx);
    const mcp = readAuth();

    // The balance is only refreshed when it is stale; the dashboard polls, and asking
    // Magnific every few seconds would burn the account's rate budget on a gauge.
    let balance = lastBalance(ctx);
    const staleMs = Date.now() - (balance ? new Date(balance.at).getTime() : 0);
    if (!balance || staleMs > 60_000) {
      const fresh = await refreshBalance(ctx).catch(() => null);
      if (fresh) balance = lastBalance(ctx);
    }

    let restOk = false;
    if (cred.present) {
      if (restProbe && Date.now() - restProbe.at < PROBE_TTL_MS) restOk = restProbe.ok;
      else {
        restOk = await verifyKey(ctx).catch(() => false);
        restProbe = { ok: restOk, at: Date.now() };
      }
    }
    const reserved = openReservationTotal(ctx);
    const today = spentToday(ctx);
    const open = listJobs(ctx, { status: "running", limit: 50 }).length + listJobs(ctx, { status: "queued", limit: 50 }).length;

    return {
      rest: { connected: restOk, base: "https://api.magnific.com", credential: cred },
      mcp: {
        connected: isConnected(),
        server: mcp.server,
        issuer: mcp.issuer ?? null,
        scope: mcp.scope ?? null,
        expiresAt: mcp.expiresAt ?? null,
      },
      balance: balance
        ? {
            available: balance.available,
            reserved,
            spendable: balance.available - reserved,
            totalPlan: balance.total_plan,
            spent: balance.spent,
            tier: balance.tier,
            at: balance.at,
          }
        : null,
      today,
      openJobs: open,
      shaper: shaperState(ctx),
      // Where the files actually are. The console has been asked this question by every
      // operator who found a folder panel and assumed it was local.
      vault: { root: vaultRoot(), ...vaultUsage(ctx) },
      tenant: {
        id: tenant.id,
        displayName: tenant.display_name,
        status: tenant.status,
        creditFloor: tenant.credit_floor,
        approvalThreshold: tenant.approval_threshold,
        videoEnabled: tenant.video_enabled === 1,
        maxConcurrentJobs: tenant.max_concurrent_jobs,
        rpmLimit: tenant.rpm_limit,
        retentionDays: tenant.retention_days,
      },
    };
  });
}
