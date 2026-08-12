import { NextResponse } from "next/server";
import { q, qn } from "@/lib/server/http";
import { deleteSession, listSessions } from "@/lib/server/cliSessions";

export const dynamic = "force-dynamic";

/**
 * Lets the console's "resume" picker browse and prune the conversation history other
 * coding CLIs keep for themselves on this machine.
 *
 * Deliberately not routed through `handle()` from `lib/server/http`: that helper boots the
 * Forge engine (database, worker, vault migration) for every request, which is the right
 * thing for X-Forge's own job/asset endpoints but pure overhead here — this route only
 * ever touches other CLIs' session files on disk and has no tenant or job context of its
 * own.
 */

export async function GET(req: Request): Promise<NextResponse> {
  const agent = q(req, "agent", "");
  if (!agent) return NextResponse.json({ sessions: [] }, { status: 400 });
  const sessions = listSessions(agent, qn(req, "limit", 40));
  return NextResponse.json({ sessions });
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const agent = q(req, "agent", "");
  const id = q(req, "id", "");
  if (!agent || !id) return NextResponse.json({ removed: false }, { status: 400 });
  const removed = deleteSession(agent, id);
  return NextResponse.json({ removed });
}
