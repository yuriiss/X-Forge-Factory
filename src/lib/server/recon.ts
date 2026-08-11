import { chargeOnce, getJob, transition, type Ctx } from "./repo";
import { downloadToVault } from "./vault";
import { logger } from "./logger";

/**
 * Adopt a task that turned out to have completed after all.
 *
 * `needs_recon` exists because a lost connection is not a lost generation: the task may
 * have finished and charged the account. Reconciliation downloads what is there and
 * charges the ledger once — the same single charge the happy path makes, so a job cannot
 * be billed twice by being reconciled after it already succeeded.
 */
export async function adoptReconciled(ctx: Ctx, jobId: string, urls: string[]): Promise<void> {
  const job = getJob(ctx, jobId);
  if (!job) return;
  for (const url of urls) {
    await downloadToVault(ctx, jobId, url).catch((e) => logger.warn("recon", `download ${url}: ${(e as Error).message}`));
  }
  chargeOnce(ctx, jobId, job.estimated_credits ?? 0, job.reservation_id);
  transition(ctx, jobId, "succeeded", `reconciled ${urls.length} asset(s)`);
  logger.info("recon", `job ${jobId} adopted after reconciliation`);
}
