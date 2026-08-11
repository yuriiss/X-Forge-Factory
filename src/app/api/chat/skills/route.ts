import { installFromDir, installFromRegistry, readSkillBody, scanInstalled, searchRegistry, uninstall } from "@/lib/server/skills";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Skills: what is installed, what the registry offers, and the gate between the two.
 *
 * Every write path here ends in the same scanner. An operator can override a REVIEW with a
 * reason, which is recorded; nobody can override a REJECT, including by asking twice, which
 * is why the check is repeated on the server rather than trusted from the button that was
 * pressed.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agent") ?? "claude";
  const query = url.searchParams.get("q");
  const preview = url.searchParams.get("preview");

  if (preview) {
    const body = readSkillBody(agentId, preview);
    return body ? Response.json({ name: preview, body }) : Response.json({ error: "no such skill" }, { status: 404 });
  }
  if (query !== null) {
    try {
      return Response.json({ results: await searchRegistry(query) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 502 });
    }
  }
  return Response.json({ skills: scanInstalled(agentId) });
}

interface InstallBody {
  agentId?: string;
  source?: string;
  skillId?: string;
  /** A single SKILL.md pasted or uploaded, for a skill that is only instructions. */
  markdown?: string;
  name?: string;
  force?: boolean;
  reason?: string;
}

export async function POST(req: Request) {
  const body = (await req.json()) as InstallBody;
  const agentId = body.agentId ?? "claude";

  try {
    if (body.markdown) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "x-forge-upload-"));
      try {
        const name = (body.name ?? "uploaded-skill").replace(/[^\w.-]/g, "-").slice(0, 60);
        const skill = path.join(dir, name);
        mkdirSync(skill, { recursive: true });
        writeFileSync(path.join(skill, "SKILL.md"), body.markdown.slice(0, 512_000), "utf8");
        return Response.json(installFromDir(agentId, skill, !!body.force, body.reason ?? ""));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    if (!body.source || !body.skillId) return Response.json({ error: "source and skillId required" }, { status: 400 });
    const result = await installFromRegistry(agentId, body.source, body.skillId, !!body.force, body.reason ?? "");
    return Response.json(result, { status: result.ok ? 200 : result.outcome === "REJECT" ? 403 : 409 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agent") ?? "claude";
  const name = url.searchParams.get("name");
  if (!name) return Response.json({ error: "name required" }, { status: 400 });

  try {
    return Response.json({ removed: uninstall(agentId, name) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
