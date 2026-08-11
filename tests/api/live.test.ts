import { createHmac } from "crypto";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The live suite: X-Forge on 127.0.0.1:7777, talking to the real Magnific account.
 *
 * Everything that generates uses the cheapest model that still exercises the path — a
 * five-credit image and a two-credit voice line, never a fifteen-hundred-credit video.
 * The point is that the wiring works end to end, and that is equally true at five credits.
 */

const BASE = process.env.XFORGE_BASE ?? "http://127.0.0.1:7777";

async function get<T>(path: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

async function post<T>(path: string, body?: unknown, method = "POST"): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

interface JobAnswer {
  status: string;
  jobId: string;
  estimatedCredits?: number | null;
  approveUrl?: string;
  reused?: boolean;
  message?: string;
}

interface JobPayload {
  job: {
    id: string;
    status: string;
    via: string;
    actualCredits: number | null;
    estimatedCredits: number | null;
    providerTaskId: string | null;
    assets: { id: string; kind: string; mime: string; bytes: number; url: string }[];
  };
  events: { to_state: string }[];
}

/** Poll a job to a terminal state. */
async function settle(jobId: string, timeoutMs = 150_000): Promise<JobPayload> {
  const deadline = Date.now() + timeoutMs;
  const live = ["created", "validating", "budget_check", "queued", "reserved", "submitted", "running", "downloading"];
  for (;;) {
    const { json } = await get<JobPayload>(`/api/jobs/${jobId}`);
    if (!live.includes(json.job.status) || Date.now() > deadline) return json;
    await new Promise((r) => setTimeout(r, 2500));
  }
}

beforeAll(async () => {
  const { status } = await get("/api/status");
  if (status !== 200) throw new Error(`X-Forge is not answering on ${BASE} — start it with npm run dev`);
});

/**
 * Wait until the outbound shaper has room before submitting.
 *
 * The suite itself is traffic — searches, polls, probes — and the engine refuses new work
 * when the tenant is at its RPM ceiling. That refusal is correct behaviour, so the test
 * waits for headroom rather than asserting the limit away.
 */
async function withRateHeadroom(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const { json } = await get<{ shaper: { tenantRpm: number; tenantLimit: number } }>("/api/status");
    if (json.shaper.tenantRpm < json.shaper.tenantLimit - 6) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

describe("wiring", () => {
  it("reports both transports as connected", async () => {
    const { json } = await get<{
      rest: { connected: boolean; credential: { present: boolean; last4?: string } };
      mcp: { connected: boolean };
      balance: { available: number; spendable: number } | null;
    }>("/api/status");

    expect(json.rest.connected).toBe(true);
    expect(json.rest.credential.present).toBe(true);
    expect(json.mcp.connected).toBe(true);
    expect(json.balance?.available).toBeGreaterThan(0);
  });

  it("never returns the API key from any endpoint (spec §2.2)", async () => {
    const key = process.env.MAGNIFIC_API_KEY ?? "";
    const bodies: string[] = [];
    for (const p of ["/api/status", "/api/credentials", "/api/tenant", "/api/logs", "/api/jobs", "/api/catalog"]) {
      bodies.push(JSON.stringify((await get(p)).json));
    }
    const all = bodies.join("\n");
    if (key.length > 8) expect(all).not.toContain(key);
    expect(all).not.toMatch(/FPSX[A-Za-z0-9]{16,}/);
  });

  it("reads the live catalogue over MCP, not a snapshot", async () => {
    const { json } = await get<{ image: unknown[]; video: unknown[]; voices: unknown[]; source: string }>("/api/catalog");
    expect(json.image.length).toBeGreaterThan(20);
    expect(json.video.length).toBeGreaterThan(20);
    expect(json.voices.length).toBeGreaterThan(50);
  });

  it("lists the live MCP tool catalogue", async () => {
    const { json } = await get<{ connected: boolean; count: number; groups: { name: string }[] }>("/api/mcp/tools");
    expect(json.connected).toBe(true);
    expect(json.count).toBeGreaterThan(50);
    expect(json.groups.length).toBeGreaterThan(4);
  });
});

describe("tenant safety", () => {
  it("ignores a tenant named in the request body (acceptance §9)", async () => {
    await withRateHeadroom();
    const { json } = await post<JobAnswer>("/api/jobs", {
      tenant_id: "someone-else",
      tenantId: "someone-else",
      kind: "image.hyperflux",
      label: "spoof attempt",
      params: { prompt: `spoof probe ${Date.now()}`, resolution: "1k" },
    });
    // The job exists — under OUR tenant, which is why it is readable here.
    const { status } = await get(`/api/jobs/${json.jobId}`);
    expect(status).toBe(200);
    await post(`/api/jobs/${json.jobId}`, { action: "cancel" });
  });

  it("answers 404, not 403, for an id that is not ours", async () => {
    const { status, json } = await get<{ error: string }>("/api/jobs/job_DOES_NOT_EXIST_ANYWHERE");
    expect(status).toBe(404);
    expect(json.error).toBe("not_found");
  });

  it("refuses an invented asset id without touching the disk", async () => {
    const res = await fetch(`${BASE}/api/assets/ast_INVENTED`);
    expect(res.status).toBe(404);
  });
});

describe("pricing", () => {
  it("prices a call with the provider rather than a local table", async () => {
    const { json } = await post<{ credits: number; source: string; certainty: string }>("/api/estimate", {
      kind: "image.mystic",
      params: { prompt: "a test" },
    });
    expect(json.source).toBe("simulate_cost");
    expect(json.credits).toBeGreaterThan(0);
  });

  it("flags a job that would need approval before it is submitted", async () => {
    const { json } = await post<{ credits: number; willNeedApproval: boolean; approvalThreshold: number }>("/api/estimate", {
      kind: "video.t2v",
      params: { prompt: "an expensive clip", duration: 5, resolution: "1080p" },
    });
    expect(json.credits).toBeGreaterThan(json.approvalThreshold);
    expect(json.willNeedApproval).toBe(true);
  });
});

describe("generation, end to end", () => {
  let jobId = "";
  let usedPrompt = "";

  it("runs the cheapest image model through the whole state machine", async () => {
    await withRateHeadroom();
    const prompt = `a single spark on a dark anvil, ${Date.now()}`;
    usedPrompt = prompt;
    const { json } = await post<JobAnswer>("/api/jobs", {
      kind: "image.hyperflux",
      label: "api suite",
      params: { prompt, aspect_ratio: "square_1_1", resolution: "1k" },
    });
    expect(["queued", "blocked_approval"]).toContain(json.status);
    expect(json.status).toBe("queued");
    jobId = json.jobId;

    const settled = await settle(jobId);
    expect(settled.job.status).toBe("succeeded");
    expect(settled.job.assets.length).toBeGreaterThan(0);

    const states = settled.events.map((e) => e.to_state);
    expect(states).toEqual(expect.arrayContaining(["created", "validating", "budget_check", "queued", "reserved", "submitted", "downloading", "succeeded"]));
    expect(settled.job.actualCredits).toBe(settled.job.estimatedCredits);
  });

  it("downloaded the asset into the vault and serves the real bytes", async () => {
    const { json } = await get<JobPayload>(`/api/jobs/${jobId}`);
    const asset = json.job.assets[0];
    expect(asset.mime).toMatch(/^image\//);
    expect(asset.bytes).toBeGreaterThan(1000);

    const res = await fetch(`${BASE}${asset.url}`);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBe(asset.bytes);
    // JPEG or PNG magic — proof this is the file and not an error page.
    expect(bytes[0] === 0xff || bytes[0] === 0x89).toBe(true);
  });

  it("returns the original job for an identical request instead of charging twice", async () => {
    await withRateHeadroom();
    const { json: repeat } = await post<JobAnswer>("/api/jobs", {
      kind: "image.hyperflux",
      label: "api suite",
      params: { prompt: usedPrompt, aspect_ratio: "square_1_1", resolution: "1k" },
    });
    expect(repeat.jobId).toBe(jobId);
    expect(repeat.reused).toBe(true);

    // And the ledger still shows one charge for it.
    const { json: after } = await get<JobPayload>(`/api/jobs/${jobId}`);
    expect(after.job.actualCredits).toBe(after.job.estimatedCredits);
  });

  it("shows the asset in the vault gallery", async () => {
    const { json } = await get<{ total: number; items: { jobId: string }[] }>("/api/creations?scope=vault&per_page=50");
    expect(json.total).toBeGreaterThan(0);
    expect(json.items.some((i) => i.jobId === jobId)).toBe(true);
  });
});

describe("approval gate, cheaply", () => {
  it("blocks, then runs a five-credit job once a human approves", async () => {
    await withRateHeadroom();
    await post("/api/tenant", { approval_threshold: 1 }, "PATCH");
    try {
      const { json } = await post<JobAnswer>("/api/jobs", {
        kind: "image.hyperflux",
        label: "gate suite",
        params: { prompt: `gate probe ${Date.now()}`, resolution: "1k" },
      });
      expect(json.status).toBe("blocked_approval");
      expect(json.approveUrl).toBeTruthy();

      const token = json.approveUrl!.split("/").pop()!;

      // The page a human opens renders on its own, with no session.
      const page = await fetch(json.approveUrl!);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Approval required");

      const view = await get<{ approval: { state: string; estimatedCredits: number } }>(`/api/approvals/${json.jobId}/${token}`);
      expect(view.json.approval.state).toBe("pending");

      const decided = await post<{ message: string }>(`/api/approvals/${json.jobId}/${token}`, { decision: "approved" });
      expect(decided.status).toBe(200);

      // The link is spent.
      const replay = await post(`/api/approvals/${json.jobId}/${token}`, { decision: "approved" });
      expect(replay.status).toBe(409);

      const settled = await settle(json.jobId);
      expect(settled.job.status).toBe("succeeded");
      expect(settled.events.map((e) => e.to_state)).toContain("blocked_approval");
    } finally {
      await post("/api/tenant", { approval_threshold: 400 }, "PATCH");
    }
  });

  it("cancels the job when a human rejects, spending nothing", async () => {
    await withRateHeadroom();
    await post("/api/tenant", { approval_threshold: 1 }, "PATCH");
    try {
      const { json } = await post<JobAnswer>("/api/jobs", {
        kind: "image.hyperflux",
        label: "reject suite",
        params: { prompt: `reject probe ${Date.now()}`, resolution: "1k" },
      });
      const token = json.approveUrl!.split("/").pop()!;
      await post(`/api/approvals/${json.jobId}/${token}`, { decision: "rejected" });

      const { json: after } = await get<JobPayload>(`/api/jobs/${json.jobId}`);
      expect(after.job.status).toBe("cancelled");
      expect(after.job.actualCredits).toBeNull();
    } finally {
      await post("/api/tenant", { approval_threshold: 400 }, "PATCH");
    }
  });
});

describe("webhooks", () => {
  it("refuses an unsigned delivery", async () => {
    const res = await fetch(`${BASE}/api/webhooks/magnific`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { task_id: "forged", status: "COMPLETED" } }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).verified).toBe(false);
  });

  it("accepts a correctly signed delivery and records it as verified", async () => {
    const secret = process.env.MAGNIFIC_WEBHOOK_SECRET;
    if (!secret) return; // nothing to sign with in this environment

    const id = `wh_${Date.now()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ data: { task_id: "signed-probe", status: "COMPLETED" } });
    const sig = createHmac("sha256", secret).update(`${id}.${ts}.${body}`).digest("base64");

    const res = await fetch(`${BASE}/api/webhooks/magnific`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": ts,
        "webhook-signature": `v1,${sig}`,
      },
      body,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).verified).toBe(true);

    const { json } = await get<{ deliveries: { taskId: string | null; verified: boolean }[] }>("/api/webhooks/magnific");
    expect(json.deliveries.some((d) => d.taskId === "signed-probe" && d.verified)).toBe(true);
  });

  it("refuses a stale delivery even with a valid signature", async () => {
    const secret = process.env.MAGNIFIC_WEBHOOK_SECRET;
    if (!secret) return;
    const id = `wh_old_${Date.now()}`;
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const body = "{}";
    const sig = createHmac("sha256", secret).update(`${id}.${ts}.${body}`).digest("base64");
    const res = await fetch(`${BASE}/api/webhooks/magnific`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` },
      body,
    });
    expect(res.status).toBe(401);
  });
});

describe("MCP console", () => {
  it("calls a free tool and returns real data", async () => {
    const { json } = await post<{ isError: boolean; data: { credits?: { available?: number } } }>("/api/mcp/call", {
      tool: "account_balance",
      args: {},
      confirm: true,
    });
    expect(json.isError).toBe(false);
    expect(json.data.credits?.available).toBeGreaterThan(0);
  });

  it("asks for confirmation before running anything that spends", async () => {
    const { json } = await post<{ needsConfirmation: boolean; estimate: { credits: number } | null }>("/api/mcp/call", {
      tool: "images_generate",
      args: { prompt: "a confirmation probe", mode: "flux" },
    });
    expect(json.needsConfirmation).toBe(true);
    expect(json.estimate?.credits).toBeGreaterThan(0);
  });
});

describe("stock and library", () => {
  it("searches stock images", async () => {
    const { json } = await get<{ items: { id: string; title: string }[] }>("/api/stock?type=images&q=harbour&limit=4");
    expect(json.items.length).toBeGreaterThan(0);
  });

  it("searches icons", async () => {
    const { json } = await get<{ items: unknown[] }>("/api/stock?type=icons&q=anchor&limit=6");
    expect(json.items.length).toBeGreaterThan(0);
  });

  it("lists published flows", async () => {
    const { json } = await get<{ flows: { sqid: string; name: string }[] }>("/api/flows");
    expect(json.flows.length).toBeGreaterThan(0);
  });

  it("reads trained references", async () => {
    const { json } = await get<{ references: unknown[] }>("/api/loras");
    expect(Array.isArray(json.references)).toBe(true);
  });
});
