import { createHash, randomBytes } from "crypto";
import {
  chargeOnce,
  claim,
  consumeApproval,
  countOpenJobs,
  createJob,
  expiredReservations,
  getApproval,
  getCredential,
  getJob,
  getTenant,
  jobAssets,
  kvGet,
  kvSet,
  lastBalance,
  listJobs,
  openReservation,
  openReservationTotal,
  patchJob,
  putApproval,
  recordBalance,
  releaseReservation,
  requestsInWindow,
  transition,
  updateTenant,
  type Ctx,
  type Job,
} from "./repo";
import {
  capability,
  MagnificError,
  pollTask,
  removeBackground,
  submitTask,
  type Capability,
} from "./magnific";
import { callTool, dataOf, extractIdentifiers, extractUrls, isConnected, simulateCost, waitForCreations } from "./mcp";
import { downloadToVault } from "./vault";
import { logger } from "./logger";

/**
 * The job engine (spec §4–§6).
 *
 * The rules that matter, stated once here because every branch below depends on them:
 *
 *  · the ledger is written exactly once, in `downloading → succeeded`, in the same
 *    transaction that closes the reservation. An estimate is not a charge.
 *  · a timeout, a dropped connection or a 5xx AFTER submission goes to `needs_recon`, not
 *    back to the queue. The generation may well have happened and already cost money;
 *    automatic regeneration is never allowed to be the answer.
 *  · a retryable failure is retried at most once, then it is terminal.
 *  · nothing is ever downgraded to fit the budget. Rejected, reported, forgotten.
 */

export const APPROVAL_TTL_MS = 15 * 60_000;

export interface SubmitInput {
  kind: string;
  params: Record<string, unknown>;
  label?: string;
  /** Force a path; otherwise the engine picks REST when the capability has one. */
  via?: "rest" | "mcp";
  idemKey?: string;
  runId?: string;
  parentJobId?: string;
  /** The operator confirmed the spend in the UI before submitting. */
  preapproved?: boolean;
}

export interface SubmitResult {
  status: string;
  jobId: string;
  reused?: boolean;
  reason?: string;
  estimatedCredits?: number | null;
  approveUrl?: string;
  expiresInS?: number;
  message?: string;
}

/** A stable hash of what the job IS — same request twice is the same job (spec §0). */
export function idemKeyFor(kind: string, params: Record<string, unknown>, salt?: string): string {
  const canonical = JSON.stringify({ kind, params: sortDeep(params), salt: salt ?? "" });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, sortDeep(val)]),
    );
  }
  return v;
}

/* --------------------------------------------------------------- estimate -- */

export interface Estimate {
  credits: number | null;
  certainty: "exact" | "variable" | "unknown";
  reason?: string;
  source: "simulate_cost" | "table" | "none";
  range?: { min?: number; max?: number };
}

/**
 * What a job will cost, asked of Magnific rather than of a table in this repository.
 *
 * `simulate_cost` is read-only and never charges. When it cannot price something the
 * capability table's number is used and labelled as such — and a price that is genuinely
 * unknown stays `null`, which sends the job to the approval gate instead of being guessed
 * at (spec §6: an unknown price is not estimated approximately and not waved through).
 */
export async function estimate(ctx: Ctx, kind: string, params: Record<string, unknown>): Promise<Estimate> {
  const cap = capability(kind);
  if (!cap) return { credits: null, certainty: "unknown", source: "none", reason: `unknown capability ${kind}` };

  if (cap.mcpTool && isConnected()) {
    // The capability's own slug wins over whatever the form sent: a REST job on a named
    // model must not be priced as `auto`, which is the server's price for a decision it
    // has not made yet.
    const args = costArgsFor(cap, { slug: cap.slug, ...params });
    const sim = await simulateCost(cap.mcpTool, args);
    if (sim && typeof sim.credits === "number") {
      return {
        credits: sim.credits,
        certainty: sim.certainty === "exact" ? "exact" : "variable",
        reason: sim.reason,
        source: "simulate_cost",
        range: sim.range,
      };
    }
  }
  return { credits: cap.estimate, certainty: "variable", source: "table", reason: "provider could not price this call; using X-Forge's table" };
}

/* ----------------------------------------------------------------- submit -- */

/**
 * Create a job and walk it as far as the gates allow.
 *
 * Nothing is sent to Magnific here. The function returns when the job is queued, blocked
 * on a human, or rejected — the worker does the spending.
 */
export async function submitJob(ctx: Ctx, input: SubmitInput): Promise<SubmitResult> {
  const cap = capability(input.kind);
  if (!cap) return { status: "failed", jobId: "", reason: "unknown_capability", message: `no capability named ${input.kind}` };

  const idemKey = input.idemKey ?? idemKeyFor(input.kind, input.params, input.runId);
  const est = await estimate(ctx, input.kind, input.params);

  const { job, reused } = createJob(ctx, {
    idemKey,
    kind: input.kind,
    modelId: String(input.params.model ?? input.params.mode ?? input.params.slug ?? cap.label),
    params: { ...input.params, __via: input.via ?? (cap.path ? "rest" : "mcp") },
    label: input.label,
    estimatedCredits: est.credits,
    providerPath: cap.path,
    runId: input.runId,
    parentJobId: input.parentJobId,
  });

  // A repeat of a job that already ran is the answer, not a second charge.
  if (reused && job.status !== "created") {
    return { status: job.status, jobId: job.id, reused: true, estimatedCredits: job.estimated_credits };
  }

  transition(ctx, job.id, "validating", `estimate ${est.credits ?? "unknown"} credits (${est.source})`);

  const tenant = getTenant(ctx);

  // ── the approval gate (spec §6)
  const needsApproval =
    !input.preapproved &&
    ((est.credits === null) ||
      (est.credits > tenant.approval_threshold) ||
      (cap.family === "video" && tenant.video_enabled === 1 && est.credits > tenant.approval_threshold));

  if (needsApproval) {
    const reason =
      est.credits === null
        ? "unknown_price"
        : cap.family === "video"
          ? "video_generation_requires_approval"
          : "estimate_over_threshold";
    const token = randomBytes(16).toString("hex");
    putApproval(ctx, job.id, hashToken(token), reason, APPROVAL_TTL_MS);
    transition(ctx, job.id, "blocked_approval", reason);
    const base = process.env.FORGE_PUBLIC_URL || "http://127.0.0.1:7777";
    return {
      status: "blocked_approval",
      jobId: job.id,
      reason,
      estimatedCredits: est.credits,
      approveUrl: `${base}/a/${job.id}/${token}`,
      expiresInS: APPROVAL_TTL_MS / 1000,
    };
  }

  return budgetCheck(ctx, job.id);
}

function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

/**
 * Every gate in §5, in one transaction's worth of reads, all inside the tenant.
 *
 * The order is deliberate: cheap local facts first, the provider's balance last, so a
 * suspended tenant never causes an outbound call at all.
 */
export function budgetCheck(ctx: Ctx, jobId: string): SubmitResult {
  const job = getJob(ctx, jobId);
  if (!job) return { status: "failed", jobId, reason: "not_found" };
  if (job.status !== "validating" && job.status !== "blocked_approval") {
    return { status: job.status, jobId, estimatedCredits: job.estimated_credits };
  }
  transition(ctx, jobId, "budget_check");

  const tenant = getTenant(ctx);
  const reject = (reason: string, message: string): SubmitResult => {
    patchJob(ctx, jobId, { error_code: reason, error_detail: message });
    transition(ctx, jobId, "rejected_budget", message);
    logger.warn("engine", `job ${jobId} rejected: ${message}`);
    return { status: "rejected_budget", jobId, reason, message, estimatedCredits: job.estimated_credits };
  };

  if (tenant.status !== "active") return reject("tenant_not_active", `tenant is ${tenant.status}`);
  if (!getCredential(ctx)) return reject("no_credential", "no active Magnific credential");
  if (countOpenJobs(ctx) >= tenant.max_concurrent_jobs)
    return reject("max_concurrent", `already running ${tenant.max_concurrent_jobs} jobs`);

  const cap = capability(job.kind);
  if (cap?.family === "video") {
    if (tenant.video_enabled !== 1) return reject("video_disabled", "video is disabled for this tenant");
    if (process.env.FORGE_VIDEO_ENABLED !== "1") return reject("video_disabled_globally", "FORGE_VIDEO_ENABLED is not 1");
  }

  // Rate: the tenant's own RPM, then the shaper that protects everyone from the provider's
  // per-IP limit — every tenant leaves through the same address (spec §1).
  if (requestsInWindow(ctx, 60_000) >= tenant.rpm_limit) return reject("rpm_exceeded", `tenant RPM limit ${tenant.rpm_limit} reached`);
  if (requestsInWindow(ctx, 60_000, true) >= GLOBAL_RPM) return reject("global_shaper", `global outbound shaper at ${GLOBAL_RPM} rpm`);

  const balance = lastBalance(ctx);
  const est = job.estimated_credits ?? 0;
  if (balance) {
    const available = balance.available - openReservationTotal(ctx);
    if (available - est < tenant.credit_floor) {
      return reject(
        "insufficient_credits",
        `available ${available} − estimate ${est} would drop below the floor of ${tenant.credit_floor}`,
      );
    }
  }

  transition(ctx, jobId, "queued", `estimate ${est}`);
  return { status: "queued", jobId, estimatedCredits: job.estimated_credits };
}

const GLOBAL_RPM = Number(process.env.FORGE_GLOBAL_RPM ?? 45);

/* --------------------------------------------------------------- approval -- */

export interface ApprovalView {
  jobId: string;
  kind: string;
  label: string | null;
  modelId: string;
  params: Record<string, unknown>;
  estimatedCredits: number | null;
  balance: number | null;
  reason: string;
  expiresAt: string;
  state: "pending" | "expired" | "used" | "gone";
  decision?: string | null;
}

/**
 * Read an approval by its one-time token.
 *
 * The token is checked by hash, the row by expiry and by prior use. There is deliberately
 * no MCP tool that lifts `blocked_approval` — an agent must not be able to simulate a
 * human saying yes (spec §6).
 */
export function readApproval(jobId: string, token: string): ApprovalView | null {
  const row = getApproval(jobId);
  if (!row) return null;
  if (row.token_hash !== hashToken(token)) return null;

  const ctx: Ctx = { tenantId: row.tenant_id };
  const job = getJob(ctx, jobId);
  if (!job) return null;

  const state: ApprovalView["state"] = row.used_at ? "used" : new Date(row.expires_at) < new Date() ? "expired" : "pending";
  const balance = lastBalance(ctx);
  return {
    jobId,
    kind: job.kind,
    label: job.label,
    modelId: job.model_id,
    params: safeParams(job),
    estimatedCredits: job.estimated_credits,
    balance: balance ? balance.available - openReservationTotal(ctx) : null,
    reason: row.reason,
    expiresAt: row.expires_at,
    state,
    decision: row.decision,
  };
}

export function decideApproval(jobId: string, token: string, decision: "approved" | "rejected"): { ok: boolean; message: string } {
  const view = readApproval(jobId, token);
  if (!view) return { ok: false, message: "unknown or invalid approval link" };
  if (view.state === "used") return { ok: false, message: "this link has already been used" };
  if (view.state === "expired") return { ok: false, message: "this link has expired" };

  const row = getApproval(jobId)!;
  const ctx: Ctx = { tenantId: row.tenant_id };
  // Consume first: a link that survives its own decision is a link that can be replayed.
  consumeApproval(jobId, decision);

  if (decision === "rejected") {
    transition(ctx, jobId, "cancelled", "rejected by operator");
    return { ok: true, message: "Job cancelled." };
  }
  const result = budgetCheck(ctx, jobId);
  kickWorker();
  return { ok: true, message: result.status === "queued" ? "Approved — the job is queued." : `Approved, but ${result.message ?? result.status}.` };
}

function safeParams(job: Job): Record<string, unknown> {
  try {
    const p = JSON.parse(job.params_json) as Record<string, unknown>;
    // Base64 payloads are megabytes of noise on an approval page.
    return Object.fromEntries(
      Object.entries(p).map(([k, v]) => [k, typeof v === "string" && v.length > 300 ? `${v.slice(0, 60)}… (${v.length} chars)` : v]),
    );
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ worker -- */

/**
 * The worker is one per PROCESS, not one per module instance.
 *
 * Hot reload replaces this module but cannot stop the interval the previous copy started,
 * so a few edits leave several workers running — some of them executing code that no
 * longer exists in the repository. They then race each other over the same queue. Parking
 * the handle on `globalThis` means a reloaded module adopts the running worker instead of
 * starting a rival, and `claim()` covers the window before it does.
 */
const WORKER = Symbol.for("x-forge.worker");
interface WorkerSlot {
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  /** Which copy of this module owns the running timer. */
  owner: string | null;
}
const slot = ((globalThis as Record<symbol, unknown>)[WORKER] ??= { timer: null, ticking: false, owner: null } satisfies WorkerSlot) as WorkerSlot;

/** New on every module evaluation, which is exactly what a hot reload produces. */
const MODULE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * One tick: reserve and submit what is queued, poll what is in flight, expire what went
 * stale. Everything is per-tenant; the console has one tenant, and the loop is written as
 * if it had many so that adding one is a data change rather than a rewrite.
 */
export async function tick(ctx: Ctx): Promise<void> {
  const tenant = getTenant(ctx);
  if (tenant.status === "safe_mode") return; // running work is left alone; nothing new starts

  for (const res of expiredReservations(ctx)) {
    releaseReservation(ctx, res.id, "expired");
    const job = getJob(ctx, res.job_id);
    // An expired reservation means we lost track of a job that may have spent money.
    if (job && !["succeeded", "failed", "cancelled", "rejected_budget"].includes(job.status)) {
      try {
        transition(ctx, job.id, "needs_recon", "reservation expired");
      } catch {
        /* already terminal */
      }
    }
  }

  const queued = listJobs(ctx, { status: "queued", limit: 5 });
  for (const job of queued) {
    if (countOpenJobs(ctx) > tenant.max_concurrent_jobs) break;
    await startJob(ctx, job).catch((e) => logger.error("engine", `start ${job.id}: ${(e as Error).message}`));
  }

  const inFlight = [...listJobs(ctx, { status: "submitted", limit: 20 }), ...listJobs(ctx, { status: "running", limit: 20 })];
  for (const job of inFlight) {
    await advanceJob(ctx, job).catch((e) => logger.error("engine", `advance ${job.id}: ${(e as Error).message}`));
  }
}

/**
 * Start the worker, replacing any that is already running.
 *
 * Replacing rather than skipping matters in development: a skipped start leaves the very
 * first module instance driving the queue forever, so edits to the capability table or the
 * adapter appear to have no effect until the server is restarted. Handing over is safe
 * because claiming is atomic — at worst the two overlap for one tick and one of them loses
 * the conditional UPDATE.
 */
export function startWorker(ctx: Ctx): void {
  if (slot.timer && slot.owner === MODULE_ID) return; // already ours, leave it alone
  if (slot.timer) clearInterval(slot.timer);
  slot.ticking = false;
  slot.owner = MODULE_ID;
  slot.timer = setInterval(() => {
    if (slot.ticking) return;
    slot.ticking = true;
    tick(ctx)
      .catch((e) => logger.error("engine", `tick: ${(e as Error).message}`))
      .finally(() => {
        slot.ticking = false;
      });
  }, 3_000);
  logger.info("engine", "worker started");
}

/** Nudge the loop after a submit so a job does not wait out the poll interval. */
export function kickWorker(): void {
  setTimeout(() => {
    /* the interval picks it up; this only exists so a submit feels immediate */
  }, 0);
}

/**
 * Reserve, then hand the job to whichever path it declared.
 *
 * The claim is a conditional UPDATE rather than a read-then-write: a second worker — or a
 * second tick that overlapped after a slow provider call — would otherwise pick up the
 * same queued job and submit it twice. Submitting twice is not a duplicate row, it is a
 * second charge on someone's account.
 */
async function startJob(ctx: Ctx, job: Job): Promise<void> {
  if (!claim(ctx, job.id, "queued", "reserved", "claimed by worker")) return;

  const amount = job.estimated_credits ?? capability(job.kind)?.estimate ?? 0;
  const res = openReservation(ctx, job.id, amount);
  patchJob(ctx, job.id, { reservation_id: res.id });

  // Cancellation stays legal right up to submission (§4), so the last free moment to stop
  // is here — after this line the provider may already have started charging.
  const claimed = getJob(ctx, job.id);
  if (!claimed || claimed.status !== "reserved") {
    releaseReservation(ctx, res.id, "released");
    logger.info("engine", `job ${job.id} left the queue before dispatch (${claimed?.status ?? "gone"})`);
    return;
  }

  const params = JSON.parse(job.params_json) as Record<string, unknown>;
  const via = (params.__via as string) ?? "rest";
  try {
    if (via === "mcp") await startViaMcp(ctx, job, params);
    else await startViaRest(ctx, job, params);
  } catch (e) {
    const err = e as MagnificError;
    // Before submission nothing was spent, so a failure here can be released cleanly.
    releaseReservation(ctx, res.id, "released");
    // A job that went terminal underneath us (cancelled, revoked credential) is not a
    // failure to record — there is no state left to move it to.
    const current = getJob(ctx, job.id);
    if (!current || ["cancelled", "failed", "succeeded", "rejected_budget"].includes(current.status)) {
      logger.info("engine", `job ${job.id} was already ${current?.status ?? "gone"} when dispatch failed`);
      return;
    }
    const retryable = err instanceof MagnificError && (err.status === 429 || err.status >= 500);
    patchJob(ctx, job.id, { error_code: err instanceof MagnificError ? err.code : "submit_failed", error_detail: err.message });
    if (retryable && job.attempt < job.max_attempts - 1) {
      patchJob(ctx, job.id, { attempt: job.attempt + 1 });
      transition(ctx, job.id, "failed_retryable", err.message);
      transition(ctx, job.id, "queued", "retrying once");
    } else {
      transition(ctx, job.id, "failed", err.message);
    }
  }
}

/** The REST path: submit a task, remember its id, let the poller take over. */
async function startViaRest(ctx: Ctx, job: Job, params: Record<string, unknown>): Promise<void> {
  const cap = capability(job.kind)!;
  if (!cap.path) throw new MagnificError(`${job.kind} has no REST path — submit it over MCP`, 400, "no_rest_path");

  // Background removal is synchronous and form-encoded; it never becomes a task.
  if (job.kind === "image.remove-bg") {
    if (!claim(ctx, job.id, "reserved", "submitted", "remove-background (synchronous)")) return;
    const url = await removeBackground(ctx, String(params.image_url ?? params.image ?? ""));
    transition(ctx, job.id, "downloading", "1 result");
    await finish(ctx, job.id, [url]);
    return;
  }

  const path = (params.__path as string) || cap.path;
  const body = restBodyFor(job.kind, params);
  const task = await submitTask(ctx, path, body);
  patchJob(ctx, job.id, { provider_task_id: task.taskId, provider_path: path });
  // The task is with the provider now. If the job moved underneath us the id is still
  // recorded above, which is what a later reconciliation needs.
  claim(ctx, job.id, "reserved", "submitted", `task ${task.taskId}`);
}

/**
 * The MCP path.
 *
 * `tools/call` blocks until the tool returns, which for a generation is the whole render —
 * so this runs as its own promise and the job is moved along from inside it. What comes
 * back is either creation identifiers to wait on or URLs directly; both are handled
 * because the tools are not consistent about which they send.
 */
async function startViaMcp(ctx: Ctx, job: Job, params: Record<string, unknown>): Promise<void> {
  const cap = capability(job.kind)!;
  if (!cap.mcpTool) throw new MagnificError(`${job.kind} has no MCP tool — submit it over REST`, 400, "no_mcp_tool");
  if (!claim(ctx, job.id, "reserved", "submitted", `mcp ${cap.mcpTool}`)) return;

  const args = mcpArgsFor(cap, params);
  void (async () => {
    try {
      const result = await callTool(cap.mcpTool!, args, { timeoutMs: (cap.patience ?? 10) * 60_000 });
      if (result.isError) throw new Error(textOfError(result));

      let urls = extractUrls(result);
      if (!urls.length) {
        const ids = extractIdentifiers(result);
        if (ids.length) {
          const refreshed = getJob(ctx, job.id);
          if (refreshed?.status === "submitted") transition(ctx, job.id, "running", `waiting on ${ids.length} creation(s)`);
          patchJob(ctx, job.id, { provider_task_id: ids[0] });
          const waited = await waitForCreations(ids, { timeoutMs: (cap.patience ?? 10) * 60_000 });
          urls = waited.map((w) => w.url).filter((u): u is string => !!u);
        }
      }

      if (!urls.length) {
        // Some tools do their work and answer in prose — a folder move, a resize that the
        // server applied in place. That is a success with nothing to download.
        const text = String(dataOf(result) ?? "");
        transition(ctx, job.id, "downloading", "no files returned");
        await finish(ctx, job.id, [], text.slice(0, 500));
        return;
      }

      const cur = getJob(ctx, job.id);
      if (cur?.status === "submitted") transition(ctx, job.id, "running", `${urls.length} result(s)`);
      transition(ctx, job.id, "downloading", `${urls.length} file(s)`);
      await finish(ctx, job.id, urls);
    } catch (e) {
      await failInFlight(ctx, job.id, e as Error);
    }
  })();
}

function textOfError(result: { content?: { type: string; text?: string }[] }): string {
  return result.content?.map((c) => c.text ?? "").join(" ").slice(0, 400) || "tool reported an error";
}

/**
 * When each in-flight job may be polled again.
 *
 * Every poll is a real request against the operator's 50-per-minute key. Three jobs polled
 * on a three-second tick is sixty requests a minute — the console would rate-limit itself
 * out of submitting anything new. So each job backs off as it ages: quick while a fast
 * image is landing, slow for a video that takes ten minutes either way.
 */
const nextPollAt = new Map<string, number>();

function pollDelayMs(ageSeconds: number): number {
  return Math.min(30_000, 6_000 + ageSeconds * 100);
}

/** Poll a REST task, then download. */
async function advanceJob(ctx: Ctx, job: Job): Promise<void> {
  const params = JSON.parse(job.params_json) as Record<string, unknown>;
  if ((params.__via as string) === "mcp") return; // its own promise drives it

  if (!job.provider_task_id || !job.provider_path) return;

  const due = nextPollAt.get(job.id) ?? 0;
  if (Date.now() < due) return;
  const ageSeconds = Math.max(0, (Date.now() - new Date(job.created_at).getTime()) / 1000);
  nextPollAt.set(job.id, Date.now() + pollDelayMs(ageSeconds));

  let status;
  try {
    status = await pollTask(ctx, job.provider_path, job.provider_task_id);
  } catch (e) {
    const err = e as MagnificError;
    // A failed POLL is not a failed generation. The task may be running and may already
    // have cost money, so a transport error here never re-submits anything.
    if (err.status >= 500 || err.status === 429) return;
    await failInFlight(ctx, job.id, err);
    return;
  }

  if (status.state === "running" && job.status === "submitted") {
    transition(ctx, job.id, "running", status.raw);
    return;
  }
  if (status.state === "queued" || status.state === "running") return;

  if (status.state === "failed") {
    await failInFlight(ctx, job.id, new Error(status.error ?? "task failed"));
    return;
  }

  nextPollAt.delete(job.id);
  transition(ctx, job.id, "downloading", `${status.urls.length} file(s)`);
  await finish(ctx, job.id, status.urls);
}

/**
 * Download, charge once, close the reservation, mark it succeeded.
 *
 * The charge and the reservation close in one transaction (`chargeOnce`), and the actual
 * amount is the estimate — Magnific does not tell us afterwards what a task really cost,
 * so the honest thing is to record what was reserved and let the reconciler correct the
 * balance against the account.
 */
async function finish(ctx: Ctx, jobId: string, urls: string[], note?: string): Promise<void> {
  const job = getJob(ctx, jobId);
  if (!job) return;
  try {
    for (const url of urls) {
      await downloadToVault(ctx, jobId, url);
    }
    chargeOnce(ctx, jobId, job.estimated_credits ?? 0, job.reservation_id);
    transition(ctx, jobId, "succeeded", note ?? `${urls.length} asset(s)`);
    logger.info("engine", `job ${jobId} succeeded with ${urls.length} asset(s)`);
    void refreshBalance(ctx).catch(() => undefined);
  } catch (e) {
    // The files were generated and paid for; failing to store them is our problem, not a
    // reason to pretend the job never ran.
    patchJob(ctx, jobId, { error_code: "download_failed", error_detail: (e as Error).message });
    transition(ctx, jobId, "needs_recon", `download failed: ${(e as Error).message}`);
  }
}

/**
 * A failure after submission.
 *
 * If the provider said "failed", the reservation is released — nothing was produced. If we
 * merely lost contact, the job goes to `needs_recon` and the reservation stays open, so
 * the balance keeps counting money that might already be gone.
 */
async function failInFlight(ctx: Ctx, jobId: string, err: Error): Promise<void> {
  const job = getJob(ctx, jobId);
  if (!job) return;
  const definite = /moderation|failed|invalid|rejected|not allowed|validation/i.test(err.message);
  patchJob(ctx, jobId, { error_code: definite ? "provider_failed" : "lost_contact", error_detail: err.message });

  if (definite) {
    if (job.reservation_id) releaseReservation(ctx, job.reservation_id, "released");
    if (job.attempt < job.max_attempts - 1 && /timeout|temporarily|503|502/i.test(err.message)) {
      patchJob(ctx, jobId, { attempt: job.attempt + 1 });
      transition(ctx, jobId, "failed_retryable", err.message);
      transition(ctx, jobId, "queued", "retrying once");
      return;
    }
    transition(ctx, jobId, "failed", err.message);
    return;
  }
  transition(ctx, jobId, "needs_recon", err.message);
}

/* ------------------------------------------------------------ reconciler -- */

/**
 * Compare what we believe we spent with what the account says, per tenant (spec §5).
 *
 * Drift past the threshold puts THIS tenant into `safe_mode`: new jobs are refused, work
 * already running is allowed to finish, and it takes a human to switch it back on.
 */
export async function reconcile(ctx: Ctx): Promise<{ drift: number | null; safeMode: boolean; message: string }> {
  const before = lastBalance(ctx);
  const fresh = await refreshBalance(ctx);
  if (!fresh || !before) return { drift: null, safeMode: false, message: "no balance to compare against yet" };

  const expected = before.available - (kvGet<number>(ctx, "spend_since_snapshot") ?? 0);
  const drift = Math.abs(fresh.available - expected);
  const threshold = Number(process.env.FORGE_DRIFT_THRESHOLD ?? 2000);
  kvSet(ctx, "spend_since_snapshot", 0);

  if (drift > threshold) {
    updateTenant(ctx, { status: "safe_mode" });
    logger.warn("engine", `drift ${drift} over ${threshold} — tenant ${ctx.tenantId} moved to safe_mode`);
    return { drift, safeMode: true, message: `drift of ${drift} credits exceeded ${threshold}; tenant moved to safe_mode` };
  }
  return { drift, safeMode: false, message: `drift ${drift} credits, within ${threshold}` };
}

export interface Balance {
  available: number;
  totalPlan: number | null;
  spent: number | null;
  tier: string | null;
  at: string;
  source: string;
}

/**
 * The account balance, from `account_balance` over MCP.
 *
 * The REST key has no balance endpoint — the number the console shows has to come from
 * somewhere real, and this is the only place it exists. Without an MCP session there is
 * no balance and the console says so rather than inventing one.
 */
export async function refreshBalance(ctx: Ctx): Promise<Balance | null> {
  if (!isConnected()) return null;
  try {
    const r = await callTool("account_balance", {}, { timeoutMs: 30_000 });
    const d = dataOf(r) as { plan?: { tier?: string; productName?: string }; credits?: { available?: number; totalPlan?: number; spent?: number } };
    const available = d?.credits?.available;
    if (typeof available !== "number") return null;
    recordBalance(ctx, {
      available,
      total_plan: d.credits?.totalPlan ?? null,
      spent: d.credits?.spent ?? null,
      tier: d.plan?.productName ?? d.plan?.tier ?? null,
      source: "mcp:account_balance",
    });
    const snap = lastBalance(ctx)!;
    return { available: snap.available, totalPlan: snap.total_plan, spent: snap.spent, tier: snap.tier, at: snap.at, source: snap.source };
  } catch (e) {
    logger.warn("engine", `balance refresh failed: ${(e as Error).message}`);
    return null;
  }
}

/* ------------------------------------------------------ request shaping -- */

export function shaperState(ctx: Ctx): { tenantRpm: number; tenantLimit: number; globalRpm: number; globalLimit: number; burst: number } {
  const tenant = getTenant(ctx);
  return {
    tenantRpm: requestsInWindow(ctx, 60_000),
    tenantLimit: tenant.rpm_limit,
    globalRpm: requestsInWindow(ctx, 60_000, true),
    globalLimit: GLOBAL_RPM,
    burst: requestsInWindow(ctx, 5_000, true),
  };
}

/* -------------------------------------------------- REST / MCP arguments -- */

/**
 * The video endpoints spell aspect ratios out.
 *
 * `16:9` is what a person reads and what the MCP tools take; the REST video models answer
 * "Input should be 'widescreen_16_9', 'social_story_9_16' or 'square_1_1'". Rather than
 * making the forms speak the wire format, the translation lives here — and an unmapped
 * value is dropped rather than sent, because an omitted ratio uses the model default while
 * a wrong one fails the whole request.
 */
const NAMED_ASPECT: Record<string, string> = {
  "16:9": "widescreen_16_9",
  "9:16": "social_story_9_16",
  "1:1": "square_1_1",
  "4:3": "classic_4_3",
  "3:4": "traditional_3_4",
  "3:2": "standard_3_2",
  "2:3": "portrait_2_3",
  "21:9": "cinematic_21_9",
};

function namedAspect(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  if (v.includes("_")) return v; // already the wire form
  return NAMED_ASPECT[v];
}

/** Everything the REST endpoints want, per capability. Undefined fields are dropped. */
function restBodyFor(kind: string, p: Record<string, unknown>): Record<string, unknown> {
  const clean = (o: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && v !== null && v !== "" && !k.startsWith("__")));

  switch (kind) {
    case "image.mystic":
      return clean({
        prompt: p.prompt,
        aspect_ratio: p.aspect_ratio ?? "square_1_1",
        resolution: p.resolution ?? "2k",
        model: p.model,
        creative_detailing: p.creative_detailing,
        engine: p.engine,
        fixed_generation: p.fixed_generation,
        filter_nsfw: p.filter_nsfw ?? true,
        structure_reference: p.structure_reference,
        structure_strength: p.structure_strength,
        style_reference: p.style_reference,
        adherence: p.adherence,
        hdr: p.hdr,
        styling: p.styling,
        webhook_url: p.webhook_url,
      });
    case "image.flux-dev":
    case "image.hyperflux":
    case "image.flux-2-pro":
    case "image.seedream":
      return clean({
        prompt: p.prompt,
        aspect_ratio: p.aspect_ratio ?? "square_1_1",
        resolution: p.resolution,
        webhook_url: p.webhook_url,
      });
    case "image.upscale":
      return clean({
        image: p.image,
        scale_factor: p.scale_factor ?? "2x",
        optimized_for: p.optimized_for,
        engine: p.engine ?? "automatic",
        prompt: p.prompt,
        creativity: p.creativity ?? 0,
        hdr: p.hdr ?? 0,
        resemblance: p.resemblance ?? 0,
        fractality: p.fractality ?? 0,
        filter_nsfw: p.filter_nsfw,
        webhook_url: p.webhook_url,
      });
    case "image.upscale-precision":
      return clean({
        image: p.image,
        scale_factor: p.scale_factor ?? "4x",
        sharpen: p.sharpen ?? 7,
        smart_grain: p.smart_grain ?? 7,
        ultra_detail: p.ultra_detail ?? 30,
        flavor: p.flavor ?? "photo",
        webhook_url: p.webhook_url,
      });
    case "image.skin":
      return clean({ image: p.image, webhook_url: p.webhook_url });
    case "image.relight":
      return clean({
        image: p.image,
        prompt: p.prompt,
        transfer_light_from_reference_image: p.transfer_light_from_reference_image,
        light_transfer_strength: p.light_transfer_strength,
        interpolate_from_original: p.interpolate_from_original,
        change_background: p.change_background,
        style: p.style,
        whites: p.whites,
        blacks: p.blacks,
        webhook_url: p.webhook_url,
      });
    case "image.expand":
      return clean({ image: p.image, prompt: p.prompt, aspect_ratio: p.aspect_ratio, webhook_url: p.webhook_url });
    case "video.t2v":
      return clean({ prompt: p.prompt, duration: String(p.duration ?? "5"), aspect_ratio: namedAspect(p.aspect_ratio), webhook_url: p.webhook_url });
    case "video.i2v":
      // Caught here rather than at the provider, because "Validation error" on a field the
      // operator never typed is the least useful failure a console can report.
      if (typeof p.image === "string" && p.image.startsWith("data:")) {
        throw new MagnificError(
          "image → video needs a hosted image — re-drop the still so it is staged, then submit again",
          400,
          "bad_input",
        );
      }
      return clean({
        image: p.image,
        image_end: p.image_end,
        prompt: p.prompt,
        // Both must be strings: the enum is '5' | '10', and a numeric 5 is a validation
        // error rather than a coercion.
        duration: String(p.duration ?? "5"),
        aspect_ratio: namedAspect(p.aspect_ratio),
        generate_audio: p.generate_audio,
        camera_fixed: p.camera_fixed,
        seed: p.seed,
        webhook_url: p.webhook_url,
      });
    case "audio.music":
      return clean({ prompt: p.prompt, music_length_seconds: p.duration ?? 15, negative_prompt: p.negative_prompt, seed: p.seed, webhook_url: p.webhook_url });
    case "audio.sfx":
      return clean({ text: p.prompt, duration_seconds: p.duration ?? 5, webhook_url: p.webhook_url });
    case "audio.isolate":
      return clean({ description: p.description ?? "isolate the main voice", audio: p.audio, webhook_url: p.webhook_url });
    case "utility.image-to-prompt":
      return clean({ image: p.image });
    case "utility.improve-prompt":
      return clean({ prompt: p.prompt });
    default:
      return clean(p);
  }
}

/**
 * What `simulate_cost` wants, which is not always what the tool itself wants.
 *
 * The pricer takes the fields that determine the price and nothing else — for video that
 * is a FLAT `{slug, duration, resolution}` rather than the nested `video.clips[]` the
 * generator needs, and for audio it is a model plus a length. Calling it with the tool's
 * own argument shape answers "the api field is required", which reads as a broken
 * integration and is really two different contracts wearing the same name. Asking each
 * pricer with `{}` first is how these were found: it replies with its required fields.
 */
function costArgsFor(cap: Capability, p: Record<string, unknown>): Record<string, unknown> {
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

  switch (cap.mcpTool) {
    case "video_generate":
      return clean({
        slug: p.slug ?? cap.slug,
        duration: Number(p.duration ?? 5),
        resolution: p.resolution,
        aspectRatio: p.aspectRatio ?? p.aspect_ratio,
        withSoundEffects: p.generate_audio,
      });
    case "audio_music_generate":
      return clean({ model: p.model ?? "google-lyria-3", durationSeconds: Number(p.duration ?? 30) });
    case "audio_tts":
      return clean({ model: p.model ?? "eleven_v3", text: p.text ?? p.prompt ?? "" });
    default:
      return mcpArgsFor(cap, p);
  }
}

/** The MCP tools take camelCase and their own names; this is the translation layer. */
export function mcpArgsFor(cap: Capability, p: Record<string, unknown>): Record<string, unknown> {
  const clean = (o: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && v !== null && v !== "" && !k.startsWith("__")));

  switch (cap.mcpTool) {
    case "images_generate":
      return clean({
        prompt: p.prompt,
        mode: p.slug ?? p.mode ?? "auto",
        aspectRatio: p.aspectRatio ?? p.aspect_ratio_mcp ?? "1:1",
        numImages: p.numImages,
        references: p.references,
        folderReference: p.folderReference,
      });
    case "images_generate_svg":
      return clean({ prompt: p.prompt, style: p.style, folderReference: p.folderReference });
    case "images_to_svg":
      return clean({ creationIdentifier: p.creationIdentifier });
    case "images_upscale":
      return clean({
        creationIdentifier: p.creationIdentifier,
        mode: p.mode ?? "creative",
        scale: p.scale ?? "2x",
        engine: p.engine,
        optimised: p.optimised,
        presets: p.presets,
        precisionPreset: p.precisionPreset,
        prompt: p.prompt,
        creativity: p.creativity,
        resemblance: p.resemblance,
      });
    case "images_relight":
      return clean({ creationIdentifier: p.creationIdentifier, prompt: p.prompt, style: p.style });
    case "images_expand":
      return clean({ creationIdentifier: p.creationIdentifier, prompt: p.prompt, aspectRatio: p.aspectRatio });
    case "images_remove_background":
      return clean({ creationIdentifier: p.creationIdentifier });
    case "images_change_camera":
      return clean({ creationIdentifier: p.creationIdentifier, prompt: p.prompt });
    case "images_variations":
      return clean({ creationIdentifier: p.creationIdentifier, prompt: p.prompt });
    case "images_retouch":
      return clean({ creationIdentifier: p.creationIdentifier, prompt: p.prompt });
    case "images_skin_enhancer":
      return clean({ creationIdentifier: p.creationIdentifier, mode: p.mode });
    case "images_crop":
      return clean({ creationIdentifier: p.creationIdentifier, aspectRatio: p.aspectRatio });
    case "images_resize":
      return clean({ creationIdentifier: p.creationIdentifier, width: p.width, height: p.height });
    case "video_generate":
      return clean({
        video: {
          clips: [
            clean({
              slug: p.slug,
              prompt: p.prompt,
              duration: Number(p.duration ?? 5),
              aspectRatio: p.aspectRatio ?? "16:9",
              resolution: p.resolution,
              ...(p.startImage ? { keyframes: { start: { type: "image", url: p.startImage } } } : {}),
            }),
          ],
        },
      });
    case "video_upscale":
      return clean({ creationIdentifier: p.creationIdentifier, slug: p.slug });
    case "video_speak":
      return clean({ creationIdentifier: p.creationIdentifier, audioIdentifier: p.audioIdentifier, slug: p.slug });
    case "audio_tts":
      return clean({ text: p.text ?? p.prompt, voiceId: p.voiceId ? Number(p.voiceId) : undefined, model: p.model, speed: p.speed });
    case "audio_music_generate":
      return clean({ prompt: p.prompt, duration: p.duration, model: p.model });
    case "models3d_generate":
      return clean({ creationIdentifier: p.creationIdentifier, model: p.model ?? "tripo-p1", textureQuality: p.textureQuality });
    default:
      return clean(p);
  }
}

/* ----------------------------------------------------------------- views -- */

export interface JobView {
  id: string;
  kind: string;
  label: string | null;
  modelId: string;
  status: string;
  via: string;
  estimatedCredits: number | null;
  actualCredits: number | null;
  providerTaskId: string | null;
  providerPath: string | null;
  error: string | null;
  errorCode: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  ageSeconds: number;
  assets: { id: string; kind: string; mime: string; bytes: number; url: string }[];
}

export function viewJob(ctx: Ctx, job: Job): JobView {
  const params = (() => {
    try {
      return JSON.parse(job.params_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    modelId: job.model_id,
    status: job.status,
    via: String(params.__via ?? "rest"),
    estimatedCredits: job.estimated_credits,
    actualCredits: job.actual_credits,
    providerTaskId: job.provider_task_id,
    providerPath: job.provider_path,
    error: job.error_detail,
    errorCode: job.error_code,
    attempt: job.attempt,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    ageSeconds: Math.max(0, Math.round((Date.now() - new Date(job.created_at).getTime()) / 1000)),
    assets: jobAssets(ctx, job.id).map((a) => ({
      id: a.id,
      kind: a.kind,
      mime: a.mime,
      bytes: a.bytes,
      url: `/api/assets/${a.id}`,
    })),
  };
}
