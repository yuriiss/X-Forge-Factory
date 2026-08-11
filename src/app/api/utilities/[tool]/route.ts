import { body, handle } from "@/lib/server/http";
import { rest, submitTask } from "@/lib/server/magnific";
import { callTool, dataOf, isConnected } from "@/lib/server/mcp";
import type { Ctx } from "@/lib/server/repo";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The small intelligence endpoints, which answer in text rather than in files.
 *
 * They are still asynchronous tasks, but they finish in seconds and nothing about their
 * result belongs in the vault, so they are run inline and awaited instead of going through
 * the job engine — a ledger entry per prompt-improvement would be noise, and these are
 * rate-limited by request count rather than priced in credits.
 */
export async function POST(req: Request, { params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  const input = await body<Record<string, unknown>>(req);

  return handle(async (ctx) => {
    switch (tool) {
      case "image-to-prompt": {
        const task = await submitTask(ctx, "/v1/ai/image-to-prompt", { image: input.image });
        const text = await waitForText(ctx, "/v1/ai/image-to-prompt", task.taskId);
        return { tool, result: text };
      }
      case "improve-prompt": {
        // `type` is required and the error message is the only place that says so —
        // the published reference lists only `prompt`, and a body without `type` is
        // rejected as a validation error rather than defaulting to anything.
        const task = await submitTask(ctx, "/v1/ai/improve-prompt", { prompt: input.prompt, type: input.type ?? "image" });
        const text = await waitForText(ctx, "/v1/ai/improve-prompt", task.taskId);
        return { tool, result: text };
      }
      case "classify": {
        // The classifier lives behind a different shape from the rest of `/v1/ai/*`; both
        // known paths are tried, and the one that answers is reported with its path so a
        // future move is visible instead of silently becoming "unavailable".
        for (const path of ["/v1/ai/image-classifier", "/v1/ai/classifier/image", "/v1/ai/ai-image-classifier"]) {
          try {
            const r = await rest<Record<string, unknown>>(ctx, path, { body: { image: input.image } });
            return { tool, path, result: r };
          } catch {
            continue;
          }
        }
        throw new Error("no classifier endpoint answered for this key");
      }
      case "video-plan": {
        if (!isConnected()) throw new Error("video planning is an MCP tool — connect the session first");
        const r = await callTool(
          "video_plan",
          {
            prompt: String(input.prompt ?? ""),
            durationHint: input.duration ? Number(input.duration) : undefined,
            styleHint: input.style ? String(input.style) : undefined,
            aspectRatioHint: input.aspectRatio ? String(input.aspectRatio) : undefined,
          },
          { timeoutMs: 120_000 },
        );
        return { tool, result: dataOf(r) };
      }
      default:
        throw new Error(`unknown utility ${tool}`);
    }
  });
}

/**
 * These endpoints answer with text in `generated[]` rather than a file URL, so the poller
 * here reads the raw payload instead of going through the download path.
 */
async function waitForText(ctx: Ctx, path: string, taskId: string): Promise<string> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2_500));
    if (Date.now() > deadline) throw new Error(`${path}: task ${taskId} did not finish in time`);
    const raw = (await rest<{ data?: { status?: string; generated?: unknown[]; error?: string } }>(ctx, `${path}/${taskId}`)).data;
    const status = (raw?.status ?? "").toUpperCase();
    if (status === "COMPLETED") {
      const first = raw?.generated?.[0];
      if (typeof first === "string") return first;
      if (first && typeof first === "object") {
        const o = first as Record<string, unknown>;
        return String(o.prompt ?? o.text ?? o.result ?? JSON.stringify(o));
      }
      return JSON.stringify(raw?.generated ?? []);
    }
    if (status === "FAILED" || status === "ERROR") throw new Error(raw?.error || `${path}: task failed`);
  }
}
