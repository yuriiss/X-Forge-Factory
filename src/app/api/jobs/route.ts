import { body, handle, q, qn } from "@/lib/server/http";
import { listJobs } from "@/lib/server/repo";
import { submitJob, viewJob, type SubmitInput } from "@/lib/server/engine";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async (ctx) => {
    const rows = listJobs(ctx, { status: q(req, "status", "all"), limit: qn(req, "limit", 60), kind: q(req, "kind") || undefined });
    return { jobs: rows.map((j) => viewJob(ctx, j)) };
  });
}

/**
 * Submit.
 *
 * The answer is one of: `queued` (the worker has it), `blocked_approval` (with a link a
 * human must open — spec §6), `rejected_budget` (with the reason), or a terminal status
 * when this exact request was already run and idempotency handed back the original job.
 */
export async function POST(req: Request) {
  return handle(async (ctx) => {
    const input = await body<Record<string, unknown>>(req);
    if (typeof input.kind !== "string") throw new Error("kind is required");
    return submitJob(ctx, {
      kind: input.kind,
      params: (input.params as Record<string, unknown>) ?? {},
      label: input.label as string | undefined,
      via: input.via as SubmitInput["via"],
      preapproved: input.preapproved === true,
      runId: input.runId as string | undefined,
      parentJobId: input.parentJobId as string | undefined,
    });
  });
}
