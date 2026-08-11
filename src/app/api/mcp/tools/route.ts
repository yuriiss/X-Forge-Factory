import { handle } from "@/lib/server/http";
import { isConnected, listTools } from "@/lib/server/mcp";

export const dynamic = "force-dynamic";

/**
 * The live tool catalogue.
 *
 * `tools/list` is the source of truth — the mock listed 39 tools from a screenshot, and
 * the server currently answers with far more. Grouping is derived from the tool names so
 * a tool added next week lands in the right section without a code change.
 */
export async function GET() {
  return handle(async () => {
    if (!isConnected()) return { connected: false, tools: [], groups: [] };
    const tools = await listTools();

    const groups = new Map<string, { name: string; description: string; free: boolean }[]>();
    for (const t of tools) {
      const group = groupFor(t.name);
      const list = groups.get(group) ?? [];
      list.push({
        name: t.name,
        description: (t.description ?? "").split("\n")[0].slice(0, 180),
        free: isFree(t.name),
      });
      groups.set(group, list);
    }

    return {
      connected: true,
      count: tools.length,
      groups: [...groups.entries()].map(([name, items]) => ({ name, items })),
      tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", schema: t.inputSchema ?? null })),
    };
  });
}

function groupFor(name: string): string {
  if (name.startsWith("account") || name.startsWith("project")) return "ACCOUNT";
  if (name.startsWith("creations") || name.startsWith("creation_")) return "CREATIONS";
  if (name.startsWith("images")) return "IMAGE GENERATION & EDITING";
  if (name.startsWith("video")) return "VIDEO";
  if (name.startsWith("audio")) return "AUDIO";
  if (name.startsWith("models3d")) return "3D";
  if (name.startsWith("library")) return "LIBRARY · SOUL REFERENCES";
  if (name.startsWith("folders") || name.startsWith("projects")) return "FOLDERS";
  if (name.startsWith("spaces") || name.startsWith("flows")) return "SPACES & FLOWS";
  if (name.startsWith("stock")) return "STOCK";
  if (name.startsWith("simulate")) return "COST SIMULATION";
  if (name.startsWith("design")) return "DESIGN";
  return "OTHER";
}

/** Read-only tools cost nothing; the badge in the UI comes from this and not from a guess. */
function isFree(name: string): boolean {
  return (
    /_(list|show|get|search|status|wait|models_list|voices_list|state|report|profile|balance)$/.test(name) ||
    name.startsWith("simulate") ||
    name.startsWith("folders_") ||
    name.startsWith("creations_") ||
    name === "video_plan"
  );
}
