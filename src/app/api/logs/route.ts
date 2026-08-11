import { handle, qn } from "@/lib/server/http";
import { recentLogs } from "@/lib/server/logger";
import { recentEvents } from "@/lib/server/repo";

export const dynamic = "force-dynamic";

/**
 * What the server has been doing.
 *
 * Two streams: the process log (already redacted at the logger, not here) and the job
 * event log from the database, which is the durable one — the ring buffer dies with the
 * process, and a state transition should not.
 */
export async function GET(req: Request) {
  return handle(async (ctx) => ({
    logs: recentLogs(qn(req, "limit", 60)),
    events: recentEvents(ctx, qn(req, "events", 30)),
  }));
}
