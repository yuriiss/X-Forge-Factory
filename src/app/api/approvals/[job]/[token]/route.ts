import { body, boot, fail, ok } from "@/lib/server/http";
import { decideApproval, readApproval } from "@/lib/server/engine";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ job: string; token: string }> }) {
  boot();
  const { job, token } = await params;
  const view = readApproval(job, token);
  if (!view) return fail("unknown or invalid approval link", 404, "not_found");
  return ok({ approval: view });
}

/**
 * The decision.
 *
 * There is no MCP tool and no agent-facing endpoint that reaches this — an agent must not
 * be able to imitate a human saying yes (spec §6). The token is single-use: `decideApproval`
 * consumes it before acting, so a replayed POST finds a spent link.
 */
export async function POST(req: Request, { params }: { params: Promise<{ job: string; token: string }> }) {
  boot();
  const { job, token } = await params;
  const { decision } = await body<{ decision?: string }>(req);
  if (decision !== "approved" && decision !== "rejected") return fail("decision must be approved or rejected", 400, "bad_decision");

  const result = decideApproval(job, token, decision);
  if (!result.ok) return fail(result.message, 409, "not_actionable");
  return ok({ ...result, approval: readApproval(job, token) });
}
