import { db, newId, LOCAL_TENANT } from "./db";
import { logger } from "./logger";

/**
 * The repository layer (spec §3).
 *
 * Every read and every write goes through a `Ctx` that carries the tenant. A call without
 * one throws instead of running — that is the rule the spec states, and it is enforced
 * here rather than documented, because a query that silently drops its `WHERE tenant_id`
 * returns plausible data and no error. Route handlers never touch SQL directly.
 */

export interface Ctx {
  tenantId: string;
  clientId?: string;
}

export function requireCtx(ctx: Ctx | undefined | null): Ctx {
  if (!ctx || !ctx.tenantId) throw new Error("repository call without a tenant in context");
  return ctx;
}

/** The console's single operator. `tenant_id` is derived here, never read from a request. */
export function localCtx(clientId?: string): Ctx {
  return { tenantId: LOCAL_TENANT, clientId };
}

export interface Tenant {
  id: string;
  display_name: string;
  status: string;
  credit_floor: number;
  approval_threshold: number;
  video_enabled: number;
  max_concurrent_jobs: number;
  rpm_limit: number;
  retention_days: number;
  created_at: string;
}

export function getTenant(ctx: Ctx): Tenant {
  requireCtx(ctx);
  const row = db().prepare("SELECT * FROM forge_tenants WHERE id = ?").get(ctx.tenantId) as unknown as Tenant | undefined;
  if (!row) throw new Error(`unknown tenant ${ctx.tenantId}`);
  return row;
}

export function updateTenant(ctx: Ctx, patch: Partial<Tenant>): Tenant {
  requireCtx(ctx);
  const allowed: (keyof Tenant)[] = [
    "credit_floor",
    "approval_threshold",
    "video_enabled",
    "max_concurrent_jobs",
    "rpm_limit",
    "retention_days",
    "status",
  ];
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(patch[k] as string | number);
  }
  if (sets.length) {
    vals.push(ctx.tenantId);
    db().prepare(`UPDATE forge_tenants SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getTenant(ctx);
}

/* ------------------------------------------------------------ credentials -- */

export interface CredentialRow {
  id: string;
  ciphertext: Buffer;
  dek_wrapped: Buffer;
  key_fingerprint: string;
  last4: string;
  status: string;
  last_verified_at: string | null;
  created_at: string;
}

export function getCredential(ctx: Ctx, provider = "magnific"): CredentialRow | null {
  requireCtx(ctx);
  const row = db()
    .prepare(
      "SELECT id, ciphertext, dek_wrapped, key_fingerprint, last4, status, last_verified_at, created_at " +
        "FROM forge_tenant_credentials WHERE tenant_id = ? AND provider = ? AND status = 'active'",
    )
    .get(ctx.tenantId, provider) as unknown as CredentialRow | undefined;
  return row ?? null;
}

/** The UI form of a credential: never the key, only what identifies it (requirement 3). */
export function credentialStatus(ctx: Ctx): { present: boolean; last4?: string; fingerprint?: string; verifiedAt?: string | null } {
  const row = getCredential(ctx);
  if (!row) return { present: false };
  return {
    present: true,
    last4: row.last4,
    // A fingerprint is for correlating logs, not for display in full.
    fingerprint: `${row.key_fingerprint.slice(0, 12)}…`,
    verifiedAt: row.last_verified_at,
  };
}

export function markCredentialVerified(ctx: Ctx): void {
  requireCtx(ctx);
  db()
    .prepare("UPDATE forge_tenant_credentials SET last_verified_at = ?, status = 'active' WHERE tenant_id = ?")
    .run(new Date().toISOString(), ctx.tenantId);
}

export function revokeCredential(ctx: Ctx): void {
  requireCtx(ctx);
  // Requirement 6: the ciphertext goes NOW, queued work is cancelled with it.
  db().prepare("DELETE FROM forge_tenant_credentials WHERE tenant_id = ?").run(ctx.tenantId);
  const open = db()
    .prepare("SELECT id FROM forge_jobs WHERE tenant_id = ? AND status IN ('created','validating','blocked_approval','budget_check','queued','reserved')")
    .all(ctx.tenantId) as { id: string }[];
  for (const j of open) transition(ctx, j.id, "cancelled", "credential revoked");
  logger.warn("repo", `credential revoked for ${ctx.tenantId}; cancelled ${open.length} job(s)`);
}

/* ------------------------------------------------------------------ jobs -- */

export type JobStatus =
  | "created"
  | "validating"
  | "blocked_approval"
  | "budget_check"
  | "queued"
  | "reserved"
  | "submitted"
  | "running"
  | "downloading"
  | "succeeded"
  | "failed_retryable"
  | "failed"
  | "needs_recon"
  | "rejected_budget"
  | "cancelled";

export interface Job {
  id: string;
  tenant_id: string;
  idem_key: string;
  client_id: string | null;
  run_id: string | null;
  parent_job_id: string | null;
  kind: string;
  model_id: string;
  params_json: string;
  prompt_version: string;
  label: string | null;
  status: JobStatus;
  attempt: number;
  max_attempts: number;
  estimated_credits: number | null;
  actual_credits: number | null;
  provider_task_id: string | null;
  provider_path: string | null;
  reservation_id: string | null;
  error_code: string | null;
  error_detail: string | null;
  priority: number;
  not_before: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

export interface NewJob {
  idemKey: string;
  kind: string;
  modelId: string;
  params: Record<string, unknown>;
  label?: string;
  estimatedCredits?: number | null;
  providerPath?: string;
  runId?: string;
  parentJobId?: string;
  priority?: number;
}

export const PROMPT_VERSION = "xf-1";

/**
 * Insert, or hand back the job this idem key already made (spec §0).
 *
 * The uniqueness is composite, so an identical prompt from another tenant is a different
 * job — that is the whole point. Within one tenant a repeat is a no-op, which is what
 * makes a retried submit safe.
 */
export function createJob(ctx: Ctx, input: NewJob): { job: Job; reused: boolean } {
  requireCtx(ctx);
  const existing = db()
    .prepare("SELECT * FROM forge_jobs WHERE tenant_id = ? AND idem_key = ?")
    .get(ctx.tenantId, input.idemKey) as unknown as Job | undefined;
  if (existing) return { job: existing, reused: true };

  const id = newId("job_");
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO forge_jobs (id, tenant_id, idem_key, client_id, run_id, parent_job_id, kind, model_id,
         params_json, prompt_version, label, status, estimated_credits, provider_path, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.tenantId,
      input.idemKey,
      ctx.clientId ?? null,
      input.runId ?? null,
      input.parentJobId ?? null,
      input.kind,
      input.modelId,
      JSON.stringify(input.params),
      PROMPT_VERSION,
      input.label ?? null,
      input.estimatedCredits ?? null,
      input.providerPath ?? null,
      input.priority ?? 100,
      now,
      now,
    );
  addEvent(ctx, id, null, "created", input.label ?? input.modelId);
  return { job: getJob(ctx, id)!, reused: false };
}

/** Scoped by tenant: a foreign id is `null` here, which becomes a 404 (acceptance §9). */
export function getJob(ctx: Ctx, id: string): Job | null {
  requireCtx(ctx);
  return (db().prepare("SELECT * FROM forge_jobs WHERE id = ? AND tenant_id = ?").get(id, ctx.tenantId) as unknown as Job) ?? null;
}

export function listJobs(ctx: Ctx, opts: { status?: string; limit?: number; kind?: string } = {}): Job[] {
  requireCtx(ctx);
  const where: string[] = ["tenant_id = ?"];
  const vals: (string | number)[] = [ctx.tenantId];
  if (opts.status && opts.status !== "all") {
    if (opts.status === "running") where.push("status IN ('submitted','running','downloading')");
    else if (opts.status === "queued") where.push("status IN ('created','validating','budget_check','queued','reserved','blocked_approval')");
    else if (opts.status === "done") where.push("status = 'succeeded'");
    else if (opts.status === "failed") where.push("status IN ('failed','rejected_budget','needs_recon','cancelled')");
    else {
      where.push("status = ?");
      vals.push(opts.status);
    }
  }
  if (opts.kind) {
    where.push("kind = ?");
    vals.push(opts.kind);
  }
  vals.push(opts.limit ?? 100);
  return db()
    .prepare(`SELECT * FROM forge_jobs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...vals) as unknown as Job[];
}

export function countOpenJobs(ctx: Ctx): number {
  requireCtx(ctx);
  const row = db()
    .prepare(
      "SELECT COUNT(*) AS n FROM forge_jobs WHERE tenant_id = ? AND status IN ('queued','reserved','submitted','running','downloading')",
    )
    .get(ctx.tenantId) as { n: number };
  return row.n;
}

/**
 * The only way a job's status changes.
 *
 * Illegal edges are refused rather than logged: the state machine in §4 is the contract
 * the rest of the engine relies on, and "it ended up in `queued` from `submitted`" is
 * exactly the bug that re-generates something the operator already paid for.
 */
const EDGES: Record<JobStatus, JobStatus[]> = {
  created: ["validating", "cancelled", "failed"],
  validating: ["blocked_approval", "budget_check", "failed", "cancelled"],
  blocked_approval: ["budget_check", "cancelled", "failed"],
  budget_check: ["queued", "rejected_budget", "cancelled", "failed"],
  queued: ["reserved", "cancelled", "failed"],
  reserved: ["submitted", "cancelled", "failed", "needs_recon"],
  submitted: ["running", "downloading", "failed_retryable", "failed", "needs_recon"],
  running: ["downloading", "failed_retryable", "failed", "needs_recon"],
  downloading: ["succeeded", "failed_retryable", "failed", "needs_recon"],
  failed_retryable: ["queued", "failed"],
  succeeded: [],
  failed: [],
  needs_recon: ["succeeded", "failed"],
  rejected_budget: [],
  cancelled: [],
};

const TERMINAL: JobStatus[] = ["succeeded", "failed", "rejected_budget", "cancelled"];

export function transition(ctx: Ctx, jobId: string, to: JobStatus, detail?: string): Job {
  requireCtx(ctx);
  const job = getJob(ctx, jobId);
  if (!job) throw new Error("job not found");
  if (job.status === to) return job;
  if (!EDGES[job.status]?.includes(to)) {
    throw new Error(`illegal transition ${job.status} → ${to} for ${jobId}`);
  }
  const now = new Date().toISOString();
  db()
    .prepare("UPDATE forge_jobs SET status = ?, updated_at = ?, terminal_at = ? WHERE id = ? AND tenant_id = ?")
    .run(to, now, TERMINAL.includes(to) ? now : job.terminal_at, jobId, ctx.tenantId);
  addEvent(ctx, jobId, job.status, to, detail);
  return getJob(ctx, jobId)!;
}

/**
 * Move a job only if it is still where the caller thinks it is.
 *
 * `transition` reads, validates and writes in three steps, which is fine for one writer
 * and wrong for two: a job can be claimed twice and submitted to the provider twice, which
 * is money. This does the check and the write in a single conditional UPDATE, so exactly
 * one caller wins and the loser gets `false` instead of an exception.
 */
export function claim(ctx: Ctx, jobId: string, from: JobStatus, to: JobStatus, detail?: string): boolean {
  requireCtx(ctx);
  if (!EDGES[from]?.includes(to)) throw new Error(`illegal transition ${from} → ${to}`);
  const now = new Date().toISOString();
  // `terminal_at` is left alone unless this edge is the one that ends the job — writing
  // it unconditionally would erase the moment a job actually finished.
  const sql = TERMINAL.includes(to)
    ? "UPDATE forge_jobs SET status = ?, updated_at = ?, terminal_at = ? WHERE id = ? AND tenant_id = ? AND status = ?"
    : "UPDATE forge_jobs SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = ?";
  const res = TERMINAL.includes(to)
    ? db().prepare(sql).run(to, now, now, jobId, ctx.tenantId, from)
    : db().prepare(sql).run(to, now, jobId, ctx.tenantId, from);
  const won = Number(res.changes) === 1;
  if (won) addEvent(ctx, jobId, from, to, detail);
  return won;
}

export function patchJob(ctx: Ctx, jobId: string, patch: Partial<Job>): void {
  requireCtx(ctx);
  const allowed: (keyof Job)[] = [
    "provider_task_id",
    "provider_path",
    "reservation_id",
    "estimated_credits",
    "actual_credits",
    "error_code",
    "error_detail",
    "attempt",
    "not_before",
    "label",
  ];
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(patch[k] as string | number | null);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  vals.push(new Date().toISOString(), jobId, ctx.tenantId);
  db().prepare(`UPDATE forge_jobs SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`).run(...vals);
}

export interface JobEvent {
  id: number;
  job_id: string;
  from_state: string | null;
  to_state: string;
  detail: string | null;
  at: string;
}

export function addEvent(ctx: Ctx, jobId: string, from: string | null, to: string, detail?: string): void {
  requireCtx(ctx);
  db()
    .prepare("INSERT INTO forge_job_events (tenant_id, job_id, from_state, to_state, detail, at) VALUES (?,?,?,?,?,?)")
    .run(ctx.tenantId, jobId, from, to, detail ?? null, new Date().toISOString());
}

export function jobEvents(ctx: Ctx, jobId: string): JobEvent[] {
  requireCtx(ctx);
  return db()
    .prepare("SELECT id, job_id, from_state, to_state, detail, at FROM forge_job_events WHERE tenant_id = ? AND job_id = ? ORDER BY id")
    .all(ctx.tenantId, jobId) as unknown as JobEvent[];
}

export function recentEvents(ctx: Ctx, limit = 40): (JobEvent & { kind: string; model_id: string })[] {
  requireCtx(ctx);
  return db()
    .prepare(
      `SELECT e.id, e.job_id, e.from_state, e.to_state, e.detail, e.at, j.kind, j.model_id
         FROM forge_job_events e JOIN forge_jobs j ON j.id = e.job_id
        WHERE e.tenant_id = ? ORDER BY e.id DESC LIMIT ?`,
    )
    .all(ctx.tenantId, limit) as unknown as (JobEvent & { kind: string; model_id: string })[];
}

/* ---------------------------------------------------------------- assets -- */

export interface Asset {
  id: string;
  tenant_id: string;
  job_id: string;
  kind: string;
  mime: string;
  bytes: number;
  file_name: string;
  source_url: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
}

export function addAsset(
  ctx: Ctx,
  a: { jobId: string; kind: string; mime: string; bytes: number; fileName: string; sourceUrl?: string },
): Asset {
  requireCtx(ctx);
  const id = newId("ast_");
  db()
    .prepare(
      "INSERT INTO forge_assets (id, tenant_id, job_id, kind, mime, bytes, file_name, source_url, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(id, ctx.tenantId, a.jobId, a.kind, a.mime, a.bytes, a.fileName, a.sourceUrl ?? null, new Date().toISOString());
  return getAsset(ctx, id)!;
}

export function getAsset(ctx: Ctx, id: string): Asset | null {
  requireCtx(ctx);
  return (db().prepare("SELECT * FROM forge_assets WHERE id = ? AND tenant_id = ?").get(id, ctx.tenantId) as unknown as Asset) ?? null;
}

export function jobAssets(ctx: Ctx, jobId: string): Asset[] {
  requireCtx(ctx);
  return db().prepare("SELECT * FROM forge_assets WHERE tenant_id = ? AND job_id = ? ORDER BY created_at").all(ctx.tenantId, jobId) as unknown as Asset[];
}

export function listAssets(ctx: Ctx, opts: { kind?: string; limit?: number; offset?: number; query?: string } = {}): { rows: (Asset & { label: string | null; model_id: string })[]; total: number } {
  requireCtx(ctx);
  const where = ["a.tenant_id = ?"];
  const vals: (string | number)[] = [ctx.tenantId];
  if (opts.kind && opts.kind !== "all") {
    where.push("a.kind = ?");
    vals.push(opts.kind);
  }
  if (opts.query) {
    where.push("(j.label LIKE ? OR j.model_id LIKE ?)");
    vals.push(`%${opts.query}%`, `%${opts.query}%`);
  }
  const total = (
    db()
      .prepare(`SELECT COUNT(*) AS n FROM forge_assets a JOIN forge_jobs j ON j.id = a.job_id WHERE ${where.join(" AND ")}`)
      .get(...vals) as { n: number }
  ).n;
  const rows = db()
    .prepare(
      `SELECT a.*, j.label, j.model_id FROM forge_assets a JOIN forge_jobs j ON j.id = a.job_id
        WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...vals, opts.limit ?? 24, opts.offset ?? 0) as unknown as (Asset & { label: string | null; model_id: string })[];
  return { rows, total };
}

export function deleteAsset(ctx: Ctx, id: string): void {
  requireCtx(ctx);
  db().prepare("DELETE FROM forge_assets WHERE id = ? AND tenant_id = ?").run(id, ctx.tenantId);
}

/* ---------------------------------------------------- credits & ledger -- */

export interface Reservation {
  id: string;
  tenant_id: string;
  job_id: string;
  amount: number;
  status: string;
  created_at: string;
  expires_at: string;
  closed_at: string | null;
}

export function openReservation(ctx: Ctx, jobId: string, amount: number, ttlMs = 30 * 60_000): Reservation {
  requireCtx(ctx);
  const id = newId("res_");
  const now = Date.now();
  db()
    .prepare("INSERT INTO forge_credit_reservations (id, tenant_id, job_id, amount, status, created_at, expires_at) VALUES (?,?,?,?, 'open', ?, ?)")
    .run(id, ctx.tenantId, jobId, amount, new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
  return db().prepare("SELECT * FROM forge_credit_reservations WHERE id = ?").get(id) as unknown as Reservation;
}

export function openReservationTotal(ctx: Ctx): number {
  requireCtx(ctx);
  const row = db()
    .prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM forge_credit_reservations WHERE tenant_id = ? AND status = 'open'")
    .get(ctx.tenantId) as { n: number };
  return row.n;
}

export function expiredReservations(ctx: Ctx): Reservation[] {
  requireCtx(ctx);
  return db()
    .prepare("SELECT * FROM forge_credit_reservations WHERE tenant_id = ? AND status = 'open' AND expires_at < ?")
    .all(ctx.tenantId, new Date().toISOString()) as unknown as Reservation[];
}

export function releaseReservation(ctx: Ctx, id: string, status: "released" | "expired" | "consumed"): void {
  requireCtx(ctx);
  db()
    .prepare("UPDATE forge_credit_reservations SET status = ?, closed_at = ? WHERE id = ? AND tenant_id = ?")
    .run(status, new Date().toISOString(), id, ctx.tenantId);
}

/**
 * Charge, exactly once, in the same transaction that closes the reservation (spec §4).
 *
 * `UNIQUE(tenant_id, job_id, kind)` is what makes "exactly once" true even if the worker
 * is restarted mid-transition; an estimate is not a charge and never lands here.
 */
export function chargeOnce(ctx: Ctx, jobId: string, amount: number, reservationId: string | null): void {
  requireCtx(ctx);
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare("INSERT OR IGNORE INTO forge_credit_ledger (tenant_id, job_id, amount, kind, at) VALUES (?,?,?, 'spend', ?)").run(
      ctx.tenantId,
      jobId,
      amount,
      new Date().toISOString(),
    );
    if (reservationId) {
      d.prepare("UPDATE forge_credit_reservations SET status = 'consumed', closed_at = ? WHERE id = ? AND tenant_id = ?").run(
        new Date().toISOString(),
        reservationId,
        ctx.tenantId,
      );
    }
    d.prepare("UPDATE forge_jobs SET actual_credits = ? WHERE id = ? AND tenant_id = ?").run(amount, jobId, ctx.tenantId);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function ledgerSummary(ctx: Ctx, days = 30): { day: string; credits: number; jobs: number }[] {
  requireCtx(ctx);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return db()
    .prepare(
      `SELECT substr(at, 1, 10) AS day, SUM(amount) AS credits, COUNT(*) AS jobs
         FROM forge_credit_ledger WHERE tenant_id = ? AND at >= ? GROUP BY day ORDER BY day`,
    )
    .all(ctx.tenantId, since) as { day: string; credits: number; jobs: number }[];
}

export function ledgerByModel(ctx: Ctx, days = 30): { model_id: string; kind: string; uses: number; credits: number }[] {
  requireCtx(ctx);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return db()
    .prepare(
      `SELECT j.model_id, j.kind, COUNT(*) AS uses, SUM(l.amount) AS credits
         FROM forge_credit_ledger l JOIN forge_jobs j ON j.id = l.job_id
        WHERE l.tenant_id = ? AND l.at >= ? GROUP BY j.model_id, j.kind ORDER BY credits DESC`,
    )
    .all(ctx.tenantId, since) as { model_id: string; kind: string; uses: number; credits: number }[];
}

export function spentToday(ctx: Ctx): { credits: number; jobs: number } {
  requireCtx(ctx);
  const day = new Date().toISOString().slice(0, 10);
  const row = db()
    .prepare("SELECT COALESCE(SUM(amount),0) AS credits, COUNT(*) AS jobs FROM forge_credit_ledger WHERE tenant_id = ? AND substr(at,1,10) = ?")
    .get(ctx.tenantId, day) as { credits: number; jobs: number };
  return row;
}

/* -------------------------------------------------------------- balance -- */

export interface BalanceSnapshot {
  available: number;
  total_plan: number | null;
  spent: number | null;
  tier: string | null;
  source: string;
  at: string;
}

export function recordBalance(ctx: Ctx, b: Omit<BalanceSnapshot, "at">): void {
  requireCtx(ctx);
  db()
    .prepare("INSERT INTO forge_balance_snapshots (tenant_id, available, total_plan, spent, tier, source, at) VALUES (?,?,?,?,?,?,?)")
    .run(ctx.tenantId, b.available, b.total_plan ?? null, b.spent ?? null, b.tier ?? null, b.source, new Date().toISOString());
}

export function lastBalance(ctx: Ctx): BalanceSnapshot | null {
  requireCtx(ctx);
  return (
    (db()
      .prepare("SELECT available, total_plan, spent, tier, source, at FROM forge_balance_snapshots WHERE tenant_id = ? ORDER BY id DESC LIMIT 1")
      .get(ctx.tenantId) as unknown as BalanceSnapshot) ?? null
  );
}

/* ------------------------------------------------------------ approvals -- */

export interface Approval {
  job_id: string;
  tenant_id: string;
  token_hash: string;
  reason: string;
  expires_at: string;
  used_at: string | null;
  decision: string | null;
  created_at: string;
}

export function putApproval(ctx: Ctx, jobId: string, tokenHash: string, reason: string, ttlMs: number): void {
  requireCtx(ctx);
  const now = Date.now();
  db()
    .prepare(
      "INSERT OR REPLACE INTO forge_approvals (job_id, tenant_id, token_hash, reason, expires_at, used_at, decision, created_at) VALUES (?,?,?,?,?,NULL,NULL,?)",
    )
    .run(jobId, ctx.tenantId, tokenHash, reason, new Date(now + ttlMs).toISOString(), new Date(now).toISOString());
}

export function getApproval(jobId: string): Approval | null {
  // Deliberately not tenant-scoped: the approval link is opened by a human who is not
  // carrying a session. The token is the proof, and it is checked against this row.
  return (db().prepare("SELECT * FROM forge_approvals WHERE job_id = ?").get(jobId) as unknown as Approval) ?? null;
}

export function consumeApproval(jobId: string, decision: "approved" | "rejected"): void {
  db()
    .prepare("UPDATE forge_approvals SET used_at = ?, decision = ? WHERE job_id = ?")
    .run(new Date().toISOString(), decision, jobId);
}

/* ------------------------------------------------------------ rate limit -- */

export function noteRequest(ctx: Ctx, scope = "provider"): void {
  requireCtx(ctx);
  db().prepare("INSERT INTO forge_rate_events (tenant_id, at_ms, scope) VALUES (?,?,?)").run(ctx.tenantId, Date.now(), scope);
  // The window that matters is a couple of minutes; older rows are noise.
  db().prepare("DELETE FROM forge_rate_events WHERE at_ms < ?").run(Date.now() - 10 * 60_000);
}

export function requestsInWindow(ctx: Ctx, windowMs: number, allTenants = false): number {
  requireCtx(ctx);
  const since = Date.now() - windowMs;
  const row = allTenants
    ? (db().prepare("SELECT COUNT(*) AS n FROM forge_rate_events WHERE at_ms >= ?").get(since) as { n: number })
    : (db().prepare("SELECT COUNT(*) AS n FROM forge_rate_events WHERE tenant_id = ? AND at_ms >= ?").get(ctx.tenantId, since) as { n: number });
  return row.n;
}

/* -------------------------------------------------------------------- kv -- */

export function kvGet<T>(ctx: Ctx, key: string): T | null {
  requireCtx(ctx);
  const row = db().prepare("SELECT v FROM forge_kv WHERE tenant_id = ? AND k = ?").get(ctx.tenantId, key) as { v: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.v) as unknown as T;
  } catch {
    return null;
  }
}

export function kvSet(ctx: Ctx, key: string, value: unknown): void {
  requireCtx(ctx);
  db()
    .prepare("INSERT OR REPLACE INTO forge_kv (tenant_id, k, v, at) VALUES (?,?,?,?)")
    .run(ctx.tenantId, key, JSON.stringify(value), new Date().toISOString());
}
