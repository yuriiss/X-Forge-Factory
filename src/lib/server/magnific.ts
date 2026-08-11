import { getCredential, noteRequest, type Ctx } from "./repo";
import { useCredential } from "./secrets";
import { logger } from "./logger";

/**
 * The REST adapter for api.magnific.com.
 *
 * Everything here is the same three moves — POST a task, GET it until `status` is
 * COMPLETED, download what `generated[]` points at — so there is one helper rather than
 * one per capability. The paths were established against the live API, not copied from
 * the published index, because several published names are NOT the URL:
 *
 *   · the creative upscaler answers on `/v1/ai/image-upscaler`;
 *   · text-to-image models need the category segment (`/v1/ai/text-to-image/<model>`)
 *     while Mystic alone answers on the flat path;
 *   · background removal is still under `/v1/ai/beta/` and is form-encoded, not JSON.
 *
 * The key is decrypted per call, inside `useCredential`, and never leaves that closure —
 * spec §2.2 requirement 2. No client caches it, no module holds it.
 */

const BASE = "https://api.magnific.com";

export class MagnificError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = "provider_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  form?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * One authenticated call.
 *
 * Every outbound request is counted first (the shaper in §5 reads that counter), and the
 * key is fetched, used and dropped inside this function so no caller ever holds it.
 */
export async function rest<T = unknown>(ctx: Ctx, path: string, opts: RequestOptions = {}): Promise<T> {
  const cred = getCredential(ctx);
  if (!cred) throw new MagnificError("no Magnific credential for this tenant", 401, "no_credential");

  const headers: Record<string, string> = useCredential(cred, (key) => ({ "x-magnific-api-key": key }));
  if (opts.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  else if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  noteRequest(ctx, "provider");

  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"),
    headers,
    body: opts.form ? new URLSearchParams(opts.form).toString() : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const err = json as { message?: string; invalid_params?: { field?: string; reason?: string }[] } | null;
    // "Validation error" on its own tells the operator nothing. The provider says exactly
    // which field it disliked and why, and that belongs in the job's error detail — it is
    // the difference between "try again" and "duration must be '5' or '10'".
    const detail = err?.invalid_params?.length
      ? ` — ${err.invalid_params.map((p) => `${p.field?.split(".").pop() ?? "?"}: ${p.reason ?? "invalid"}`).join("; ")}`
      : "";
    const message = `${err?.message || text.slice(0, 300) || `HTTP ${res.status}`}${detail}`;
    // 429 and 5xx are the retryable ones; everything else is the caller's problem and
    // repeating it just spends the operator's rate budget.
    throw new MagnificError(`${path}: ${message}`, res.status, res.status === 429 ? "rate_limited" : "provider_error");
  }
  return json as T;
}

interface TaskEnvelope {
  data?: {
    task_id?: string;
    status?: string;
    error?: string | null;
    generated?: Array<string | { url?: string; audio_url?: string; image_url?: string; video_url?: string }>;
  };
}

export interface SubmittedTask {
  taskId: string;
  path: string;
}

/** POST a task. The answer is an id, not a result — everything here is asynchronous. */
export async function submitTask(ctx: Ctx, path: string, body: unknown): Promise<SubmittedTask> {
  const json = await rest<TaskEnvelope>(ctx, path, { body });
  const taskId = json?.data?.task_id;
  if (!taskId) throw new MagnificError(`${path}: no task_id in response`, 502);
  return { taskId, path };
}

export type TaskState = "queued" | "running" | "completed" | "failed";

export interface TaskStatus {
  state: TaskState;
  urls: string[];
  error?: string;
  raw?: string;
}

/** One poll. The state machine, not this function, decides what a state means. */
export async function pollTask(ctx: Ctx, path: string, taskId: string): Promise<TaskStatus> {
  const json = await rest<TaskEnvelope>(ctx, `${path}/${taskId}`);
  const d = json?.data;
  const status = (d?.status ?? "").toUpperCase();

  if (status === "COMPLETED") {
    // Most endpoints answer with plain URL strings; audio answers with objects carrying
    // the URL under one of several names. Normalising here keeps callers one-liners —
    // without it the download step tries to fetch "[object Object]".
    const urls = (d?.generated ?? [])
      .map((g) => (typeof g === "string" ? g : g?.url || g?.audio_url || g?.image_url || g?.video_url || ""))
      .filter(Boolean);
    return { state: "completed", urls, raw: status };
  }
  if (status === "FAILED" || status === "ERROR") {
    return { state: "failed", urls: [], error: d?.error || "task failed", raw: status };
  }
  if (status === "IN_PROGRESS" || status === "PROCESSING" || status === "RUNNING") {
    return { state: "running", urls: [], raw: status };
  }
  return { state: "queued", urls: [], raw: status || "CREATED" };
}

/** Background removal: the odd one out — form-encoded, synchronous, needs a public URL. */
export async function removeBackground(ctx: Ctx, imageUrl: string): Promise<string> {
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new MagnificError("remove-background needs a public https URL — this endpoint refuses base64 and data: URLs", 400, "bad_input");
  }
  const json = await rest<{ high_resolution?: string; preview?: string; message?: string }>(ctx, "/v1/ai/beta/remove-background", {
    form: { image_url: imageUrl },
  });
  const url = json?.high_resolution || json?.preview;
  if (!url) throw new MagnificError("remove-background returned no image", 502);
  return url;
}

/* ------------------------------------------------------- capability table -- */

export type Family = "image" | "video" | "audio" | "3d" | "icon" | "utility";

export interface Capability {
  /** How the engine names the job kind. */
  id: string;
  family: Family;
  label: string;
  /** REST path, when this capability has one. Some only exist over MCP. */
  path?: string;
  /** Fallback estimate in credits when `simulate_cost` cannot price it. */
  estimate: number;
  /** Which MCP tool performs the same work, for the MCP execution path. */
  mcpTool?: string;
  /**
   * The catalogue slug this capability really runs.
   *
   * Pricing goes through `simulate_cost`, which prices a MODEL. Without this, a REST job
   * on a named model would be priced as `mode: auto` — the server's answer for "I will
   * decide later", which is honest for auto and wrong for everything else.
   */
  slug?: string;
  /** Minutes, roughly — used only to size the poll deadline. */
  patience?: number;
}

/**
 * What X-Forge can run, and how.
 *
 * Two execution paths exist on purpose. REST is the operator's own key with webhooks and
 * task ids; MCP is the OAuth session, which reaches the *full* catalogue — 48 image models
 * and 52 video models rather than the handful with dedicated REST paths — and can price a
 * call before it runs. Jobs record which path they took.
 */
export const CAPABILITIES: Capability[] = [
  // ── image generation
  { id: "image.mystic", family: "image", label: "Mystic", path: "/v1/ai/mystic", estimate: 8, slug: "mystic", mcpTool: "images_generate", patience: 8 },
  { id: "image.flux-dev", family: "image", label: "FLUX.1 dev", path: "/v1/ai/text-to-image/flux-dev", estimate: 8, slug: "flux-dev", mcpTool: "images_generate", patience: 8 },
  { id: "image.hyperflux", family: "image", label: "HyperFlux", path: "/v1/ai/text-to-image/hyperflux", estimate: 4, slug: "flux", mcpTool: "images_generate", patience: 6 },
  { id: "image.flux-2-pro", family: "image", label: "FLUX 2 Pro", path: "/v1/ai/text-to-image/flux-2-pro", estimate: 20, slug: "flux-2", mcpTool: "images_generate", patience: 8 },
  { id: "image.seedream", family: "image", label: "Seedream 4.5", path: "/v1/ai/text-to-image/seedream-v4-5", estimate: 12, slug: "seedream-4-5", mcpTool: "images_generate", patience: 8 },
  { id: "image.generate", family: "image", label: "Image (catalogue)", estimate: 100, mcpTool: "images_generate", patience: 8 },

  // ── enhancement
  { id: "image.upscale", family: "image", label: "Upscaler Creative", path: "/v1/ai/image-upscaler", estimate: 90, mcpTool: "images_upscale", patience: 10 },
  { id: "image.upscale-precision", family: "image", label: "Precision V2", path: "/v1/ai/image-upscaler-precision-v2", estimate: 90, mcpTool: "images_upscale", patience: 10 },
  { id: "image.skin", family: "image", label: "Skin Enhancer", path: "/v1/ai/skin-enhancer/creative", estimate: 60, mcpTool: "images_skin_enhancer", patience: 8 },

  // ── editing
  { id: "image.relight", family: "image", label: "Relight", path: "/v1/ai/image-relight", estimate: 40, mcpTool: "images_relight", patience: 8 },
  { id: "image.expand", family: "image", label: "Expand", path: "/v1/ai/image-expand/flux-pro", estimate: 40, mcpTool: "images_expand", patience: 8 },
  { id: "image.remove-bg", family: "image", label: "Remove background", path: "/v1/ai/beta/remove-background", estimate: 10, mcpTool: "images_remove_background", patience: 4 },
  { id: "image.camera", family: "image", label: "Change camera", estimate: 40, mcpTool: "images_change_camera", patience: 8 },
  { id: "image.variations", family: "image", label: "Variations", estimate: 40, mcpTool: "images_variations", patience: 8 },
  { id: "image.retouch", family: "image", label: "Retouch region", estimate: 40, mcpTool: "images_retouch", patience: 8 },
  { id: "image.to-svg", family: "image", label: "Raster → SVG", estimate: 20, mcpTool: "images_to_svg", patience: 5 },
  { id: "image.crop", family: "image", label: "Smart crop", estimate: 4, mcpTool: "images_crop", patience: 3 },
  { id: "image.resize", family: "image", label: "Resize", estimate: 4, mcpTool: "images_resize", patience: 3 },

  // ── icons / vector
  { id: "icon.generate", family: "icon", label: "Text → icon (SVG)", estimate: 20, mcpTool: "images_generate_svg", patience: 5 },

  // ── video
  { id: "video.t2v", family: "video", label: "Text → video", path: "/v1/ai/text-to-video/wan-2-5-t2v-1080p", estimate: 180, slug: "wan-2-5", mcpTool: "video_generate", patience: 20 },
  // Kling 2.6 accepts a POST here and has NO status route — `GET …/kling-v2-6-pro/{id}`
  // is a 404 while `kling-v2-5-pro/{id}` answers "task not found", which is the difference
  // between "wrong id" and "no such endpoint". A model whose result can only arrive by
  // webhook is the wrong REST default for a console on localhost, so the REST path runs
  // 2.5 and 2.6 is reached over MCP, where completion comes back through creations.
  { id: "video.i2v", family: "video", label: "Image → video", path: "/v1/ai/image-to-video/kling-v2-5-pro", estimate: 240, slug: "kling-25", mcpTool: "video_generate", patience: 20 },
  { id: "video.generate", family: "video", label: "Video (catalogue)", estimate: 240, mcpTool: "video_generate", patience: 25 },
  { id: "video.upscale", family: "video", label: "Video upscale", estimate: 300, mcpTool: "video_upscale", patience: 25 },
  { id: "video.speak", family: "video", label: "Lip sync", estimate: 200, mcpTool: "video_speak", patience: 20 },

  // ── audio
  { id: "audio.music", family: "audio", label: "Music generation", path: "/v1/ai/music-generation", estimate: 60, mcpTool: "audio_music_generate", patience: 15 },
  { id: "audio.sfx", family: "audio", label: "Sound effects", path: "/v1/ai/sound-effects", estimate: 20, mcpTool: undefined, patience: 8 },
  { id: "audio.isolate", family: "audio", label: "Audio isolation", path: "/v1/ai/audio-isolation", estimate: 20, patience: 8 },
  { id: "audio.tts", family: "audio", label: "Text to speech", estimate: 30, mcpTool: "audio_tts", patience: 8 },

  // ── 3d
  { id: "model3d.generate", family: "3d", label: "Image → 3D", estimate: 200, mcpTool: "models3d_generate", patience: 20 },

  // ── utilities
  { id: "utility.image-to-prompt", family: "utility", label: "Image → prompt", path: "/v1/ai/image-to-prompt", estimate: 0, patience: 3 },
  { id: "utility.improve-prompt", family: "utility", label: "Improve prompt", path: "/v1/ai/improve-prompt", estimate: 0, patience: 3 },
];

export function capability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/* ------------------------------------------------- non-task REST surface -- */

export interface CreationRecord {
  id: number;
  name?: string;
  reference?: string;
  created_at?: string;
  url?: string;
  preview?: string;
  thumbnail?: string;
  type?: string;
  tool_name?: string;
  [k: string]: unknown;
}

export async function recentCreations(ctx: Ctx, limit = 24): Promise<CreationRecord[]> {
  const j = await rest<{ data?: CreationRecord[] }>(ctx, `/v1/creations/recent?limit=${limit}`);
  return j?.data ?? [];
}

export async function listLoras(ctx: Ctx): Promise<Record<string, unknown>> {
  const j = await rest<{ data?: Record<string, unknown> }>(ctx, "/v1/ai/loras");
  return j?.data ?? {};
}

export async function listFlows(ctx: Ctx, mine = false): Promise<{ sqid: string; name: string }[]> {
  const j = await rest<{ data?: { sqid: string; name: string }[] }>(ctx, mine ? "/v1/ai/me/flows" : "/v1/ai/flows");
  return j?.data ?? [];
}

export async function getFlow(ctx: Ctx, sqid: string): Promise<unknown> {
  const j = await rest<{ data?: unknown }>(ctx, `/v1/ai/flows/${encodeURIComponent(sqid)}`);
  return j?.data ?? j;
}

export async function runFlow(ctx: Ctx, sqid: string, inputs: Record<string, unknown>, webhook?: string): Promise<unknown> {
  const j = await rest<{ data?: unknown }>(ctx, `/v1/ai/flows/${encodeURIComponent(sqid)}/run`, {
    body: { inputs, ...(webhook ? { webhook } : {}) },
  });
  return j?.data ?? j;
}

export async function flowRun(ctx: Ctx, sqid: string, runId: string): Promise<unknown> {
  const j = await rest<{ data?: unknown }>(ctx, `/v1/ai/flows/${encodeURIComponent(sqid)}/runs/${encodeURIComponent(runId)}`);
  return j?.data ?? j;
}

export async function searchStock(ctx: Ctx, params: Record<string, string>): Promise<unknown> {
  const q = new URLSearchParams(params).toString();
  return rest(ctx, `/v1/resources?${q}`);
}

export async function searchIcons(ctx: Ctx, params: Record<string, string>): Promise<unknown> {
  const q = new URLSearchParams(params).toString();
  return rest(ctx, `/v1/icons?${q}`);
}

export async function searchStockVideos(ctx: Ctx, params: Record<string, string>): Promise<unknown> {
  const q = new URLSearchParams(params).toString();
  return rest(ctx, `/v1/videos?${q}`);
}

export async function searchStockMusic(ctx: Ctx, params: Record<string, string>): Promise<unknown> {
  const q = new URLSearchParams(params).toString();
  return rest(ctx, `/v1/music?${q}`);
}

export async function searchStockSfx(ctx: Ctx, params: Record<string, string>): Promise<unknown> {
  const q = new URLSearchParams(params).toString();
  return rest(ctx, `/v1/sound-effects?${q}`);
}

export interface UploadSlot {
  upload_url: string;
  asset_url?: string;
  headers?: Record<string, string>;
  [k: string]: unknown;
}

/**
 * The staging area: request a signed URL, PUT the bytes, then hand `asset_url` to any
 * endpoint. It is staging and not storage — the files expire in about a week.
 */
export async function requestUploadUrls(ctx: Ctx, files: { content_type: string }[]): Promise<UploadSlot[]> {
  const j = await rest<{ files?: UploadSlot[] }>(ctx, "/v1/ai/uploads/request-url", { body: { files } });
  return j?.files ?? [];
}

export async function listUploads(ctx: Ctx): Promise<unknown> {
  return rest(ctx, "/v1/ai/uploads");
}

/**
 * Push bytes into the staging area and return the URL endpoints can read.
 *
 * The PUT carries the signed headers Magnific returned and NOT the API key — the URL is
 * already the authorisation, and sending the key to a storage host would be handing it to
 * a party that has no business seeing it.
 */
export async function uploadBytes(ctx: Ctx, bytes: Buffer, contentType: string): Promise<string> {
  const [slot] = await requestUploadUrls(ctx, [{ content_type: contentType }]);
  if (!slot?.upload_url) throw new MagnificError("upload: no signed URL returned", 502);
  const headers: Record<string, string> = { "Content-Type": contentType, ...(slot.headers ?? {}) };
  const put = await fetch(slot.upload_url, { method: "PUT", headers, body: new Uint8Array(bytes), signal: AbortSignal.timeout(300_000) });
  if (!put.ok) throw new MagnificError(`upload: PUT failed HTTP ${put.status} ${(await put.text()).slice(0, 200)}`, put.status);
  const assetUrl = slot.asset_url || (slot.upload_url.split("?")[0] ?? "");
  logger.info("magnific", `staged ${bytes.length}B ${contentType}`);
  return assetUrl;
}

/**
 * Verify a key by spending nothing.
 *
 * Requirement 5 says a credential is validated with a live call before it is stored; the
 * uploads listing is authenticated, free, and answers immediately, which makes it the
 * right probe — a generation would validate the key by charging for it.
 */
export async function verifyKey(ctx: Ctx): Promise<boolean> {
  try {
    await rest(ctx, "/v1/ai/uploads");
    return true;
  } catch (e) {
    if (e instanceof MagnificError && (e.status === 401 || e.status === 403)) return false;
    throw e;
  }
}
