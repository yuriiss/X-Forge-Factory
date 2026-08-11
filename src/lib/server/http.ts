import { NextResponse } from "next/server";
import { localCtx, type Ctx } from "./repo";
import { db } from "./db";
import { startWorker } from "./engine";
import { logger, redact } from "./logger";
import { MagnificError } from "./magnific";

/**
 * Route plumbing.
 *
 * Two things every handler needs and none should repeat: a tenant context that comes from
 * the server and never from the request (spec §2.3 — `tenant_id` in a body, a header or a
 * query string is ignored, and there is a test that tries all three), and an error shape
 * that says what went wrong without ever quoting a secret back.
 */

/** Process-wide, so a hot reload adopts the running engine instead of booting a second. */
const BOOTED = Symbol.for("x-forge.booted");

/** First request wins: open the database, seal the env key, start the worker. */
export function boot(): Ctx {
  const ctx = localCtx();
  const g = globalThis as Record<symbol, unknown>;
  if (!g[BOOTED]) {
    db();
    g[BOOTED] = true;
  }
  // Started unconditionally: `startWorker` hands over rather than duplicating, which is
  // what makes a hot-reloaded engine actually take effect.
  startWorker(ctx);
  return ctx;
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as object, init);
}

export function fail(message: string, status = 400, code = "error"): NextResponse {
  return NextResponse.json({ error: code, message: redact(message) }, { status });
}

/**
 * Run a handler with the engine booted and failures turned into answers.
 *
 * A provider error keeps its own status so the console can distinguish "your key is
 * wrong" (401) from "slow down" (429); anything else is a 500 with a redacted message.
 */
export async function handle<T>(fn: (ctx: Ctx) => Promise<T>): Promise<NextResponse> {
  const ctx = boot();
  try {
    const data = await fn(ctx);
    if (data instanceof NextResponse) return data;
    return ok(data);
  } catch (e) {
    const err = e as Error;
    if (err instanceof MagnificError) {
      logger.warn("api", `${err.code}: ${err.message}`);
      return fail(err.message, err.status === 429 ? 429 : err.status >= 400 && err.status < 600 ? err.status : 502, err.code);
    }
    logger.error("api", err.stack ?? err.message);
    return fail(err.message || "internal error", 500, "internal");
  }
}

/**
 * Read a JSON body and strip anything that tries to name a tenant.
 *
 * This is the enforcement point for the acceptance test that submits `tenant_id` in the
 * body: the field never reaches the repository layer because it does not survive parsing.
 */
export async function body<T extends Record<string, unknown>>(req: Request): Promise<T> {
  let raw: Record<string, unknown>;
  try {
    raw = (await req.json()) as Record<string, unknown>;
  } catch {
    return {} as T;
  }
  const { tenant_id, tenantId, tenant, ...rest } = raw;
  if (tenant_id ?? tenantId ?? tenant) logger.warn("api", "request tried to set a tenant; ignored");
  return rest as T;
}

export function q(req: Request, key: string, fallback = ""): string {
  return new URL(req.url).searchParams.get(key) ?? fallback;
}

export function qn(req: Request, key: string, fallback: number): number {
  const v = Number(new URL(req.url).searchParams.get(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
