"use client";

import { useT } from "@/lib/i18n";
import { useMemo, useState } from "react";
import { Dropzone, Field, JobResult, Seg, Slider, Toggle, useEstimate, useExample, useJobRunner, useToast, type Upload } from "../ui";

/**
 * Edit Suite.
 *
 * Eight tools that all take one image and return one image, so they share a shape: pick
 * the tool, drop the picture, fill in what that tool actually needs. The differences that
 * matter are which path a tool runs on and what form the input has to be in — relight and
 * expand accept base64 on the REST key, the rest are MCP tools that need a creation
 * identifier, and background removal refuses both and demands a publicly reachable URL.
 * The dropzone produces all three forms, so the operator never has to know which is which.
 */

type Path = "rest" | "mcp";

interface Tool {
  id: string;
  kind: string;
  glyph: string;
  title: string;
  blurb: string;
  path: Path;
  endpoint: string;
  /** Which extra controls this tool shows. */
  fields: ("prompt" | "aspect" | "light" | "style" | "size")[];
  needs: "dataUrl" | "creation" | "publicUrl";
}

const TOOLS: Tool[] = [
  {
    id: "relight",
    kind: "image.relight",
    glyph: "☀",
    title: "Relight",
    blurb: "Change the lighting of a photograph without changing what is in it.",
    path: "rest",
    endpoint: "POST /v1/ai/image-relight",
    fields: ["prompt", "light"],
    needs: "dataUrl",
  },
  {
    id: "expand",
    kind: "image.expand",
    glyph: "⇲",
    title: "Image Expand",
    blurb: "Outpaint beyond the frame — new aspect ratio, same subject.",
    path: "rest",
    endpoint: "POST /v1/ai/image-expand/flux-pro",
    fields: ["prompt", "aspect"],
    needs: "dataUrl",
  },
  {
    id: "remove-bg",
    kind: "image.remove-bg",
    glyph: "✂",
    title: "Remove Background",
    blurb: "Alpha cutout. This endpoint needs a public URL — the file is staged first.",
    path: "rest",
    endpoint: "POST /v1/ai/beta/remove-background",
    fields: [],
    needs: "publicUrl",
  },
  {
    id: "variations",
    kind: "image.variations",
    glyph: "∞",
    title: "Reimagine",
    blurb: "Variations on an existing image.",
    path: "mcp",
    endpoint: "images_variations",
    fields: ["prompt"],
    needs: "creation",
  },
  {
    id: "camera",
    kind: "image.camera",
    glyph: "⌖",
    title: "Change Camera",
    blurb: "Re-frame the shot — a new angle from one picture.",
    path: "mcp",
    endpoint: "images_change_camera",
    fields: ["prompt"],
    needs: "creation",
  },
  {
    id: "retouch",
    kind: "image.retouch",
    glyph: "✎",
    title: "Retouch",
    blurb: "Change one region and leave the rest untouched.",
    path: "mcp",
    endpoint: "images_retouch",
    fields: ["prompt"],
    needs: "creation",
  },
  {
    id: "to-svg",
    kind: "image.to-svg",
    glyph: "⌗",
    title: "Raster → SVG",
    blurb: "Vectorise a bitmap.",
    path: "mcp",
    endpoint: "images_to_svg",
    fields: [],
    needs: "creation",
  },
  {
    id: "crop",
    kind: "image.crop",
    glyph: "⊡",
    title: "Smart Crop",
    blurb: "Re-frame to an aspect ratio, keeping the subject.",
    path: "mcp",
    endpoint: "images_crop",
    fields: ["aspect"],
    needs: "creation",
  },
];

const ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"] as const;
const LIGHT_STYLES = ["smooth", "hard", "cinematic"] as const;

export default function EditSuite() {
  const t = useT();
  const toast = useToast();
  const runner = useJobRunner();
  const [toolId, setToolId] = useState("relight");
  const [image, setImage] = useState<Upload | null>(null);
  const [prompt, setPrompt] = useExample("A sunlit forest clearing at golden hour");
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]>("16:9");
  const [lightRef, setLightRef] = useState<Upload | null>(null);
  const [lightStrength, setLightStrength] = useState(100);
  const [interpolate, setInterpolate] = useState(false);
  const [changeBg, setChangeBg] = useState(true);
  const [lightStyle, setLightStyle] = useState<(typeof LIGHT_STYLES)[number]>("smooth");
  const [whites, setWhites] = useState(60);
  const [blacks, setBlacks] = useState(60);

  const tool = TOOLS.find((x) => x.id === toolId)!;

  const params = useMemo(() => {
    const p: Record<string, unknown> = {};
    if (tool.needs === "creation") p.creationIdentifier = image?.creationIdentifier;
    else if (tool.needs === "publicUrl") p.image_url = image?.assetUrl;
    else p.image = image?.dataUrl ?? image?.assetUrl;

    if (tool.fields.includes("prompt")) p.prompt = prompt || undefined;
    if (tool.fields.includes("aspect")) {
      if (tool.path === "mcp") p.aspectRatio = aspect;
      else p.aspect_ratio = aspect;
    }
    if (tool.fields.includes("light")) {
      p.transfer_light_from_reference_image = lightRef?.dataUrl ?? undefined;
      p.light_transfer_strength = lightStrength;
      p.interpolate_from_original = interpolate;
      p.change_background = changeBg;
      p.style = lightStyle;
      p.whites = whites;
      p.blacks = blacks;
    }
    return p;
  }, [tool, image, prompt, aspect, lightRef, lightStrength, interpolate, changeBg, lightStyle, whites, blacks]);

  const est = useEstimate(tool.kind, params, !!image);

  const run = async () => {
    if (!image) return toast.push("err", t("Drop an image first"));
    if (tool.needs === "creation" && !image.creationIdentifier)
      return toast.push("err", t("This tool needs an MCP creation — reconnect the MCP session and re-drop the file"));
    if (tool.needs === "publicUrl" && !image.assetUrl)
      return toast.push("err", t("This endpoint refuses base64 — the staged URL was not created, try re-dropping the file"));
    return runner.run(tool.kind, params, { label: `${t(tool.title)} · ${image.name}`, via: tool.path });
  };

  return (
    <>
      <div className="intro">
        <div>
          <h1>{t("EDIT SUITE")}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {t("Relight · expand · cutout · reimagine · camera · retouch · vectorise · crop")}
          </div>
        </div>
        <div className="topbar-spacer" />
        <span className="chip active">{t(tool.title).toUpperCase()}</span>
        <span className="chip">{tool.path.toUpperCase()}</span>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1.05fr 1fr" }}>
        {/* Form */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t(tool.title)}</span>
            <span style={{ flex: 1 }} />
            <span className="tag">{tool.endpoint}</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="hint" style={{ margin: 0 }}>
              {t(tool.blurb)}
            </div>

            <Dropzone
              label={t("⊕ image")}
              hint={
                tool.needs === "creation"
                  ? t("imported as a creation for the MCP tool")
                  : tool.needs === "publicUrl"
                    ? t("staged to a public URL — this endpoint refuses base64")
                    : t("sent inline as base64")
              }
              accept="image/*"
              value={image}
              onChange={setImage}
              needCreation
              needStaging
              minHeight={100}
            />

            {tool.fields.includes("prompt") ? <Field label={t("PROMPT")} rows={2} value={prompt} onChange={setPrompt} /> : null}

            {tool.fields.includes("aspect") ? (
              <div>
                <div className="label">{t("ASPECT RATIO")}</div>
                <Seg options={ASPECTS} value={aspect} onChange={setAspect} wrap />
              </div>
            ) : null}

            {tool.fields.includes("light") ? (
              <>
                <Dropzone
                  label={t("⊕ transfer_light_from_reference_image")}
                  hint={t("optional reference lighting")}
                  accept="image/*"
                  value={lightRef}
                  onChange={setLightRef}
                  minHeight={56}
                />
                <Slider label={t("LIGHT TRANSFER STRENGTH")} value={lightStrength} min={0} max={100} onChange={setLightStrength} />
                <Toggle on={interpolate} onChange={setInterpolate} label={t("INTERPOLATE FROM ORIGINAL")} />
                <Toggle on={changeBg} onChange={setChangeBg} label={t("CHANGE BACKGROUND")} />
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div className="label">{t("STYLE")}</div>
                    <Seg options={LIGHT_STYLES} value={lightStyle} onChange={setLightStyle} />
                  </div>
                </div>
                <Slider label={t("WHITES")} value={whites} min={0} max={100} onChange={setWhites} />
                <Slider label={t("BLACKS")} value={blacks} min={0} max={100} onChange={setBlacks} />
              </>
            ) : null}

            <button className="btn primary" style={{ width: "100%" }} disabled={runner.busy} onClick={run}>
              {runner.busy ? t("◷ WORKING…") : `${tool.glyph} ${t(tool.title).toUpperCase()} · ≈ ${est?.credits ?? "?"} CR`}
            </button>
          </div>
        </div>

        {/* Tools + workspace */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Editing Tools")}</span>
              <span style={{ flex: 1 }} />
              <span className="badge blue">{t("REST + MCP")}</span>
            </div>
            <div className="panel-body grid cols-2" style={{ gap: 10 }}>
              {TOOLS.map((tool) => (
                <div
                  key={tool.id}
                  className="surface clickable"
                  style={{ padding: 12, borderColor: tool.id === toolId ? "var(--accent)" : undefined }}
                  onClick={() => setToolId(tool.id)}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span className="icon-tile" style={{ width: 28, height: 28, fontSize: 12 }}>
                      {tool.glyph}
                    </span>
                    <b style={{ fontSize: 11.5 }}>{t(tool.title)}</b>
                    <span style={{ flex: 1 }} />
                    <span className="tag">{tool.path}</span>
                  </div>
                  <div style={{ fontSize: 9.5, color: "var(--muted)", lineHeight: 1.6 }}>{t(tool.blurb)}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Workspace")}</span>
              <span style={{ flex: 1 }} />
              {runner.job ? <span className="badge amber">{runner.job.status}</span> : null}
            </div>
            <div className="panel-body" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <JobResult job={runner.job} blocked={runner.blocked} error={runner.error} placeholder={tool.glyph} height={230} />
              <div style={{ display: "flex", gap: 8 }}>
                <a
                  className="btn"
                  style={{ flex: 1, pointerEvents: runner.job?.assets.length ? "auto" : "none", opacity: runner.job?.assets.length ? 1 : 0.45 }}
                  href={runner.job?.assets[0]?.url}
                  download
                >
                  {t("⇩ DOWNLOAD")}
                </a>
                <button className="btn" style={{ flex: 1 }} disabled={runner.busy || !image} onClick={run}>
                  {t("⟳ NEW TAKE")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
