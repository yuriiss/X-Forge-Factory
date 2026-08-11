import { agent, buildArgs, isSkillName, resolveBin, type TurnOptions } from "@/lib/server/agents";
import { providerChat, type ChatMessage } from "@/lib/server/providers";
import { readSkillBody } from "@/lib/server/skills";
import { sseSpawn } from "@/lib/server/sse";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

interface Body extends TurnOptions {
  agentId: string;
  /** Set when the turn goes to a provider rather than a CLI: `openrouter` + a model id. */
  providerId?: string;
  history?: ChatMessage[];
}

/**
 * One turn, streamed.
 *
 * Both paths answer with the same event framing so the client has one reader loop, but they
 * are genuinely different underneath: a CLI is a process on this machine holding its own
 * credentials and its own transcript, a provider is an HTTP call this server pays for with
 * a key from `.env.local`. The console says which one a model is before you send anything,
 * because the difference decides where the conversation lives afterwards.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!body.prompt?.trim()) return Response.json({ error: "prompt required" }, { status: 400 });

  if (body.providerId) return providerTurn(body, req.signal);

  const def = agent(body.agentId);
  if (!def) return Response.json({ error: `unknown model: ${body.agentId}` }, { status: 400 });

  const bin = resolveBin(def.bin);
  if (!bin) {
    return Response.json(
      { error: `${def.label} is not installed — '${def.bin}' is not on this machine's PATH` },
      { status: 409 },
    );
  }

  return sseSpawn(bin, buildArgs(def, body), { cwd: body.cwd });
}

const encoder = new TextEncoder();

/**
 * A provider has no filesystem and discovers nothing, so a selected skill has to arrive as
 * text. The body is read here and folded into a system message — the same instructions the
 * CLI would have found by itself.
 */
function providerTurn(body: Body, signal: AbortSignal): Response {
  const messages: ChatMessage[] = [];
  const skills = (body.skills ?? []).filter(isSkillName).slice(0, 8);

  if (skills.length) {
    const blocks = skills.map((name) => {
      const text = readSkillBody(body.agentId, name);
      return text ? `### Skill: ${name}\n${text.slice(0, 6000)}` : `### Skill: ${name}\nApply the "${name}" skill's practices.`;
    });
    messages.push({ role: "system", content: `Apply these skills where they are relevant.\n\n${blocks.join("\n\n")}` });
  }

  messages.push(...(body.history ?? []).slice(-20));
  messages.push({ role: "user", content: body.prompt });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        for await (const delta of providerChat(body.providerId ?? "", body.model ?? "", messages, signal)) {
          send({ type: "delta", text: delta });
        }
        send({ type: "proc_exit", code: 0 });
      } catch (e) {
        send({ type: "proc_error", message: (e as Error).message, code: "PROVIDER" });
      } finally {
        try {
          controller.close();
        } catch {
          /* the reader left first */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
