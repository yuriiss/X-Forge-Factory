import { agentStatuses } from "@/lib/server/agents";
import { providers } from "@/lib/server/providers";

export const dynamic = "force-dynamic";

/**
 * What this machine can talk to.
 *
 * Deliberately not cached beyond the binary lookup's own thirty seconds: an operator who
 * has just installed a CLI in another terminal expects the console to notice, and the whole
 * point of detecting rather than configuring is that the answer follows the machine.
 *
 * The path a binary was found at goes back to the browser. That is not a secret — it is
 * `which`, which any process running as this user can ask — and it is the fastest way for
 * an operator to see that the console found a different Claude than their shell does.
 */
export async function GET() {
  const cli = agentStatuses().map((a) => ({
    id: a.id,
    label: a.label,
    kind: a.kind,
    glyph: a.glyph,
    colour: a.colour,
    models: a.models ?? [],
    supports: a.supports,
    skillsDir: a.skillsDir ?? null,
    available: a.available,
    where: a.where,
  }));

  const remote = providers().map((p) => ({
    id: p.id,
    label: p.label,
    base: p.base,
    builtin: p.builtin,
    configured: p.configured,
  }));

  return Response.json({ cli, providers: remote });
}
