import { createHmac, timingSafeEqual } from "crypto";
import { boot } from "@/lib/server/http";
import { kvGet, kvSet } from "@/lib/server/repo";
import { logger } from "@/lib/server/logger";

export const dynamic = "force-dynamic";

/**
 * The webhook receiver.
 *
 * Signature verification is the whole point of this endpoint: anyone can POST to it, so
 * an unverified delivery is a stranger's claim that a task finished. The scheme is
 * `base64(HMAC-SHA256(secret, "id.timestamp.body"))`, the header may carry several
 * space-separated versions, and matching ANY of them is a pass — that is how a secret
 * rotation stays deliverable.
 *
 * Comparison is constant-time, and a delivery older than the freshness window is refused
 * even with a valid signature, because a replayed valid delivery is still a replay.
 */
const FRESHNESS_MS = 5 * 60_000;

interface Delivery {
  at: string;
  taskId: string | null;
  status: string | null;
  verified: boolean;
  note: string;
}

export async function POST(req: Request) {
  const ctx = boot();
  const raw = await req.text();

  const id = req.headers.get("webhook-id") ?? "";
  const ts = req.headers.get("webhook-timestamp") ?? "";
  const sigHeader = req.headers.get("webhook-signature") ?? "";
  const secret = (process.env.MAGNIFIC_WEBHOOK_SECRET || "").trim();

  let verified = false;
  let note = "";

  if (!secret) {
    note = "no MAGNIFIC_WEBHOOK_SECRET configured — delivery recorded but not trusted";
  } else if (!id || !ts || !sigHeader) {
    note = "missing webhook-id / webhook-timestamp / webhook-signature";
  } else if (Math.abs(Date.now() - Number(ts) * (String(ts).length <= 10 ? 1000 : 1)) > FRESHNESS_MS) {
    note = "delivery is outside the freshness window";
  } else {
    const expected = createHmac("sha256", secret).update(`${id}.${ts}.${raw}`).digest("base64");
    verified = sigHeader
      .split(" ")
      .map((part) => part.split(",")[1] ?? "")
      .some((candidate) => safeEqual(candidate, expected));
    note = verified ? "signature verified" : "signature did not match";
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* a body that is not JSON is still worth recording */
  }
  const data = (payload.data ?? payload) as Record<string, unknown>;

  const delivery: Delivery = {
    at: new Date().toISOString(),
    taskId: (data.task_id as string) ?? null,
    status: (data.status as string) ?? null,
    verified,
    note,
  };
  const list = [delivery, ...(kvGet<Delivery[]>(ctx, "webhook_deliveries") ?? [])].slice(0, 40);
  kvSet(ctx, "webhook_deliveries", list);
  logger.info("webhook", `${delivery.taskId ?? "?"} ${delivery.status ?? "?"} — ${note}`);

  // An unverified delivery is answered 401 so the sender stops rather than retrying into
  // a receiver that will never trust it.
  return new Response(JSON.stringify({ received: true, verified }), {
    status: verified || !secret ? 200 : 401,
    headers: { "Content-Type": "application/json" },
  });
}

/** Recent deliveries, for the Developers view. */
export async function GET() {
  const ctx = boot();
  return new Response(
    JSON.stringify({
      configured: !!(process.env.MAGNIFIC_WEBHOOK_SECRET || "").trim(),
      endpoint: `${process.env.FORGE_PUBLIC_URL ?? "http://127.0.0.1:7777"}/api/webhooks/magnific`,
      deliveries: kvGet<Delivery[]>(ctx, "webhook_deliveries") ?? [],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
