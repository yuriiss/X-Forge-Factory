import { body, handle } from "@/lib/server/http";
import { callTool, dataOf, extractIdentifiers, extractUrls, isConnected, simulateCost, textOf } from "@/lib/server/mcp";
import { logger } from "@/lib/server/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Call an MCP tool by hand.
 *
 * This is the console's answer to the mock's "assistant demo": rather than a scripted chat
 * bubble, the operator picks a real tool from `tools/list`, fills in real arguments and
 * sees the real result. Credit-spending tools are priced with `simulate_cost` first and
 * refused unless the caller confirmed the spend — the console will not let a stray click
 * cost money.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const { tool, args, confirm } = await body<{ tool?: string; args?: Record<string, unknown>; confirm?: boolean }>(req);
    if (!tool) throw new Error("tool is required");
    if (!isConnected()) throw new Error("MCP is not connected");

    const priceable = SPENDING.has(tool);
    if (priceable && !confirm) {
      const est = await simulateCost(tool, args ?? {});
      return {
        needsConfirmation: true,
        tool,
        estimate: est,
        message: est ? `${tool} would cost about ${est.credits} credits` : `${tool} spends credits and could not be priced`,
      };
    }

    const started = Date.now();
    const result = await callTool(tool, args ?? {}, { timeoutMs: 280_000 });
    logger.info("mcp-console", `${tool} in ${Date.now() - started}ms`);

    return {
      tool,
      isError: !!result.isError,
      ms: Date.now() - started,
      text: textOf(result),
      data: dataOf(result),
      urls: extractUrls(result),
      identifiers: extractIdentifiers(result),
    };
  });
}

/**
 * Tools that spend credits.
 *
 * Taken from the same enum `simulate_cost` accepts, which is the provider's own answer to
 * "what costs money" — not a list maintained by guesswork here.
 */
const SPENDING = new Set([
  "images_generate",
  "images_generate_svg",
  "images_to_svg",
  "images_remove_background",
  "images_upscale",
  "images_crop",
  "images_resize",
  "images_variations",
  "images_relight",
  "images_change_camera",
  "images_skin_enhancer",
  "images_retouch",
  "images_expand",
  "video_generate",
  "video_upscale",
  "video_speak",
  "video_dubbing",
  "audio_tts",
  "audio_music_generate",
  "models3d_generate",
]);
