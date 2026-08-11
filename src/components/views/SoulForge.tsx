"use client";

import { useState } from "react";
import { Dropzone, Field, JobResult, Seg, postJson, useEstimate, useJobRunner, useJson, useToast, type Upload } from "../ui";

/**
 * 3D & Soul.
 *
 * `models3d_generate` is image-to-3D, not text-to-3D — it wants a creation identifier, so
 * the dropzone imports the file as a creation before the job is submitted. That is the
 * whole reason this view exists separately from Image Forge: the input is a picture and
 * the output is a GLB, which nothing else in the console produces.
 *
 * Trained references are read from both places they can live — LoRAs on the REST key and
 * the Library on the MCP session — because an account uses one, the other, or both.
 */

const MODELS_3D = ["tripo-p1", "tripo-v31", "trellis-2"] as const;
const TEXTURES = ["none", "standard", "detailed"] as const;
const REF_TYPES = ["character", "style"] as const;
const GENDERS = ["woman", "man", "unspecified"] as const;
const QUALITIES = ["low", "medium", "high"] as const;

interface Reference {
  id: string;
  name: string;
  type: string;
  status: string;
  preview: string | null;
  origin: string;
}

export default function SoulForge() {
  const toast = useToast();
  const runner = useJobRunner();
  const [source, setSource] = useState<Upload | null>(null);
  const [model, setModel] = useState<(typeof MODELS_3D)[number]>("tripo-p1");
  const [texture, setTexture] = useState<(typeof TEXTURES)[number]>("standard");

  const [refType, setRefType] = useState<(typeof REF_TYPES)[number]>("character");
  const [refName, setRefName] = useState("");
  const [gender, setGender] = useState<(typeof GENDERS)[number]>("unspecified");
  const [quality, setQuality] = useState<(typeof QUALITIES)[number]>("medium");
  const [trainImages, setTrainImages] = useState<{ url: string; name: string }[]>([]);
  const [training, setTraining] = useState(false);

  const refs = useJson<{ references: Reference[]; library: { id: string; name: string; type: string }[] }>("/api/loras", { intervalMs: 30_000 });
  const params = { creationIdentifier: source?.creationIdentifier ?? undefined, model, textureQuality: texture };
  const est = useEstimate("model3d.generate", params, !!source?.creationIdentifier);

  const generate = async () => {
    if (!source?.creationIdentifier) {
      toast.push("err", "Drop an image first — 3D generation starts from a picture, not from text");
      return;
    }
    await runner.run("model3d.generate", params, { label: `3d · ${source.name}`, via: "mcp" });
  };

  return (
    <>
      <div className="intro">
        <div>
          <h1>3D &amp; SOUL</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            models3d_generate · trained characters and styles used by every generator
          </div>
        </div>
        <div className="topbar-spacer" />
        <span className="badge blue">MCP-POWERED</span>
      </div>

      <div className="grid cols-3">
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">Image → 3D</span>
            <span style={{ flex: 1 }} />
            <span className="tag">models3d_generate</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Dropzone
              label="⊕ source image"
              hint="a single clean subject gives the best topology"
              accept="image/*"
              value={source}
              onChange={setSource}
              needCreation
              minHeight={110}
            />
            <div>
              <div className="label">MODEL</div>
              <Seg options={MODELS_3D} value={model} onChange={setModel} wrap />
              <div className="hint">tripo-p1 is fast · tripo-v31 is higher quality · trellis-2 is a different reconstruction.</div>
            </div>
            <div>
              <div className="label">TEXTURE QUALITY</div>
              <Seg options={TEXTURES} value={texture} onChange={setTexture} />
            </div>
            <button className="btn primary" style={{ width: "100%" }} disabled={runner.busy} onClick={generate}>
              {runner.busy ? "◷ RECONSTRUCTING…" : `◈ GENERATE MODEL · ≈ ${est?.credits ?? "?"} CR`}
            </button>
            <div className="hint">Output is a GLB, downloaded into the vault like every other asset.</div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Result</span>
              <span style={{ flex: 1 }} />
              {runner.job ? <span className="badge amber">{runner.job.status}</span> : null}
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <JobResult job={runner.job} blocked={runner.blocked} error={runner.error} placeholder="◈" height={190} />
              {runner.job?.assets.length ? (
                <a className="btn" href={runner.job.assets[0].url} download style={{ width: "100%" }}>
                  ⇩ DOWNLOAD {runner.job.assets[0].mime.includes("gltf") ? "GLB" : "FILE"}
                </a>
              ) : null}
              <div className="hint">
                A GLB does not preview in a browser without a viewer — it is stored intact and opens in any 3D tool.
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Train Soul Reference</span>
              <span style={{ flex: 1 }} />
              <span className="tag">POST /v1/ai/loras/{refType === "character" ? "characters" : "styles"}</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div className="label">TYPE</div>
                <Seg options={REF_TYPES} value={refType} onChange={setRefType} />
              </div>
              <Field label="NAME" value={refName} onChange={setRefName} placeholder="john" hint="This is what you type in a prompt afterwards." />
              {refType === "character" ? (
                <div>
                  <div className="label">GENDER</div>
                  <Seg options={GENDERS} value={gender} onChange={setGender} />
                </div>
              ) : null}
              <div>
                <div className="label">QUALITY</div>
                <Seg options={QUALITIES} value={quality} onChange={setQuality} />
              </div>

              <div>
                <div className="label">TRAINING IMAGES · {trainImages.length} ADDED</div>
                <Dropzone
                  label="⊕ add a training image"
                  hint="4—12 consistent images of the same face, outfit or art style"
                  accept="image/*"
                  value={null}
                  onChange={(u) => {
                    if (u?.assetUrl) setTrainImages((prev) => [...prev, { url: u.assetUrl!, name: u.name }]);
                    else if (u) toast.push("err", "That upload was not staged — training needs hosted images");
                  }}
                  needStaging
                  minHeight={70}
                />
                {trainImages.length ? (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                    {trainImages.map((img, i) => (
                      <span key={`${img.url}-${i}`} className="chip" style={{ fontSize: 8.5 }} onClick={() => setTrainImages((p) => p.filter((_, n) => n !== i))}>
                        {img.name.slice(0, 18)} ✕
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <button
                className="btn primary"
                style={{ width: "100%" }}
                disabled={training || !refName.trim() || trainImages.length < 4}
                onClick={async () => {
                  setTraining(true);
                  try {
                    await postJson("/api/references", {
                      type: refType,
                      name: refName.trim(),
                      gender: refType === "character" ? gender : undefined,
                      quality,
                      images: trainImages.map((i) => i.url),
                    });
                    toast.push("ok", "Training started — it appears in the list when Magnific finishes");
                    setTrainImages([]);
                    refs.reload();
                  } catch (e) {
                    toast.push("err", (e as Error).message);
                  } finally {
                    setTraining(false);
                  }
                }}
              >
                {training ? "◷ STARTING…" : `✚ START TRAINING${trainImages.length < 4 ? " · NEEDS 4+ IMAGES" : ""}`}
              </button>
              <div className="hint">
                Training runs on Magnific's side and takes a while; the reference shows up below as READY when it is done.
              </div>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">Trained References</span>
            <span style={{ flex: 1 }} />
            <span className="tag">loras · library</span>
          </div>
          <div className="panel-body scroll-y" style={{ paddingTop: 8, paddingBottom: 8, maxHeight: 460 }}>
            {refs.data?.references.length ? (
              refs.data.references.map((r) => (
                <div className="provider-row" key={`${r.origin}-${r.id}`}>
                  <span
                    className="avatar"
                    style={{ background: colorFor(r.name), width: 26, height: 26, fontSize: 10 }}
                  >
                    {r.name.replace(/^@/, "").slice(0, 1).toUpperCase()}
                  </span>
                  <span style={{ flex: 1 }} className="truncate">
                    {r.name} · {r.type}
                  </span>
                  <span className={`badge ${r.status === "completed" || r.status === "ready" ? "green" : "amber"}`}>
                    {(r.status || "ready").toUpperCase()}
                  </span>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <div className="nav-sub">no trained references on this account</div>
              </div>
            )}
            {refs.data?.library.length ? (
              <>
                <div className="eyebrow" style={{ marginTop: 12, marginBottom: 6 }}>
                  LIBRARY · MCP
                </div>
                {refs.data.library.map((l) => (
                  <div className="provider-row" key={l.id}>
                    <span className="dot blue" />
                    <span style={{ flex: 1 }} className="truncate">
                      {l.name}
                    </span>
                    <span className="tag">{l.type}</span>
                  </div>
                ))}
              </>
            ) : null}
          </div>
          <div className="panel-foot">
            Use a character in a Mystic prompt as <span style={{ color: "var(--accent)" }}>@name</span> or{" "}
            <span style={{ color: "var(--accent)" }}>@name::200</span>. References override LoRAs silently.
          </div>
        </div>
      </div>
    </>
  );
}

function colorFor(name: string): string {
  const palette = ["#c96342", "#9d6be8", "#2bb0a0", "#5b8def", "#e8b64c"];
  let n = 0;
  for (const ch of name) n = (n + ch.charCodeAt(0)) % palette.length;
  return palette[n];
}
