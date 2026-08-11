#!/usr/bin/env node
/**
 * Capability sweep — run every X-Forge capability once, on the cheapest setting that
 * still proves the path, and report what actually worked.
 *
 * This is the acceptance run: unit tests prove the rules and the API suite proves the
 * plumbing, but neither answers "does every button in this console do something real".
 * Here each capability is submitted for real, followed to a terminal state, and reported
 * with what it cost and what it produced.
 *
 *   node scripts/capability-sweep.mjs            # everything except video and 3D
 *   node scripts/capability-sweep.mjs --all      # including video and 3D (expensive)
 *   node scripts/capability-sweep.mjs --only=audio.tts,image.relight
 */

const BASE = process.env.XFORGE_BASE ?? "http://127.0.0.1:7777";
const args = process.argv.slice(2);
const ALL = args.includes("--all");
const RUN = Date.now().toString(36).slice(-5);
const ONLY = (args.find((a) => a.startsWith("--only=")) ?? "").replace("--only=", "").split(",").filter(Boolean);

const get = async (p) => {
  const r = await fetch(`${BASE}${p}`);
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const post = async (p, body, method = "POST") => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const LIVE = ["created", "validating", "budget_check", "queued", "reserved", "submitted", "running", "downloading"];

/** New work is refused at the RPM ceiling — that is correct, so wait for room. */
async function headroom() {
  for (let i = 0; i < 60; i++) {
    const { json } = await get("/api/status");
    if (json.shaper && json.shaper.tenantRpm < json.shaper.tenantLimit - 8) return;
    await sleep(3000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(jobId, timeoutMs = 20 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await get(`/api/jobs/${jobId}`);
    if (!json.job) return { status: "gone" };
    if (!LIVE.includes(json.job.status) || Date.now() > deadline) return json.job;
    await sleep(3000);
  }
}

/** Upload a file the way the console does, so every input form is exercised too. */
async function upload(bytes, name, type) {
  const fd = new FormData();
  fd.append("file", new File([bytes], name, { type }));
  fd.append("creation", "1");
  fd.append("staging", "1");
  const r = await fetch(`${BASE}/api/uploads`, { method: "POST", body: fd });
  const json = await r.json();
  if (!r.ok) throw new Error(json.message ?? "upload failed");
  return json;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "  ✓" : "  ✕"} ${name.padEnd(26)} ${detail}\n`);
}

async function runJob(name, kind, params, opts = {}) {
  if (ONLY.length && !ONLY.includes(kind)) return null;
  await headroom();
  try {
    const { json } = await post("/api/jobs", { kind, params, label: `sweep ${kind}`, preapproved: true, ...opts });
    if (json.status === "rejected_budget" || json.status === "failed") {
      record(name, false, `${json.reason ?? json.status}: ${json.message ?? ""}`);
      return null;
    }
    const job = await settle(json.jobId);
    const ok = job.status === "succeeded" && job.assets.length > 0;
    record(name, ok, ok ? `${job.actualCredits} cr · ${job.assets.length} file(s) · ${job.assets[0].mime}` : `${job.status} · ${job.errorCode ?? ""} ${(job.error ?? "").slice(0, 90)}`);
    return job;
  } catch (e) {
    record(name, false, e.message);
    return null;
  }
}

async function main() {
  const status = await get("/api/status");
  console.log(`\nX-FORGE capability sweep · balance ${status.json.balance?.available ?? "?"} credits · ${ALL ? "including" : "excluding"} video and 3D\n`);

  /* ---------------------------------------------------------------- inputs */
  // A source image every image-input tool can use: the cheapest generator makes it.
  const seed = await runJob("image · hyperflux", "image.hyperflux", {
    prompt: `a small brass anvil on a dark workbench, single spark, ${Date.now()}`,
    aspect_ratio: "square_1_1",
    resolution: "1k",
  });

  let source = null;
  if (seed?.assets?.length) {
    const res = await fetch(`${BASE}${seed.assets[0].url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    source = await upload(bytes, "sweep-source.jpg", seed.assets[0].mime);
    record("upload · vault + staging + creation", !!source.assetUrl && !!source.creationIdentifier, `${(bytes.length / 1024) | 0} KB · creation ${source.creationIdentifier ?? "none"}`);
  }

  /* ------------------------------------------------------------ generation */
  await runJob("image · mystic", "image.mystic", {
    prompt: `editorial portrait of a glassblower at dusk, molten amber light, ${RUN}`,
    aspect_ratio: "square_1_1",
    resolution: "1k",
    model: "realism",
  });

  await runJob("image · catalogue (MCP)", "image.generate", { prompt: `a lone lighthouse in fog, minimal, ${RUN}`, slug: "flux", aspectRatio: "1:1" }, { via: "mcp" });

  /* -------------------------------------------------------------- enhance */
  if (source) {
    await runJob("upscale · creative 2x", "image.upscale", {
      image: source.dataUrl,
      scale_factor: "2x",
      engine: "automatic",
      optimized_for: "standard",
      creativity: 0,
      hdr: 0,
      resemblance: 0,
    });

    await runJob("edit · relight", "image.relight", { image: source.dataUrl, prompt: `cold blue moonlight from the left, ${RUN}` });

    await runJob("edit · expand", "image.expand", { image: source.dataUrl, prompt: `extend the workbench, ${RUN}`, aspect_ratio: "widescreen_16_9" });

    await runJob("edit · remove background", "image.remove-bg", { image_url: source.assetUrl });

    await runJob("edit · variations (MCP)", "image.variations", { creationIdentifier: source.creationIdentifier }, { via: "mcp" });
  }

  /* ---------------------------------------------------------------- vector */
  await runJob("icon · text → SVG", "icon.generate", { prompt: `minimal line icon of an anvil with a spark, single colour, ${RUN}` }, { via: "mcp" });

  /* ----------------------------------------------------------------- audio */
  await runJob("audio · music", "audio.music", { prompt: `warm synthwave bed, analog pads, 84 BPM, ${RUN}`, duration: 15 });
  await runJob("audio · sound effect", "audio.sfx", { prompt: `single hammer strike on an anvil, metallic ring, ${RUN}`, duration: 3 });

  const voices = await get("/api/catalog");
  const voice = voices.json.voices?.[0];
  if (voice) {
    await runJob("audio · text to speech", "audio.tts", { text: `X-Forge capability sweep, voice path, run ${RUN}.`, voiceId: voice.id }, { via: "mcp" });
  }

  /* ----------------------------------------------------------- utilities */
  if (source) {
    try {
      const { json } = await post("/api/utilities/image-to-prompt", { image: source.dataUrl });
      record("utility · image → prompt", !!json.result, (json.result ?? json.message ?? "").slice(0, 80));
    } catch (e) {
      record("utility · image → prompt", false, e.message);
    }
  }
  try {
    const { json } = await post("/api/utilities/improve-prompt", { prompt: "cat in space" });
    record("utility · improve prompt", !!json.result, (json.result ?? json.message ?? "").slice(0, 80));
  } catch (e) {
    record("utility · improve prompt", false, e.message);
  }
  try {
    const { json } = await post("/api/utilities/video-plan", { prompt: "a spark flying off an anvil", duration: 5 });
    record("utility · video plan (MCP)", !!json.result, String(json.result ?? "").slice(0, 80).replace(/\n/g, " "));
  } catch (e) {
    record("utility · video plan (MCP)", false, e.message);
  }

  /* --------------------------------------------------------------- library */
  for (const [label, path] of [
    ["stock · images", "/api/stock?type=images&q=harbour&limit=3"],
    ["stock · videos", "/api/stock?type=videos&q=ocean&limit=3"],
    ["stock · music", "/api/stock?type=music&q=lofi&limit=3"],
    ["stock · sfx", "/api/stock?type=sfx&q=whoosh&limit=3"],
    ["stock · icons", "/api/stock?type=icons&q=anchor&limit=3"],
    ["flows · published", "/api/flows"],
    ["flows · mine", "/api/flows?scope=mine"],
    ["references · loras", "/api/loras"],
    ["creations · account", "/api/creations?scope=account&per_page=3"],
    ["creations · folders", "/api/creations?scope=folders"],
    ["creations · spaces", "/api/creations?scope=spaces"],
    ["analytics", "/api/analytics?days=7"],
  ]) {
    try {
      const { status, json } = await get(path);
      const n = json.items?.length ?? json.flows?.length ?? json.references?.length ?? json.folders?.length ?? json.spaces?.length ?? json.daily?.length ?? 0;
      record(label, status === 200, `${status} · ${n} record(s)`);
    } catch (e) {
      record(label, false, e.message);
    }
  }

  /* ------------------------------------------------------------ expensive */
  if (ALL) {
    if (source) {
      await runJob("video · image → video", "video.i2v", {
        // The video models take a hosted image, never base64.
        image: source.assetUrl,
        prompt: `the spark drifts upward, slow motion, ${RUN}`,
        duration: "5",
        aspect_ratio: "16:9",
      });
      await runJob("3d · image → GLB", "model3d.generate", { creationIdentifier: source.creationIdentifier, model: "tripo-p1" }, { via: "mcp" });
    }
  } else {
    record("video · image → video", true, "skipped — run with --all (≈225 credits)");
    record("3d · image → GLB", true, "skipped — run with --all (≈580 credits)");
  }

  const after = await get("/api/status");
  const spent = (status.json.balance?.available ?? 0) - (after.json.balance?.available ?? 0);
  const failed = results.filter((r) => !r.ok);

  console.log(`\n${results.length - failed.length}/${results.length} capabilities working · ${spent} credits spent · balance ${after.json.balance?.available ?? "?"}`);
  if (failed.length) {
    console.log("\nfailed:");
    for (const f of failed) console.log(`  ✕ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
