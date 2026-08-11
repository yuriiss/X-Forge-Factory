import { beforeAll, describe, expect, it } from "vitest";
import { db, LOCAL_TENANT } from "@/lib/server/db";
import {
  addAsset,
  chargeOnce,
  createJob,
  getJob,
  getTenant,
  jobAssets,
  listJobs,
  openReservation,
  openReservationTotal,
  recordBalance,
  releaseReservation,
  requireCtx,
  transition,
  updateTenant,
  type Ctx,
} from "@/lib/server/repo";
import { budgetCheck, idemKeyFor, submitJob, readApproval, decideApproval } from "@/lib/server/engine";

/**
 * The engine's rules, tested where they are decided rather than through the network:
 * tenant isolation, the state machine, exactly-once charging, and the approval gate.
 */

const A: Ctx = { tenantId: LOCAL_TENANT };
const B: Ctx = { tenantId: "other" };

beforeAll(() => {
  db();
  // A second tenant, so isolation can be asserted rather than assumed.
  db()
    .prepare(
      `INSERT OR IGNORE INTO forge_tenants (id, display_name, status, credit_floor, approval_threshold,
        video_enabled, max_concurrent_jobs, rpm_limit, retention_days, created_at)
       VALUES ('other', 'Other', 'active', 0, 100, 1, 2, 30, 30, ?)`,
    )
    .run(new Date().toISOString());
});

describe("tenant isolation", () => {
  it("refuses a repository call with no tenant in context", () => {
    expect(() => requireCtx(undefined)).toThrow(/without a tenant/);
    expect(() => requireCtx({ tenantId: "" } as Ctx)).toThrow();
  });

  it("gives two tenants different jobs for an identical request (acceptance §9)", () => {
    const params = { prompt: "identical prompt", model: "mystic" };
    const idem = idemKeyFor("image.mystic", params);

    const a = createJob(A, { idemKey: idem, kind: "image.mystic", modelId: "mystic", params });
    const b = createJob(B, { idemKey: idem, kind: "image.mystic", modelId: "mystic", params });

    expect(a.reused).toBe(false);
    expect(b.reused).toBe(false);
    expect(a.job.id).not.toBe(b.job.id);
    // …and neither can see the other.
    expect(getJob(A, b.job.id)).toBeNull();
    expect(getJob(B, a.job.id)).toBeNull();
  });

  it("reuses a job for the same request within one tenant", () => {
    const params = { prompt: "repeat me" };
    const idem = idemKeyFor("image.mystic", params);
    const first = createJob(A, { idemKey: idem, kind: "image.mystic", modelId: "mystic", params });
    const second = createJob(A, { idemKey: idem, kind: "image.mystic", modelId: "mystic", params });
    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it("hashes parameters order-independently, so a reordered form is the same job", () => {
    expect(idemKeyFor("k", { a: 1, b: 2 })).toBe(idemKeyFor("k", { b: 2, a: 1 }));
    expect(idemKeyFor("k", { a: 1 })).not.toBe(idemKeyFor("k", { a: 2 }));
  });

  it("keeps assets inside their tenant", () => {
    const job = createJob(A, { idemKey: idemKeyFor("x", { n: Math.random() }), kind: "image.mystic", modelId: "m", params: {} }).job;
    const asset = addAsset(A, { jobId: job.id, kind: "image", mime: "image/png", bytes: 10, fileName: "x.png" });
    expect(jobAssets(A, job.id).map((a) => a.id)).toContain(asset.id);
    expect(jobAssets(B, job.id)).toHaveLength(0);
  });
});

describe("state machine", () => {
  const fresh = () => createJob(A, { idemKey: idemKeyFor("sm", { n: Math.random() }), kind: "image.mystic", modelId: "m", params: {} }).job;

  it("walks the legal path", () => {
    const job = fresh();
    for (const s of ["validating", "budget_check", "queued", "reserved", "submitted", "running", "downloading", "succeeded"] as const) {
      transition(A, job.id, s);
    }
    expect(getJob(A, job.id)!.status).toBe("succeeded");
  });

  it("refuses an illegal edge instead of performing it", () => {
    const job = fresh();
    expect(() => transition(A, job.id, "succeeded")).toThrow(/illegal transition/);
    transition(A, job.id, "validating");
    transition(A, job.id, "budget_check");
    transition(A, job.id, "queued");
    transition(A, job.id, "reserved");
    transition(A, job.id, "submitted");
    // The rule that matters: after submission there is no way back to the queue.
    expect(() => transition(A, job.id, "queued")).toThrow(/illegal transition/);
  });

  it("treats terminal states as terminal", () => {
    const job = fresh();
    transition(A, job.id, "cancelled");
    expect(() => transition(A, job.id, "queued")).toThrow();
  });
});

describe("credits", () => {
  it("charges exactly once even if the transition is replayed", () => {
    const job = createJob(A, { idemKey: idemKeyFor("charge", { n: Math.random() }), kind: "image.mystic", modelId: "m", params: {}, estimatedCredits: 40 }).job;
    const res = openReservation(A, job.id, 40);
    chargeOnce(A, job.id, 40, res.id);
    chargeOnce(A, job.id, 40, res.id);
    chargeOnce(A, job.id, 40, res.id);

    const rows = db().prepare("SELECT COUNT(*) AS n, SUM(amount) AS total FROM forge_credit_ledger WHERE job_id = ?").get(job.id) as {
      n: number;
      total: number;
    };
    expect(rows.n).toBe(1);
    expect(rows.total).toBe(40);
  });

  it("counts open reservations against the spendable balance", () => {
    const before = openReservationTotal(A);
    const job = createJob(A, { idemKey: idemKeyFor("res", { n: Math.random() }), kind: "image.mystic", modelId: "m", params: {} }).job;
    const res = openReservation(A, job.id, 250);
    expect(openReservationTotal(A)).toBe(before + 250);
    releaseReservation(A, res.id, "released");
    expect(openReservationTotal(A)).toBe(before);
  });

  it("keeps one tenant's reservations out of another's total", () => {
    const job = createJob(B, { idemKey: idemKeyFor("res-b", { n: Math.random() }), kind: "image.mystic", modelId: "m", params: {} }).job;
    const beforeA = openReservationTotal(A);
    openReservation(B, job.id, 900);
    expect(openReservationTotal(A)).toBe(beforeA);
    expect(openReservationTotal(B)).toBeGreaterThanOrEqual(900);
  });
});

describe("budget gate", () => {
  it("rejects rather than downgrades when the floor would be breached", () => {
    updateTenant(A, { credit_floor: 1000 });
    recordBalance(A, { available: 1100, total_plan: 2000, spent: 900, tier: "test", source: "test" });

    const job = createJob(A, {
      idemKey: idemKeyFor("floor", { n: Math.random() }),
      kind: "image.mystic",
      modelId: "m",
      params: {},
      estimatedCredits: 500,
    }).job;
    transition(A, job.id, "validating");

    const result = budgetCheck(A, job.id);
    expect(result.status).toBe("rejected_budget");
    expect(result.reason).toBe("insufficient_credits");
    // Nothing was quietly made cheaper to fit.
    expect(getJob(A, job.id)!.estimated_credits).toBe(500);

    updateTenant(A, { credit_floor: 0 });
  });

  it("refuses video when the tenant has it switched off", () => {
    updateTenant(A, { video_enabled: 0 });
    const job = createJob(A, {
      idemKey: idemKeyFor("vid", { n: Math.random() }),
      kind: "video.t2v",
      modelId: "wan",
      params: {},
      estimatedCredits: 10,
    }).job;
    transition(A, job.id, "validating");
    const result = budgetCheck(A, job.id);
    expect(result.status).toBe("rejected_budget");
    expect(result.reason).toBe("video_disabled");
    updateTenant(A, { video_enabled: 1 });
  });

  it("refuses everything while the tenant is in safe_mode, without touching other tenants", () => {
    updateTenant(A, { status: "safe_mode" });
    const job = createJob(A, { idemKey: idemKeyFor("safe", { n: Math.random() }), kind: "image.mystic", modelId: "m", params: {}, estimatedCredits: 1 }).job;
    transition(A, job.id, "validating");
    expect(budgetCheck(A, job.id).reason).toBe("tenant_not_active");

    const other = createJob(B, { idemKey: idemKeyFor("safe-b", { n: Math.random() }), kind: "image.mystic", modelId: "m", params: {}, estimatedCredits: 1 }).job;
    transition(B, other.id, "validating");
    expect(getTenant(B).status).toBe("active");

    updateTenant(A, { status: "active" });
  });
});

describe("approval gate", () => {
  it("blocks an expensive job, then runs it once a human approves", async () => {
    updateTenant(A, { approval_threshold: 1 });
    recordBalance(A, { available: 100_000, total_plan: 200_000, spent: 0, tier: "test", source: "test" });

    // No MCP session in the unit suite, so the estimate comes from the capability table —
    // which is exactly the fallback path worth testing here.
    const answer = await submitJob(A, { kind: "image.mystic", params: { prompt: `gate ${Math.random()}` } });
    expect(answer.status).toBe("blocked_approval");
    expect(answer.approveUrl).toMatch(/\/a\/job_/);

    const token = answer.approveUrl!.split("/").pop()!;
    expect(readApproval(answer.jobId, token)!.state).toBe("pending");
    expect(readApproval(answer.jobId, "wrong-token")).toBeNull();

    const decided = decideApproval(answer.jobId, token, "approved");
    expect(decided.ok).toBe(true);
    expect(getJob(A, answer.jobId)!.status).toBe("queued");

    // One-time link.
    expect(decideApproval(answer.jobId, token, "approved").ok).toBe(false);
    updateTenant(A, { approval_threshold: 400 });
  });

  it("cancels the job when a human rejects", async () => {
    updateTenant(A, { approval_threshold: 1 });
    const answer = await submitJob(A, { kind: "image.mystic", params: { prompt: `reject ${Math.random()}` } });
    const token = answer.approveUrl!.split("/").pop()!;
    expect(decideApproval(answer.jobId, token, "rejected").ok).toBe(true);
    expect(getJob(A, answer.jobId)!.status).toBe("cancelled");
    updateTenant(A, { approval_threshold: 400 });
  });

  it("lists jobs only for the tenant that asked", () => {
    const mine = listJobs(A, { limit: 500 });
    expect(mine.every((j) => j.tenant_id === LOCAL_TENANT)).toBe(true);
  });
});
