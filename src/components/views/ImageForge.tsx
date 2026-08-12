"use client";

import { useT } from "@/lib/i18n";
import { collect } from "@/lib/handoff";
import { useEffect, useMemo, useState } from "react";
import {
  Dropzone,
  Field,
  JobResult,
  Seg,
  Slider,
  Toggle,
  num,
  useEstimate,
  useExample,
  useJobRunner,
  useJson,
  useToast,
  type JobView,
  type Upload,
} from "../ui";
import { useNav } from "../Console";

/**
 * Image Forge.
 *
 * Two execution paths, chosen by which model the operator picked. The five models with
 * dedicated REST paths run on the key — Mystic with its full parameter set, references and
 * LoRAs included. Everything else in the catalogue runs over MCP `images_generate`, which
 * is the only way to reach it at all. The picker says which path a model uses rather than
 * hiding it, because the parameters that survive differ between them.
 */

const MYSTIC_MODELS = ["realism", "fluid", "zen", "flexible", "super_real", "editorial"] as const;
const ASPECTS = ["square_1_1", "classic_4_3", "traditional_3_4", "widescreen_16_9", "social_story_9_16", "smartphone_horizontal_20_9", "standard_3_2"] as const;
const ASPECT_LABEL: Record<string, string> = {
  square_1_1: "1:1",
  classic_4_3: "4:3",
  traditional_3_4: "3:4",
  widescreen_16_9: "16:9",
  social_story_9_16: "9:16",
  smartphone_horizontal_20_9: "20:9",
  standard_3_2: "3:2",
};
const MCP_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:4", "4:5"] as const;
const RESOLUTIONS = ["1k", "2k", "4k"] as const;
const ENGINES = ["automatic", "magnific_illusio", "magnific_sharpy", "magnific_sparkle"] as const;

interface Catalog {
  image: { slug: string; name: string; family?: string; rest?: boolean; premium?: boolean; seconds?: number }[];
  source: string;
}

interface Reference {
  id: string;
  name: string;
  type: string;
  status: string;
  origin: string;
}

const TOOLS = [
  { id: "mystic", glyph: "✦", name: "MYSTIC", kind: "image.mystic" },
  { id: "flux", glyph: "⚡", name: "FLUX", kind: "image.flux-dev" },
  { id: "seedream", glyph: "❋", name: "SEEDRM", kind: "image.seedream" },
  { id: "catalog", glyph: "▣", name: "CATLG", kind: "image.generate" },
] as const;

export default function ImageForge() {
  const t = useT();
  const { status } = useNav();
  const toast = useToast();
  const runner = useJobRunner();
  const [tool, setTool] = useState<(typeof TOOLS)[number]["id"]>("mystic");
  const [tab, setTab] = useState<"output" | "history" | "request">("output");

  const [prompt, setPrompt] = useExample("Editorial portrait of a glassblower at dusk, molten amber light, shot on 85mm");
  const [model, setModel] = useState<(typeof MYSTIC_MODELS)[number]>("realism");
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]>("square_1_1");
  const [mcpAspect, setMcpAspect] = useState<(typeof MCP_ASPECTS)[number]>("1:1");
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>("2k");
  const [engine, setEngine] = useState<(typeof ENGINES)[number]>("automatic");
  const [detailing, setDetailing] = useState(33);
  const [fixed, setFixed] = useState(false);
  const [nsfwFilter, setNsfwFilter] = useState(true);
  const [structure, setStructure] = useState<Upload | null>(null);
  const [structureStrength, setStructureStrength] = useState(50);
  const [styleRef, setStyleRef] = useState<Upload | null>(null);
  const [adherence, setAdherence] = useState(50);
  const [styleHdr, setStyleHdr] = useState(50);
  const [webhook, setWebhook] = useState("");
  const [catalogSlug, setCatalogSlug] = useState("auto");
  const [picked, setPicked] = useState<string[]>([]);

  const catalog = useJson<Catalog>("/api/catalog");
  const refs = useJson<{ references: Reference[] }>("/api/loras");
  const history = useJson<{ jobs: JobView[] }>("/api/jobs?kind=&limit=12", { intervalMs: 8000 });

  useEffect(() => {
    const handoff = collect("image-forge");
    if (handoff) {
      setPrompt(handoff.prompt);
      toast.push("ok", t("Prompt received from {from}", { from: handoff.from }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeKind = TOOLS.find((x) => x.id === tool)!.kind;
  const viaMcp = activeKind === "image.generate";

  const params = useMemo(() => {
    if (viaMcp) {
      return {
        prompt,
        slug: catalogSlug === "auto" ? undefined : catalogSlug,
        aspectRatio: mcpAspect,
      } as Record<string, unknown>;
    }
    const styling = picked.length ? { characters: picked.map((id) => ({ id: Number(id) || id })) } : undefined;
    return {
      prompt,
      aspect_ratio: aspect,
      resolution,
      ...(tool === "mystic"
        ? {
            model,
            engine,
            creative_detailing: detailing,
            fixed_generation: fixed,
            filter_nsfw: nsfwFilter,
            structure_reference: structure?.dataUrl ?? undefined,
            structure_strength: structure ? structureStrength : undefined,
            style_reference: styleRef?.dataUrl ?? undefined,
            adherence: styleRef ? adherence : undefined,
            hdr: styleRef ? styleHdr : undefined,
            styling,
          }
        : {}),
      webhook_url: webhook || undefined,
    } as Record<string, unknown>;
  }, [
    viaMcp,
    prompt,
    catalogSlug,
    mcpAspect,
    aspect,
    resolution,
    tool,
    model,
    engine,
    detailing,
    fixed,
    nsfwFilter,
    structure,
    structureStrength,
    styleRef,
    adherence,
    styleHdr,
    webhook,
    picked,
  ]);

  const est = useEstimate(activeKind, params, !!prompt.trim());

  const generate = async () => {
    if (!prompt.trim()) {
      toast.push("err", t("A prompt is required"));
      return;
    }
    await runner.run(activeKind, params, { label: prompt.slice(0, 60), via: viaMcp ? "mcp" : "rest" });
  };

  const catalogModels = catalog.data?.image ?? [];

  return (
    <>
      <div className="intro">
        <div>
          <h1>{t("IMAGE FORGE")}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {viaMcp
              ? `MCP images_generate · ${catalogModels.length} ${t("models in the live catalogue")}`
              : `POST ${restPathFor(activeKind)} · ${t("the operator's own key")}`}
          </div>
        </div>
        <div className="topbar-spacer" />
        {TOOLS.map((item) => (
          <button key={item.id} className={`chip ${tool === item.id ? "active" : ""}`} onClick={() => setTool(item.id)}>
            {item.name}
          </button>
        ))}
      </div>

      <div className="forge-wide">
        {/* Left: form */}
        <div style={{ display: "flex", gap: 10 }}>
          <div className="tool-picker">
            {TOOLS.map((item) => (
              <div
                key={item.id}
                className={`tool-pick ${tool === item.id ? "active" : ""}`}
                style={{ color: tool === item.id ? "var(--accent)" : "var(--text-3)" }}
                onClick={() => setTool(item.id)}
                role="button"
                tabIndex={0}
              >
                <span>{item.glyph}</span>
                <span>{item.name}</span>
              </div>
            ))}
          </div>

          <div className="panel" style={{ flex: 1 }}>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 13 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: "var(--accent)" }}>
                  {viaMcp ? t("TEXT → IMAGE · CATALOGUE") : `${t("TEXT → IMAGE")} · ${TOOLS.find((x) => x.id === tool)!.name}`}
                </div>
                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>
                  {viaMcp ? t("runs over the MCP session · priced before it runs") : t("runs on the REST key · webhooks supported")}
                </div>
              </div>

              <Field
                label={t("PROMPT")}
                rows={3}
                value={prompt}
                onChange={setPrompt}
                placeholder={t("Editorial portrait of a glassblower at dusk…")}
                hint={
                  tool === "mystic" ? (
                    <>
                      {t("Characters via")} <span style={{ color: "var(--accent)" }}>@name</span> {t("or")}{" "}
                      <span style={{ color: "var(--accent)" }}>@name::strength</span>.
                    </>
                  ) : undefined
                }
              />

              {viaMcp ? (
                <div>
                  <div className="label">{t("MODEL · {n} AVAILABLE", { n: catalogModels.length })}</div>
                  <select className="select" value={catalogSlug} onChange={(e) => setCatalogSlug(e.target.value)}>
                    <option value="auto">{t("auto — the server picks from the prompt")}</option>
                    {catalogModels.map((m) => (
                      <option key={m.slug} value={m.slug}>
                        {m.name}
                        {m.family ? ` · ${m.family}` : ""}
                        {m.seconds ? ` · ~${m.seconds}s` : ""}
                      </option>
                    ))}
                  </select>
                  <div className="hint">{t("Catalogue read live from images_models_list ({source}).", { source: catalog.data?.source ?? "…" })}</div>
                </div>
              ) : tool === "mystic" ? (
                <div>
                  <div className="label">{t("MODEL")}</div>
                  <Seg options={MYSTIC_MODELS} value={model} onChange={setModel} wrap />
                  <div className="hint">{t("realism — realistic palette, “less AI look”.")}</div>
                </div>
              ) : null}

              <div>
                <div className="label">{t("ASPECT RATIO")}</div>
                {viaMcp ? (
                  <Seg options={MCP_ASPECTS} value={mcpAspect} onChange={setMcpAspect} wrap />
                ) : (
                  <Seg options={ASPECTS} value={aspect} onChange={setAspect} wrap labels={ASPECT_LABEL} />
                )}
              </div>

              {!viaMcp ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div className="label">{t("RESOLUTION")}</div>
                    <Seg options={RESOLUTIONS} value={resolution} onChange={setResolution} />
                  </div>
                  {tool === "mystic" ? (
                    <div style={{ flex: 1 }}>
                      <div className="label">{t("ENGINE")}</div>
                      <select className="select" value={engine} onChange={(e) => setEngine(e.target.value as (typeof ENGINES)[number])}>
                        {ENGINES.map((e) => (
                          <option key={e} value={e}>
                            {e}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {tool === "mystic" && !viaMcp ? (
                <>
                  <Slider
                    label={t("CREATIVE DETAILING")}
                    value={detailing}
                    min={0}
                    max={100}
                    onChange={setDetailing}
                    hint={t("High values = more detail per pixel, risk of “HDR look” and stray artifacts.")}
                  />
                  <Toggle on={fixed} onChange={setFixed} label={t("FIXED GENERATION · same seed behavior")} />
                  <Toggle on={nsfwFilter} onChange={setNsfwFilter} label={t("FILTER NSFW · locked true on API")} />

                  <div className="well" style={{ padding: "10px 12px" }}>
                    <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1.5, color: "var(--accent)", marginBottom: 8 }}>
                      {t("REFERENCES & STYLE")}
                    </div>
                    <Dropzone
                      label={t("⊕ structure_reference")}
                      hint={t("shape / composition guidance")}
                      accept="image/*"
                      value={structure}
                      onChange={setStructure}
                      minHeight={64}
                    />
                    <div style={{ height: 8 }} />
                    <Slider label={t("STRUCTURE STRENGTH")} value={structureStrength} min={0} max={100} onChange={setStructureStrength} />
                    <div style={{ height: 10 }} />
                    <Dropzone
                      label={t("⊕ style_reference")}
                      hint={t("aesthetic transfer — the most powerful Mystic control")}
                      accept="image/*"
                      value={styleRef}
                      onChange={setStyleRef}
                      minHeight={64}
                    />
                    <div style={{ height: 8 }} />
                    <Slider label={t("ADHERENCE")} value={adherence} min={0} max={100} onChange={setAdherence} />
                    <div style={{ height: 8 }} />
                    <Slider label={t("STYLE HDR")} value={styleHdr} min={0} max={100} onChange={setStyleHdr} />
                    <div className="hint">{t("References disable LoRAs silently — no error is returned.")}</div>
                  </div>

                  <div className="well" style={{ padding: "10px 12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1.5, color: "var(--accent)" }}>{t("STYLING · LORA")}</span>
                      <span className="tag">GET /v1/ai/loras</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                      {refs.data?.references.length ? (
                        refs.data.references.slice(0, 8).map((r) => (
                          <button
                            key={`${r.origin}-${r.id}`}
                            className={`chip ${picked.includes(r.id) ? "active" : ""}`}
                            style={{ fontSize: 8.5 }}
                            onClick={() => setPicked((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id]))}
                          >
                            {r.name} · {r.type}
                          </button>
                        ))
                      ) : (
                        <span className="dim" style={{ fontSize: 9.5 }}>
                          {t("no trained references on this account")}
                        </span>
                      )}
                    </div>
                    <div className="hint">{t("Train new ones in 3D & Soul — LoRAs apply to the default model only.")}</div>
                  </div>

                  <Field label={t("WEBHOOK_URL · OPTIONAL")} value={webhook} onChange={setWebhook} placeholder="https://your-server.com/webhook" />
                </>
              ) : null}

              <button className="btn primary" style={{ width: "100%", marginTop: "auto" }} disabled={runner.busy} onClick={generate}>
                {runner.busy ? t("◷ WORKING…") : `${t("✦ GENERATE")} · ≈ ${est?.credits ?? "?"} ${t("CREDITS")}`}
              </button>
              {est?.willNeedApproval ? <div className="hint">{t("Over the approval threshold — a confirmation link will be issued.")}</div> : null}
              {est?.reason ? <div className="hint">{est.reason}</div> : null}
            </div>
          </div>
        </div>

        {/* Centre: workspace */}
        <div className="workspace" style={{ minHeight: 640, alignItems: "stretch", justifyContent: "flex-start", padding: 14 }}>
          <div className="tabs" style={{ marginBottom: 4 }}>
            <button className={`chip ${tab === "output" ? "active" : ""}`} onClick={() => setTab("output")}>
              {t("OUTPUT")}
            </button>
            <button className={`chip ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>
              {t("HISTORY")}
            </button>
            <button className={`chip ${tab === "request" ? "active" : ""}`} onClick={() => setTab("request")}>
              {t("REQUEST")}
            </button>
            <span style={{ flex: 1 }} />
            {runner.job ? (
              <span className="badge amber">
                {runner.job.providerTaskId ? `${runner.job.providerTaskId.slice(0, 8)}… · ` : ""}
                {runner.job.status}
              </span>
            ) : null}
          </div>

          {tab === "output" ? (
            <>
              <JobResult job={runner.job} blocked={runner.blocked} error={runner.error} placeholder="✦" height={380} />
              <div style={{ display: "flex", gap: 8 }}>
                <a
                  className="btn"
                  style={{ flex: 1, pointerEvents: runner.job?.assets.length ? "auto" : "none", opacity: runner.job?.assets.length ? 1 : 0.45 }}
                  href={runner.job?.assets[0]?.url}
                  download
                >
                  {t("⇩ DOWNLOAD")}
                </a>
                <button className="btn" style={{ flex: 1 }} disabled={!runner.job?.assets.length} onClick={() => toast.push("info", t("Open Upscale Studio and pick this asset from the vault"))}>
                  {t("⇱ UPSCALE")}
                </button>
                <button className="btn" style={{ flex: 1 }} disabled={!runner.job} onClick={() => runner.cancel()}>
                  {t("✕ CANCEL")}
                </button>
              </div>
              <div className="hint" style={{ textAlign: "center" }}>
                {t("Results are downloaded into the local vault immediately — provider URLs expire in about 24 h.")}
              </div>
            </>
          ) : tab === "history" ? (
            <div className="gallery" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(130px,1fr))" }}>
              {history.data?.jobs
                .filter((j) => j.assets.length)
                .map((j) => (
                  <div className="thumb" key={j.id} onClick={() => runner.setJob(j)}>
                    <div className="thumb-img g2" style={{ height: 100 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {j.assets[0].kind === "image" ? <img src={j.assets[0].url} alt="" /> : <span>▶</span>}
                    </div>
                    <div className="thumb-meta">
                      <div style={{ fontSize: 9.5 }} className="truncate">
                        {j.label ?? j.modelId}
                      </div>
                      <div style={{ fontSize: 8.5, color: "var(--dim)" }}>
                        {j.kind} · {j.actualCredits ?? j.estimatedCredits} cr
                      </div>
                    </div>
                  </div>
                )) ?? null}
            </div>
          ) : (
            <div className="code-card" style={{ flex: 1 }}>
              {JSON.stringify({ kind: activeKind, via: viaMcp ? "mcp" : "rest", params: redactBase64(params) }, null, 2)}
            </div>
          )}
        </div>

        {/* Right: catalogue */}
        <div className="panel" style={{ alignSelf: "start" }}>
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Model Catalog")}</span>
            <span style={{ flex: 1 }} />
            <span className="chip" style={{ minHeight: 22, fontSize: 8.5 }}>
              {catalogModels.length}
            </span>
          </div>
          <div className="panel-body scroll-y" style={{ paddingTop: 8, paddingBottom: 8, maxHeight: 620, display: "flex", flexDirection: "column", gap: 2 }}>
            {catalogModels.length ? (
              catalogModels.map((m) => (
                <div
                  className="provider-row clickable"
                  key={m.slug}
                  onClick={() => {
                    setTool("catalog");
                    setCatalogSlug(m.slug);
                  }}
                >
                  <span className={`dot ${m.rest ? "accent" : "green"}`} />
                  <span style={{ flex: 1 }} className="truncate">
                    {m.name}
                  </span>
                  <span className="dim" style={{ fontSize: 9 }}>
                    {m.rest ? "REST" : m.family ?? "mcp"}
                  </span>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <div className="nav-sub">{t("connect MCP to read the catalogue")}</div>
              </div>
            )}
          </div>
          <div className="panel-foot">
            Balance {num(status?.balance?.spendable ?? null)} · amber = has a REST path, green = MCP only.
          </div>
        </div>
      </div>
    </>
  );
}

function restPathFor(kind: string): string {
  const map: Record<string, string> = {
    "image.mystic": "/v1/ai/mystic",
    "image.flux-dev": "/v1/ai/text-to-image/flux-dev",
    "image.seedream": "/v1/ai/text-to-image/seedream-v4-5",
  };
  return map[kind] ?? "/v1/ai/…";
}

/** Base64 payloads would be megabytes in the request preview; their size is the useful part. */
export function redactBase64(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, typeof v === "string" && v.length > 200 ? `<${v.length} chars>` : v]),
  );
}
