import { body, handle } from "@/lib/server/http";
import { flowRun, getFlow, runFlow } from "@/lib/server/magnific";
import { kvGet, kvSet } from "@/lib/server/repo";

export const dynamic = "force-dynamic";

interface FlowInput {
  api_key?: string;
  id?: string;
  name?: string;
  type?: string;
  [k: string]: unknown;
}

/**
 * A flow's definition, including the inputs it actually accepts.
 *
 * The run form is built from this rather than from a fixed set of fields: inputs are keyed
 * by `api_key` (human-friendly) with the UUID accepted for compatibility, and every flow
 * has a different set. A hardcoded three-field form would be wrong for most of them.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ sqid: string }> }) {
  const { sqid } = await params;
  return handle(async (ctx) => {
    const flow = (await getFlow(ctx, sqid)) as Record<string, unknown>;
    const inputs = (flow.inputs ?? flow.dynamic_inputs ?? []) as FlowInput[];
    const cost = (flow.tool_metadata as { total_cost?: number } | undefined)?.total_cost ?? null;
    return { sqid, flow, inputs, cost };
  });
}

/** Start a run, or read one back. Runs are remembered locally so the list survives a reload. */
export async function POST(req: Request, { params }: { params: Promise<{ sqid: string }> }) {
  const { sqid } = await params;
  const input = await body<{ action?: string; inputs?: Record<string, unknown>; webhook?: string; runId?: string }>(req);

  return handle(async (ctx) => {
    if (input.action === "status") {
      if (!input.runId) throw new Error("runId is required");
      const run = await flowRun(ctx, sqid, input.runId);
      rememberRun(ctx, sqid, input.runId, run);
      return { run };
    }

    const run = (await runFlow(ctx, sqid, input.inputs ?? {}, input.webhook)) as Record<string, unknown>;
    const runId = String(run.id ?? run.run_id ?? run.sqid ?? "");
    if (runId) rememberRun(ctx, sqid, runId, run);
    return { run, runId };
  });
}

interface RememberedRun {
  sqid: string;
  runId: string;
  status: string;
  at: string;
}

function rememberRun(ctx: { tenantId: string }, sqid: string, runId: string, run: unknown): void {
  const status = String((run as { status?: string })?.status ?? "pending");
  const list = (kvGet<RememberedRun[]>(ctx, "flow_runs") ?? []).filter((r) => r.runId !== runId);
  list.unshift({ sqid, runId, status, at: new Date().toISOString() });
  kvSet(ctx, "flow_runs", list.slice(0, 30));
}
