"use client";

import { useMemo, useState } from "react";
import { Dropzone, Field, JobResult, Seg, Slider, Toggle, useEstimate, useJobRunner, useJson, useToast, type Upload } from "../ui";

/**
 * Upscale Studio.
 *
 * The flagship, and the one place where the estimate matters most: upscale cost scales
 * with OUTPUT area, so 16× on a large source is an order of magnitude more expensive than
 * 2× on a small one. `simulate_cost` returns that as a range across size tiers, and the
 * panel shows the range rather than flattening it into one confident-looking number.
 *
 * Four modes, matching the product: Creative (prompt-guided, hallucinating), Precision and
 * Precision V2 (faithful super-resolution), and Skin Enhancer (portrait retouch).
 */

const MODES = [
  { id: "creative", glyph: "✧", short: "CRTV", label: "Upscaler Creative", kind: "image.upscale", path: "/v1/ai/image-upscaler" },
  { id: "precision", glyph: "◎", short: "PRCS", label: "Precision", kind: "image.upscale", path: "/v1/ai/image-upscaler" },
  { id: "precision-v2", glyph: "◈", short: "V2", label: "Precision V2", kind: "image.upscale-precision", path: "/v1/ai/image-upscaler-precision-v2" },
  { id: "skin", glyph: "♨", short: "SKIN", label: "Skin Enhancer", kind: "image.skin", path: "/v1/ai/skin-enhancer/creative" },
] as const;

const SCALES = ["2x", "4x", "8x", "16x"] as const;
const OPTIMISED = [
  "standard",
  "soft_portraits",
  "hard_portraits",
  "art_n_illustration",
  "videogame_assets",
  "nature_n_landscapes",
  "films_n_photography",
  "3d_renders",
  "sci-fi_n_horror",
] as const;
const ENGINES = ["automatic", "magnific_illusio", "magnific_sharpy", "magnific_sparkle"] as const;
const FLAVORS = ["photo", "sublime", "photo_denoiser"] as const;

export default function UpscaleStudio() {
  const toast = useToast();
  const runner = useJobRunner();
  const [mode, setMode] = useState<(typeof MODES)[number]["id"]>("creative");
  const [image, setImage] = useState<Upload | null>(null);
  const [scale, setScale] = useState<(typeof SCALES)[number]>("4x");
  const [optimised, setOptimised] = useState<(typeof OPTIMISED)[number]>("standard");
  const [engine, setEngine] = useState<(typeof ENGINES)[number]>("automatic");
  const [prompt, setPrompt] = useState("");
  const [creativity, setCreativity] = useState(2);
  const [hdr, setHdr] = useState(1);
  const [resemblance, setResemblance] = useState(0);
  const [fractality, setFractality] = useState(-1);
  const [sharpen, setSharpen] = useState(7);
  const [grain, setGrain] = useState(7);
  const [ultraDetail, setUltraDetail] = useState(30);
  const [flavor, setFlavor] = useState<(typeof FLAVORS)[number]>("photo");
  const [nsfw, setNsfw] = useState(false);
  const [webhook, setWebhook] = useState("");
  const [view, setView] = useState<"before-after" | "side" | "output">("before-after");

  const active = MODES.find((m) => m.id === mode)!;
  const vault = useJson<{ items: { id: string; url: string; kind: string; label: string }[] }>("/api/creations?scope=vault&kind=image&per_page=8", {
    intervalMs: 20_000,
  });

  const params = useMemo(() => {
    const base: Record<string, unknown> = { image: image?.dataUrl ?? image?.assetUrl, webhook_url: webhook || undefined };
    if (mode === "precision-v2") {
      return { ...base, scale_factor: scale, sharpen, smart_grain: grain, ultra_detail: ultraDetail, flavor };
    }
    if (mode === "skin") return base;
    return {
      ...base,
      scale_factor: scale,
      optimized_for: optimised,
      engine,
      prompt: prompt || undefined,
      creativity,
      hdr,
      resemblance,
      fractality,
      filter_nsfw: nsfw,
    };
  }, [image, webhook, mode, scale, sharpen, grain, ultraDetail, flavor, optimised, engine, prompt, creativity, hdr, resemblance, fractality, nsfw]);

  // The MCP estimator prices by scale and mode; it needs a creation, which an upload has
  // only when one was requested. Passing what we have gives a range even without one.
  const est = useEstimate("image.upscale", { creationIdentifier: image?.creationIdentifier, scale, mode: mode === "creative" ? "creative" : "ultra-photo" }, true);

  const submit = async () => {
    if (!image) {
      toast.push("err", "Drop an image to upscale");
      return;
    }
    await runner.run(active.kind, params, { label: `${active.label} ${scale}`, via: "rest" });
  };

  return (
    <>
      <div className="intro">
        <div>
          <h1>UPSCALE STUDIO</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            The Magnific flagship — Creative · Precision · Precision V2 · Skin Enhancer
          </div>
        </div>
        <div className="topbar-spacer" />
        {MODES.map((m) => (
          <button key={m.id} className={`chip ${mode === m.id ? "active" : ""}`} onClick={() => setMode(m.id)}>
            {m.label.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="forge-wide">
        <div style={{ display: "flex", gap: 10 }}>
          <div className="tool-picker">
            {MODES.map((m) => (
              <div
                key={m.id}
                className={`tool-pick ${mode === m.id ? "active" : ""}`}
                style={{ color: mode === m.id ? "var(--accent)" : "var(--text-3)" }}
                onClick={() => setMode(m.id)}
                role="button"
                tabIndex={0}
              >
                <span>{m.glyph}</span>
                <span>{m.short}</span>
              </div>
            ))}
          </div>

          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 13 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: "var(--accent)" }}>{active.label.toUpperCase()}</div>
                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>POST {active.path}</div>
              </div>

              <Dropzone
                label="⇪ Drop image · or pick one from the vault below"
                hint="output cap 25.3 Mpx · send the original, no canvas re-encode"
                accept="image/*"
                value={image}
                onChange={setImage}
                needCreation
                needStaging
                minHeight={96}
              />

              {vault.data?.items.length ? (
                <div>
                  <div className="label">FROM THE VAULT</div>
                  <div className="gallery" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(56px,1fr))", gap: 6 }}>
                    {vault.data.items.map((v) => (
                      <div
                        key={v.id}
                        className="thumb"
                        title={v.label}
                        onClick={async () => {
                          // Re-uploading the vault copy is what produces the base64 and the
                          // creation id the two paths need; the file is already local, so
                          // this is a round trip through our own server, not the provider.
                          const res = await fetch(v.url);
                          const blob = await res.blob();
                          const file = new File([blob], `${v.label || "vault"}.png`, { type: blob.type });
                          const fd = new FormData();
                          fd.append("file", file);
                          fd.append("creation", "1");
                          fd.append("staging", "1");
                          const up = await fetch("/api/uploads", { method: "POST", body: fd });
                          const json = (await up.json()) as {
                            asset: { id: string; url: string; mime: string; bytes: number; kind: string };
                            dataUrl: string | null;
                            creationIdentifier: string | null;
                            assetUrl: string | null;
                          };
                          setImage({
                            assetId: json.asset.id,
                            url: json.asset.url,
                            mime: json.asset.mime,
                            bytes: json.asset.bytes,
                            kind: json.asset.kind,
                            dataUrl: json.dataUrl,
                            creationIdentifier: json.creationIdentifier,
                            assetUrl: json.assetUrl,
                            name: v.label || "vault asset",
                          });
                          toast.push("ok", "Loaded from the vault");
                        }}
                      >
                        <div className="thumb-img" style={{ height: 44 }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={v.url} alt={v.label} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {mode !== "skin" ? (
                <div>
                  <div className="label">SCALE FACTOR</div>
                  <Seg options={SCALES} value={scale} onChange={setScale} />
                </div>
              ) : null}

              {mode === "creative" || mode === "precision" ? (
                <>
                  <div>
                    <div className="label">OPTIMIZED FOR</div>
                    <select className="select" value={optimised} onChange={(e) => setOptimised(e.target.value as (typeof OPTIMISED)[number])}>
                      {OPTIMISED.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div className="label">ENGINE</div>
                    <Seg options={ENGINES} value={engine} onChange={setEngine} wrap />
                  </div>
                  <Field
                    label="PROMPT · GUIDES THE UPSCALE"
                    rows={2}
                    value={prompt}
                    onChange={setPrompt}
                    placeholder="reuse the original generation prompt for the best result"
                  />
                  <Slider label="CREATIVITY · -10 — 10" value={creativity} min={-10} max={10} onChange={setCreativity} />
                  <Slider label="HDR · DEFINITION & DETAIL" value={hdr} min={-10} max={10} onChange={setHdr} />
                  <Slider label="RESEMBLANCE · FIDELITY" value={resemblance} min={-10} max={10} onChange={setResemblance} />
                  <Slider label="FRACTALITY · PROMPT INTRICACY" value={fractality} min={-10} max={10} onChange={setFractality} />
                  <Toggle on={nsfw} onChange={setNsfw} label="FILTER NSFW · scan output" />
                </>
              ) : null}

              {mode === "precision-v2" ? (
                <>
                  <Slider label="SHARPEN · def 7" value={sharpen} min={0} max={100} onChange={setSharpen} />
                  <Slider label="SMART GRAIN · def 7" value={grain} min={0} max={100} onChange={setGrain} />
                  <Slider label="ULTRA DETAIL · def 30" value={ultraDetail} min={0} max={100} onChange={setUltraDetail} />
                  <div>
                    <div className="label">FLAVOR</div>
                    <Seg options={FLAVORS} value={flavor} onChange={setFlavor} />
                  </div>
                  <div className="hint">Faithful super-resolution — no hallucinated detail, unlike Creative.</div>
                </>
              ) : null}

              {mode === "skin" ? <div className="hint">Portrait retouch — creative, faithful and flexible variants live on the same path.</div> : null}

              <Field label="WEBHOOK_URL · OPTIONAL" value={webhook} onChange={setWebhook} placeholder="https://your-server.com/webhook" />

              <button className="btn primary" style={{ width: "100%", marginTop: "auto" }} disabled={runner.busy} onClick={submit}>
                {runner.busy ? "◷ UPSCALING…" : `⇱ UPSCALE ${mode === "skin" ? "" : scale} · ≈ ${est?.credits ?? "?"} CR`}
              </button>
              {est?.reason ? <div className="hint">{est.reason}</div> : null}
            </div>
          </div>
        </div>

        {/* Centre */}
        <div className="workspace" style={{ minHeight: 640, alignItems: "stretch", justifyContent: "flex-start", padding: 14 }}>
          <div className="tabs">
            <button className={`chip ${view === "before-after" ? "active" : ""}`} onClick={() => setView("before-after")}>
              BEFORE / AFTER
            </button>
            <button className={`chip ${view === "side" ? "active" : ""}`} onClick={() => setView("side")}>
              SIDE BY SIDE
            </button>
            <button className={`chip ${view === "output" ? "active" : ""}`} onClick={() => setView("output")}>
              OUTPUT ONLY
            </button>
            <span style={{ flex: 1 }} />
            {runner.job ? <span className="badge amber">{runner.job.status}</span> : null}
          </div>

          {view === "output" || !image ? (
            <JobResult job={runner.job} blocked={runner.blocked} error={runner.error} placeholder="⇱" height={420} />
          ) : (
            <div style={{ flex: 1, display: "grid", gridTemplateColumns: view === "side" ? "1fr 1fr" : "1fr 1fr", gap: 2, borderRadius: 8, overflow: "hidden" }}>
              <div className="result-frame g6" style={{ position: "relative" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="result-media" src={image.url} alt="input" />
                <span className="badge" style={{ position: "absolute", left: 8, top: 8 }}>
                  INPUT
                </span>
              </div>
              <div className="result-frame g1" style={{ position: "relative" }}>
                {runner.job?.assets.length ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="result-media" src={runner.job.assets[0].url} alt="output" />
                ) : runner.busy ? (
                  <span className="spinner" style={{ width: 22, height: 22 }} />
                ) : (
                  <span style={{ color: "rgba(232,237,245,0.3)", fontSize: 34 }}>✦</span>
                )}
                <span className="badge green" style={{ position: "absolute", left: 8, top: 8 }}>
                  OUTPUT
                </span>
              </div>
            </div>
          )}

          {runner.error ? <div className="error-box">{runner.error}</div> : null}
          {runner.blocked ? (
            <div className="notice-box">
              Approval required —{" "}
              <a className="link" href={runner.blocked.approveUrl} target="_blank" rel="noreferrer">
                open the link
              </a>
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8 }}>
            <a
              className="btn"
              style={{ flex: 1, pointerEvents: runner.job?.assets.length ? "auto" : "none", opacity: runner.job?.assets.length ? 1 : 0.45 }}
              href={runner.job?.assets[0]?.url}
              download
            >
              ⇩ DOWNLOAD
            </a>
            <button className="btn" style={{ flex: 1 }} disabled={runner.busy || !image} onClick={submit}>
              ⟳ RUN AGAIN
            </button>
          </div>
        </div>

        {/* Right */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, alignSelf: "start" }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Estimated Cost</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="stat">
                <div className="stat-value" style={{ color: "var(--accent)", fontSize: 22 }}>
                  {est?.credits ?? "—"}
                </div>
                <div className="stat-label">CREDITS · {est?.certainty ?? "unknown"}</div>
              </div>
              <div className="hint" style={{ margin: 0 }}>
                {est?.reason ?? "Cost scales with output area — the same factor costs far more on a large source."}
              </div>
              <div className="kv">
                <span>source</span>
                <b>{image ? `${(image.bytes / 1024).toFixed(0)} KB` : "—"}</b>
              </div>
              <div className="kv">
                <span>factor</span>
                <b>{mode === "skin" ? "n/a" : scale}</b>
              </div>
              <div className="kv">
                <span>priced by</span>
                <b>{est?.source ?? "—"}</b>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Mode Notes</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <div className="kv">
                <span>Creative</span>
                <b>invents detail · prompt-guided</b>
              </div>
              <div className="kv">
                <span>Precision</span>
                <b>faithful · engine-driven</b>
              </div>
              <div className="kv">
                <span>Precision V2</span>
                <b>sharpen · grain · ultra detail</b>
              </div>
              <div className="kv">
                <span>Skin Enhancer</span>
                <b>portrait retouch</b>
              </div>
              <div className="hint">Reusing the original generation prompt improves a creative upscale noticeably.</div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
