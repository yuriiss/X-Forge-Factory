"use client";

import { useT } from "@/lib/i18n";
import { useState } from "react";
import { Field, JobResult, Seg, useEstimate, useJobRunner, useJson, useToast } from "../ui";

/**
 * Icon Foundry.
 *
 * Two different things share this view because they answer the same question — "I need an
 * icon". `images_generate_svg` makes one that does not exist yet and costs credits; the
 * icon library is a search over Magnific's own catalogue of finished vectors and costs a
 * download allowance instead. Both are shown together so the operator can check whether
 * the icon already exists before paying to invent it.
 */

const STYLES = ["line", "flat", "glyph", "3d", "pixel"] as const;

interface IconItem {
  id: string;
  title: string;
  preview: string | null;
  meta: string;
  url: string;
}

export default function IconFoundry() {
  const t = useT();
  const toast = useToast();
  const runner = useJobRunner();
  const [prompt, setPrompt] = useState("Minimal line icon of a lighthouse inside a circle");
  const [style, setStyle] = useState<(typeof STYLES)[number]>("line");
  const [query, setQuery] = useState("anchor");
  const [term, setTerm] = useState("anchor");

  const icons = useJson<{ items: IconItem[] }>(`/api/stock?type=icons&q=${encodeURIComponent(term)}&limit=24`, { deps: [term] });
  const params = { prompt: `${prompt}, ${style} style`, style };
  const est = useEstimate("icon.generate", params, !!prompt.trim());

  return (
    <>
      <div className="intro">
        <div>
          <h1>{t("ICON FOUNDRY")}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {t("text → SVG · vector library search · downloads follow plan rules")}
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1.3fr" }}>
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Generate Icon")}</span>
            <span style={{ flex: 1 }} />
            <span className="tag">images_generate_svg</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label={t("PROMPT")} rows={2} value={prompt} onChange={setPrompt} />
            <div>
              <div className="label">{t("STYLE")}</div>
              <Seg options={STYLES} value={style} onChange={setStyle} wrap />
            </div>
            <button
              className="btn primary"
              style={{ width: "100%" }}
              disabled={runner.busy}
              onClick={() => {
                if (!prompt.trim()) return toast.push("err", t("Describe the icon first"));
                return runner.run("icon.generate", params, { label: prompt.slice(0, 50), via: "mcp" });
              }}
            >
              {runner.busy ? t("◷ DRAWING…") : `${t("✚ GENERATE SVG")} · ≈ ${est?.credits ?? "?"} ${t("CR")}`}
            </button>

            <div className="well" style={{ padding: 12 }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                {t("RESULT")}
              </div>
              <JobResult job={runner.job} blocked={runner.blocked} error={runner.error} placeholder="◉" height={180} />
              {runner.job?.assets.length ? (
                <a className="btn" href={runner.job.assets[0].url} download style={{ width: "100%", marginTop: 10 }}>
                  ⇩ DOWNLOAD {runner.job.assets[0].mime.includes("svg") ? "SVG" : "FILE"}
                </a>
              ) : null}
            </div>
            <div className="hint">{t("Vector output — scales without loss, unlike an upscaled raster icon.")}</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Icon Library")}</span>
            <span className="meta">GET /v1/icons</span>
            <span style={{ flex: 1 }} />
            <div className="field" style={{ minHeight: 30, width: 200 }}>
              <input
                placeholder={t("⌕ search icons…")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setTerm(query);
                }}
              />
            </div>
            <button className="btn" onClick={() => setTerm(query)}>
              ⌕
            </button>
          </div>
          <div className="panel-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(72px,1fr))", gap: 10 }}>
            {icons.loading ? <div className="hint">{t("searching…")}</div> : null}
            {icons.error ? <div className="error-box">{icons.error}</div> : null}
            {icons.data?.items.map((i) => (
              <a
                key={i.id}
                className="surface"
                href={i.url || undefined}
                target="_blank"
                rel="noreferrer"
                title={`${i.title} · ${i.meta}`}
                style={{ height: 72, display: "grid", placeItems: "center", cursor: "pointer", padding: 8 }}
              >
                {i.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={i.preview} alt={i.title} style={{ maxWidth: "100%", maxHeight: "100%", filter: "invert(1) brightness(1.6)" }} />
                ) : (
                  <span style={{ color: "var(--text-3)" }}>◆</span>
                )}
              </a>
            ))}
            {icons.data && !icons.data.items.length ? <div className="hint">{t("nothing matched that search")}</div> : null}
          </div>
          <div className="panel-foot">
            {t("Library icons are finished vectors — PNG / SVG / PDF. Below Business the plan caps downloads at 100 per day.")}
          </div>
        </div>
      </div>
    </>
  );
}
