import { body, fail, handle } from "@/lib/server/http";
import { getJob, jobEvents, transition } from "@/lib/server/repo";
import { viewJob } from "@/lib/server/engine";
import { pollTask } from "@/lib/server/magnific";

export const dynamic = "force-dynamic";

/**
 * A job, by id.
 *
 * A job belonging to another tenant is a 404 and not a 403 — acceptance §9 asks for this
 * explicitly, because 403 confirms the id exists and turns enumeration into a directory.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle(async (ctx) => {
    const job = getJob(ctx, id);
    if (!job) return fail("not found", 404, "not_found");
    return { job: viewJob(ctx, job), events: jobEvents(ctx, id) };
  });
}

/**
 * Cancel, or reconcile.
 *
 * Cancellation is only legal before submission (§4) — once a task is with the provider it
 * may already have cost money, and pretending otherwise makes the ledger a fiction.
 * Reconciliation is the only way out of `needs_recon`, and it asks the provider what
 * actually happened rather than assuming.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { action } = await body<{ action?: string }>(req);
  return handle(async (ctx) => {
    const job = getJob(ctx, id);
    if (!job) return fail("not found", 404, "not_found");

    if (action === "cancel") {
      const cancellable = ["created", "validating", "blocked_approval", "budget_check", "queued", "reserved"];
      if (!cancellable.includes(job.status)) {
        return fail(`cannot cancel a job that is ${job.status} — it is already with the provider`, 409, "not_cancellable");
      }
      transition(ctx, id, "cancelled", "cancelled by operator");
      return { job: viewJob(ctx, getJob(ctx, id)!) };
    }

    if (action === "reconcile") {
      if (job.status !== "needs_recon") return fail(`job is ${job.status}, not needs_recon`, 409, "not_recon");
      if (!job.provider_task_id || !job.provider_path) {
        transition(ctx, id, "failed", "no provider task id to reconcile against");
        return { job: viewJob(ctx, getJob(ctx, id)!), outcome: "no_task_id" };
      }
      const status = await pollTask(ctx, job.provider_path, job.provider_task_id);
      if (status.state === "completed") {
        // The work exists — adopt it rather than regenerating anything (§4).
        const { adoptReconciled } = await import("@/lib/server/recon");
        await adoptReconciled(ctx, id, status.urls);
        return { job: viewJob(ctx, getJob(ctx, id)!), outcome: "adopted" };
      }
      if (status.state === "failed") {
        transition(ctx, id, "failed", status.error ?? "provider reports failed");
        return { job: viewJob(ctx, getJob(ctx, id)!), outcome: "failed" };
      }
      return { job: viewJob(ctx, getJob(ctx, id)!), outcome: status.state };
    }

    return fail("unknown action", 400, "bad_action");
  });
}
