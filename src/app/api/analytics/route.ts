import { handle, qn } from "@/lib/server/http";
import { ledgerByModel, ledgerSummary, listJobs, recentEvents, spentToday } from "@/lib/server/repo";
import { rest } from "@/lib/server/magnific";
import { callTool, dataOf, isConnected } from "@/lib/server/mcp";

export const dynamic = "force-dynamic";

/**
 * Consumption, from the engine's own ledger — plus the team endpoints when the account
 * has a team.
 *
 * `/v1/analytics/*` is Business and Enterprise only and answers 403 with
 * "User does not belong to any team" otherwise. That is reported as what it is rather
 * than rendered as an empty chart, and the local ledger — which is per-job, exact, and
 * always available — carries the view either way.
 */
export async function GET(req: Request) {
  return handle(async (ctx) => {
    const days = qn(req, "days", 14);

    const daily = ledgerSummary(ctx, days);
    const byModel = ledgerByModel(ctx, days);
    const jobs = listJobs(ctx, { limit: 400 });
    const outcomes = jobs.reduce<Record<string, number>>((acc, j) => {
      acc[j.status] = (acc[j.status] ?? 0) + 1;
      return acc;
    }, {});

    let team: { available: boolean; reason?: string; members?: unknown } = { available: false };
    try {
      const members = await rest(ctx, "/v1/analytics/team-members");
      team = { available: true, members };
    } catch (e) {
      team = { available: false, reason: (e as Error).message };
    }

    let project: unknown = null;
    if (isConnected()) {
      project = await callTool("project_report", {}, { timeoutMs: 45_000 })
        .then((r) => dataOf(r))
        .catch(() => null);
    }

    return {
      days,
      daily,
      byModel,
      outcomes,
      today: spentToday(ctx),
      totals: {
        credits: daily.reduce((n, d) => n + d.credits, 0),
        generations: daily.reduce((n, d) => n + d.jobs, 0),
      },
      audit: recentEvents(ctx, 40),
      team,
      project,
    };
  });
}
