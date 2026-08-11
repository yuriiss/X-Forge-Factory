import { readFileSync, writeFileSync } from "fs";
import { stateFile } from "./paths";
import { callTool, isConnected, parseOutline, textOf } from "./mcp";
import { logger } from "./logger";

/**
 * Magnific's own catalogue, read from the server that owns it.
 *
 * The REST key reaches five image models and a couple of video paths, because those are
 * the endpoints it has. That is not the catalogue: `images_models_list` answers with
 * dozens of image models, `video_models_list` with dozens more, and `audio_voices_list`
 * with hundreds of voices. A picker built from the five is not a smaller version of the
 * product, it is a wrong one — and an operator who uses Magnific notices immediately.
 *
 * Cached on disk because it changes on Magnific's release schedule, not on ours.
 */

export interface XfModel {
  slug: string;
  name: string;
  family?: string;
  beta?: boolean;
  premium?: boolean;
  seconds?: number;
  aspectRatios?: string[];
  resolutions?: string[];
  durations?: string[];
  /** True when this model also has a dedicated REST path in X-Forge's table. */
  rest?: boolean;
}

export interface XfVoice {
  id: string;
  name: string;
  provider?: string;
  gender?: string;
  age?: string;
  languages?: string[];
}

export interface XfCatalog {
  at: number;
  image: XfModel[];
  video: XfModel[];
  voices: XfVoice[];
  upscaleModes: { id: string; name: string }[];
  upscalePresets: { id: string; name: string }[];
  source: "mcp" | "cache" | "fallback";
}

const FILE = () => stateFile("catalog.json");
const TTL_MS = 12 * 60 * 60_000;

/** What the console can still offer with no MCP session: the REST paths, and only those. */
const FALLBACK: XfCatalog = {
  at: 0,
  image: [
    { slug: "mystic", name: "Mystic", family: "Magnific", rest: true },
    { slug: "flux-dev", name: "FLUX.1 dev", family: "Black Forest Labs", rest: true },
    { slug: "hyperflux", name: "HyperFlux", family: "Black Forest Labs", rest: true },
    { slug: "flux-2-pro", name: "FLUX 2 Pro", family: "Black Forest Labs", rest: true },
    { slug: "seedream-v4-5", name: "Seedream 4.5", family: "ByteDance", rest: true },
  ],
  video: [
    { slug: "wan-2-5-t2v-1080p", name: "WAN 2.5 · text → video 1080p", family: "WAN", rest: true },
    { slug: "kling-v2-6-pro", name: "Kling 2.6 Pro · image → video", family: "Kling", rest: true },
  ],
  voices: [],
  upscaleModes: [
    { id: "creative", name: "Creative" },
    { id: "ultra-photo", name: "Precision · photo" },
    { id: "ultra-sublime", name: "Precision · sublime" },
    { id: "ultra-denoiser", name: "Precision · denoiser" },
  ],
  upscalePresets: [],
  source: "fallback",
};

function readCache(): XfCatalog | null {
  try {
    return JSON.parse(readFileSync(FILE(), "utf8")) as XfCatalog;
  } catch {
    return null;
  }
}

async function listText(tool: string): Promise<string> {
  const r = await callTool(tool, {}, { timeoutMs: 60_000 });
  return textOf(r);
}

function asModel(r: Record<string, string | string[]>): XfModel {
  const one = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
  const many = (k: string) => (Array.isArray(r[k]) ? (r[k] as string[]) : undefined);
  return {
    slug: String(r.slug ?? r.id),
    name: one("name") || String(r.slug ?? r.id),
    family: one("family"),
    beta: one("beta") === "true",
    premium: one("requiresPremium") === "true",
    seconds: Number(one("expectedGenerationTime")) || undefined,
    aspectRatios: many("aspectRatios"),
    resolutions: many("resolutions"),
    durations: many("durations"),
  };
}

const REST_IMAGE = new Set(["mystic", "flux-dev", "flux", "flux-2", "seedream-4-5"]);
// Only models that expose BOTH a submit and a status route belong here.
const REST_VIDEO = new Set(["wan-2-5", "kling-25", "minimax-video-02"]);

export async function catalog(opts: { refresh?: boolean } = {}): Promise<XfCatalog> {
  const cached = readCache();
  if (!opts.refresh && cached && Date.now() - cached.at < TTL_MS) return { ...cached, source: "cache" };
  if (!isConnected()) return cached ? { ...cached, source: "cache" } : FALLBACK;

  try {
    const [img, vid, voi, modes, presets] = await Promise.all([
      listText("images_models_list"),
      listText("video_models_list"),
      listText("audio_voices_list"),
      listText("images_upscale_modes_list"),
      listText("images_upscale_presets_list").catch(() => ""),
    ]);

    const cat: XfCatalog = {
      at: Date.now(),
      image: parseOutline(img, "slug").map(asModel).map((m) => ({ ...m, rest: REST_IMAGE.has(m.slug) })),
      video: parseOutline(vid, "slug").map(asModel).map((m) => ({ ...m, rest: REST_VIDEO.has(m.slug) })),
      voices: parseOutline(voi, "id").map((r) => ({
        id: String(r.id),
        name: (typeof r.name === "string" ? r.name : String(r.id)).trim(),
        provider: typeof r.provider === "string" ? r.provider : undefined,
        gender: typeof r.gender === "string" ? r.gender : undefined,
        age: typeof r.age === "string" ? r.age : undefined,
        languages: Array.isArray(r.languages) ? r.languages : undefined,
      })),
      upscaleModes: parseOutline(modes, "id").map((r) => ({ id: String(r.id), name: String(r.name ?? r.id) })),
      upscalePresets: presets ? parseOutline(presets, "id").map((r) => ({ id: String(r.id), name: String(r.name ?? r.id) })) : [],
      source: "mcp",
    };

    // An empty parse means the outline changed shape. The previous catalogue is worth more
    // than an empty picker, so it stands until a later read succeeds.
    if (!cat.image.length) {
      logger.warn("catalog", "images_models_list parsed to nothing — keeping the previous catalogue");
      return cached ? { ...cached, source: "cache" } : FALLBACK;
    }
    writeFileSync(FILE(), JSON.stringify(cat), "utf8");
    logger.info("catalog", `refreshed: ${cat.image.length} image, ${cat.video.length} video, ${cat.voices.length} voices`);
    return cat;
  } catch (e) {
    logger.warn("catalog", `refresh failed: ${(e as Error).message}`);
    return cached ? { ...cached, source: "cache" } : FALLBACK;
  }
}
