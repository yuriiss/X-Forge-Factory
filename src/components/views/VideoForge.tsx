"use client";

import { useT } from "@/lib/i18n";
import { useMemo, useState } from "react";
import { Dropzone, Field, JobResult, Seg, Toggle, postJson, useEstimate, useJobRunner, useJson, useToast, type Upload } from "../ui";
import { useNav } from "../Console";
import { redactBase64 } from "./ImageForge";

/**
 * Video Forge.
 *
 * Video is the expensive family, so this view is built around knowing the price before
 * committing: the estimate updates with every parameter, and anything above the tenant's
 * approval threshold produces a link a human has to open. `video_plan` is offered as a
 * first step because Magnific's own guidance is to plan before generating — it costs
 * nothing and returns a model recommendation and a prompt draft.
 */

const MODES = ["T2V", "I2V"] as const;
const DURATIONS = ["5", "8", "10"] as const;
const RESOLUTIONS = ["480p", "720p", "1080p"] as const;
const ASPECTS = ["16:9", "9:16", "1:1", "21:9", "3:2", "2:3"] as const;

interface Catalog {
  video: { slug: string; name: string; family?: string; seconds?: number; durations?: string[]; resolutions?: string[]; aspectRatios?: string[]; rest?: boolean }[];
}

export default function VideoForge() {
  const t = useT();
  const { status } = useNav();
  const toast = useToast();
  const runner = useJobRunner();

  const [mode, setMode] = useState<(typeof MODES)[number]>("I2V");
  const [prompt, setPrompt] = useState("");
  const [slug, setSlug] = useState("auto");
  const [duration, setDuration] = useState<(typeof DURATIONS)[number]>("5");
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>("1080p");
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]>("16:9");
  const [first, setFirst] = useState<Upload | null>(null);
  const [last, setLast] = useState<Upload | null>(null);
  const [audio, setAudio] = useState(true);
  const [cameraFixed, setCameraFixed] = useState(false);
  const [webhook, setWebhook] = useState("");
  const [seed, setSeed] = useState("");
  const [plan, setPlan] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);

  const catalog = useJson<Catalog>("/api/catalog");
  const models = catalog.data?.video ?? [];
  const chosen = models.find((m) => m.slug === slug);

  // The REST paths take base64 or a URL; the MCP tool takes a creation identifier. Which
  // one an upload needs depends on the path, so both forms are requested for the still.
  const viaMcp = slug !== "auto" ? !chosen?.rest : true;
  const kind = viaMcp ? "video.generate" : mode === "T2V" ? "video.t2v" : "video.i2v";

  const params = useMemo(() => {
    if (viaMcp) {
      return {
        prompt,
        slug: slug === "auto" ? undefined : slug,
        duration: Number(duration),
        aspectRatio: aspect,
        resolution,
        startImage: first?.creationIdentifier ?? undefined,
      } as Record<string, unknown>;
    }
    return {
      prompt,
      duration,
      aspect_ratio: aspect,
      // The video models take a URL, not bytes: a `data:` image is refused outright, so
      // the staged upload is preferred and base64 is only a last resort.
      ...(mode === "I2V"
        ? { image: first?.assetUrl ?? first?.dataUrl ?? undefined, image_end: last?.assetUrl ?? last?.dataUrl ?? undefined }
        : {}),
      generate_audio: audio,
      camera_fixed: cameraFixed,
      seed: seed ? Number(seed) : undefined,
      webhook_url: webhook || undefined,
    } as Record<string, unknown>;
  }, [viaMcp, prompt, slug, duration, aspect, resolution, first, last, mode, audio, cameraFixed, seed, webhook]);

  const est = useEstimate(kind, params, !!prompt.trim() || !!first);

  const runPlan = async () => {
    setPlanning(true);
    try {
      const r = await postJson<{ result: unknown }>("/api/utilities/video-plan", {
        prompt,
        duration: Number(duration),
        aspectRatio: aspect,
      });
      setPlan(typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2));
    } catch (e) {
      toast.push("err", (e as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const generate = async () => {
    if (!prompt.trim() && mode === "T2V") {
      toast.push("err", t("A prompt is required"));
      return;
    }
    if (mode === "I2V" && !first) {
      toast.push("err", t("Image → video needs a first frame"));
      return;
    }
    if (!status?.tenant.videoEnabled) {
      toast.push("err", t("Video is disabled for this tenant — enable it in Developers"));
      return;
    }
    await runner.run(kind, params, { label: prompt.slice(0, 60) || "video", via: viaMcp ? "mcp" : "rest" });
  };

  const families = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const m of models) {
      const f = m.family ?? "other";
      map.set(f, [...(map.get(f) ?? []), m.name]);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [models]);

  return (
    <>
      <div className="intro">
        <div>
          <h1>{t("VIDEO FORGE")}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {models.length} models · text / image → video · native audio · motion control
          </div>
        </div>
        <div className="topbar-spacer" />
        <span className={`chip ${status?.tenant.videoEnabled ? "active" : ""}`}>
          {status?.tenant.videoEnabled ? t("VIDEO ENABLED") : t("VIDEO DISABLED")}
        </span>
        <span className="chip">{t("GATE · {n} CR", { n: status?.tenant.approvalThreshold ?? 0 })}</span>
      </div>

      <div className="forge-layout">
        {/* Left */}
        <div className="panel">
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 13 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: "var(--accent)" }}>
                {(chosen?.name ?? t("AUTO SELECT")).toUpperCase()} · {mode}
              </div>
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>
                {viaMcp ? "MCP video_generate" : mode === "T2V" ? "POST /v1/ai/text-to-video/wan-2-5-t2v-1080p" : "POST /v1/ai/image-to-video/kling-v2-6-pro"}
              </div>
            </div>

            <div>
              <div className="label">{t("MODE")}</div>
              <Seg options={MODES} value={mode} onChange={setMode} />
            </div>

            <div>
              <div className="label">{t("MODEL · {n} AVAILABLE", { n: models.length })}</div>
              <select className="select" value={slug} onChange={(e) => setSlug(e.target.value)}>
                <option value="auto">{t("auto — the server picks")}</option>
                {models.map((m) => (
                  <option key={m.slug} value={m.slug}>
                    {m.name}
                    {m.seconds ? ` · ~${m.seconds}s` : ""}
                  </option>
                ))}
              </select>
              {chosen?.durations?.length ? <div className="hint">{t("durations: {list}", { list: chosen.durations.join(", ") })}</div> : null}
            </div>

            <Field label={t("PROMPT")} rows={3} value={prompt} onChange={setPrompt} placeholder={t("Slow dolly-in, product rotates on velvet plinth, soft rim light…")} />

            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" style={{ flex: 1 }} disabled={planning || !prompt.trim()} onClick={runPlan}>
                {planning ? t("◷ PLANNING…") : t("⌁ PLAN · FREE")}
              </button>
            </div>
            {plan ? (
              <div className="well" style={{ padding: "10px 12px", maxHeight: 180, overflow: "auto" }}>
                <div className="eyebrow" style={{ marginBottom: 6 }}>
                  {t("VIDEO PLAN")}
                </div>
                <pre className="json">{plan}</pre>
              </div>
            ) : null}

            {mode === "I2V" ? (
              <>
                <Dropzone
                  label={t("⊕ image · first frame")}
                  hint={t("drop a still — kept locally and staged for the provider")}
                  accept="image/*"
                  value={first}
                  onChange={setFirst}
                  needCreation
                  needStaging
                  minHeight={86}
                />
                <Dropzone label={t("⊕ image_end · last frame")} hint={t("optional · enables transition")} accept="image/*" value={last} onChange={setLast} minHeight={60} />
              </>
            ) : null}

            <div>
              <div className="label">{t("RESOLUTION")}</div>
              <Seg options={RESOLUTIONS} value={resolution} onChange={setResolution} />
            </div>
            <div>
              <div className="label">{t("DURATION")}</div>
              <Seg options={DURATIONS} value={duration} onChange={setDuration} />
            </div>
            <div>
              <div className="label">{t("ASPECT RATIO")}</div>
              <Seg options={ASPECTS} value={aspect} onChange={setAspect} wrap />
            </div>

            {!viaMcp ? (
              <>
                <Toggle on={audio} onChange={setAudio} label={t("GENERATE AUDIO · native sound")} />
                <Toggle on={cameraFixed} onChange={setCameraFixed} label={t("CAMERA_FIXED · lock framing")} />
                <Field label={t("SEED · 0 — 4 294 967 295")} value={seed} onChange={setSeed} placeholder="random" />
                <Field label={t("WEBHOOK_URL · OPTIONAL")} value={webhook} onChange={setWebhook} placeholder="https://your-server.com/webhook" />
              </>
            ) : null}

            <button className="btn primary" style={{ width: "100%", marginTop: "auto" }} disabled={runner.busy} onClick={generate}>
              {runner.busy ? t("◷ RENDERING…") : `${t("▶ GENERATE")} · ≈ ${est?.credits ?? "?"} ${t("CREDITS")}`}
            </button>
            {est?.willNeedApproval ? <div className="hint">{t("Above the gate — approval link will be issued before anything is spent.")}</div> : null}
          </div>
        </div>

        {/* Centre */}
        <div className="workspace" style={{ minHeight: 560 }}>
          <div style={{ width: "100%" }}>
            <JobResult job={runner.job} blocked={runner.blocked} error={runner.error} placeholder="▶" height={320} />
          </div>
          <div style={{ display: "flex", gap: 8, width: "100%" }}>
            <a
              className="btn"
              style={{ flex: 1, pointerEvents: runner.job?.assets.length ? "auto" : "none", opacity: runner.job?.assets.length ? 1 : 0.45 }}
              href={runner.job?.assets[0]?.url}
              download
            >
              {t("⇩ DOWNLOAD MP4")}
            </a>
            <button className="btn" style={{ flex: 1 }} disabled={!runner.job} onClick={() => runner.cancel()}>
              {t("✕ CANCEL")}
            </button>
          </div>
          <div className="well" style={{ width: "100%", padding: "10px 12px" }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              {t("TASK")}
            </div>
            <div className="kv">
              <span>{t("path")}</span>
              <b className="truncate">{runner.job?.providerPath ?? (viaMcp ? "mcp:video_generate" : "—")}</b>
            </div>
            <div className="kv">
              <span>{t("task id")}</span>
              <b>{runner.job?.providerTaskId ?? "—"}</b>
            </div>
            <div className="kv">
              <span>{t("status")}</span>
              <b style={{ color: "var(--accent)" }}>{runner.job?.status ?? t("idle")}</b>
            </div>
            <div className="kv">
              <span>{t("reserved")}</span>
              <b>{runner.job?.estimatedCredits ?? est?.credits ?? "—"} credits</b>
            </div>
          </div>
        </div>

        {/* Right */}
        <div className="panel" style={{ alignSelf: "start" }}>
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Model Families")}</span>
          </div>
          <div className="panel-body scroll-y" style={{ paddingTop: 8, paddingBottom: 8, maxHeight: 560 }}>
            {families.length ? (
              families.map(([family, names]) => (
                <div className="provider-row" key={family}>
                  <span className="dot green" />
                  <span style={{ flex: 1 }}>
                    <b>{family}</b> · {names.length} model{names.length > 1 ? "s" : ""}
                    <div className="nav-sub truncate">{names.slice(0, 3).join(" · ")}</div>
                  </span>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <div className="nav-sub">{t("connect MCP to read the video catalogue")}</div>
              </div>
            )}
          </div>
          <div className="panel-foot">{t("Every family: submit → poll → download. Webhooks supported on the REST paths.")}</div>
        </div>
      </div>

      <div className="block-section">
        <div className="block-head">
          <h2>{t("Request")}</h2>
          <span className="meta">{t("exactly what X-Forge will send")}</span>
        </div>
        <div className="code-card">{JSON.stringify({ kind, via: viaMcp ? "mcp" : "rest", params: redactBase64(params) }, null, 2)}</div>
      </div>
    </>
  );
}
