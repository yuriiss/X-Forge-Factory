"use client";

import { useT } from "@/lib/i18n";
import { useMemo, useState } from "react";
import { Dropzone, Field, JobResult, Seg, useEstimate, useJobRunner, useJson, useToast, type Upload } from "../ui";

/**
 * Audio Lab.
 *
 * Four independent tools, each with its own runner so a music render and a sound effect
 * can be in flight at the same time — one shared job slot would make the panel lie about
 * which result belongs to which form. Music, SFX and isolation are REST tasks; TTS exists
 * only on the MCP session, and the voice list comes from the catalogue rather than from a
 * hardcoded handful.
 */

const MUSIC_LENGTHS = [15, 30, 60, 120] as const;
const SFX_LENGTHS = [3, 5, 10, 22] as const;

interface Catalog {
  voices: { id: string; name: string; provider?: string; gender?: string; languages?: string[] }[];
}

interface StockItem {
  id: string;
  title: string;
  meta: string;
  url: string;
  tags?: string[];
}

export default function AudioLab() {
  const t = useT();
  const toast = useToast();
  const music = useJobRunner();
  const sfx = useJobRunner();
  const isolate = useJobRunner();
  const tts = useJobRunner();

  const [musicPrompt, setMusicPrompt] = useState("Warm synthwave bed, analog pads, slow 84 BPM, nostalgic night drive");
  const [musicNegative, setMusicNegative] = useState("");
  const [musicLength, setMusicLength] = useState<(typeof MUSIC_LENGTHS)[number]>(30);
  const [musicSeed, setMusicSeed] = useState("");

  const [sfxPrompt, setSfxPrompt] = useState("Heavy vault door closing with metallic reverb");
  const [sfxLength, setSfxLength] = useState<(typeof SFX_LENGTHS)[number]>(5);

  const [audioFile, setAudioFile] = useState<Upload | null>(null);
  const [target, setTarget] = useState("lead vocal");

  const [ttsText, setTtsText] = useState("Welcome to X-Forge — the media synthesis console.");
  const [voiceId, setVoiceId] = useState("");
  const [voiceQuery, setVoiceQuery] = useState("");

  const [stockKind, setStockKind] = useState<"music" | "sfx">("music");
  const [stockQuery, setStockQuery] = useState("lofi");
  const [stockTerm, setStockTerm] = useState("lofi");

  const catalog = useJson<Catalog>("/api/catalog");
  const stock = useJson<{ items: StockItem[]; total: number | null }>(
    `/api/stock?type=${stockKind}&q=${encodeURIComponent(stockTerm)}&limit=8`,
    { deps: [stockKind, stockTerm] },
  );

  const voices = useMemo(() => {
    const all = catalog.data?.voices ?? [];
    if (!voiceQuery.trim()) return all.slice(0, 200);
    const q = voiceQuery.toLowerCase();
    return all.filter((v) => v.name.toLowerCase().includes(q) || (v.languages ?? []).some((l) => l.toLowerCase().includes(q))).slice(0, 200);
  }, [catalog.data, voiceQuery]);

  const musicParams = { prompt: musicPrompt, duration: musicLength, negative_prompt: musicNegative || undefined, seed: musicSeed || undefined };
  const musicEst = useEstimate("audio.music", musicParams, !!musicPrompt.trim());
  const ttsEst = useEstimate("audio.tts", { text: ttsText, voiceId: voiceId || undefined }, !!ttsText.trim() && !!voiceId);

  return (
    <>
      <div className="intro">
        <div>
          <h1>{t("AUDIO LAB")}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            Music generation · sound effects · SAM isolation · {catalog.data?.voices.length ?? 0} TTS voices
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1.1fr 1fr 1fr" }}>
        {/* Music */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Music Generation")}</span>
            <span style={{ flex: 1 }} />
            <span className="tag">POST /v1/ai/music-generation</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label={t("PROMPT · 10—2000 CHARS")} rows={3} value={musicPrompt} onChange={setMusicPrompt} />
            <Field label={t("NEGATIVE PROMPT")} value={musicNegative} onChange={setMusicNegative} placeholder={t("vocals, distortion, drums")} />
            <div>
              <div className="label">{t("LENGTH · SECONDS")}</div>
              <Seg options={MUSIC_LENGTHS} value={musicLength} onChange={setMusicLength} />
            </div>
            <Field label={t("SEED · OPTIONAL")} value={musicSeed} onChange={setMusicSeed} placeholder="random" />
            <button
              className="btn primary"
              style={{ width: "100%" }}
              disabled={music.busy}
              onClick={() => music.run("audio.music", musicParams, { label: musicPrompt.slice(0, 50) })}
            >
              {music.busy ? t("◷ COMPOSING…") : `${t("♫ GENERATE TRACK")} · ≈ ${musicEst?.credits ?? "?"} ${t("CR")}`}
            </button>
            <JobResult job={music.job} blocked={music.blocked} error={music.error} placeholder="♫" height={90} />
          </div>
          <div className="panel-foot">{t("Music is a task like any other — submit, poll, download into the vault.")}</div>
        </div>

        {/* SFX + isolation */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Sound Effects")}</span>
              <span style={{ flex: 1 }} />
              <span className="tag">POST /v1/ai/sound-effects</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label={t("DESCRIPTION")} rows={2} value={sfxPrompt} onChange={setSfxPrompt} />
              <div>
                <div className="label">{t("DURATION · SECONDS")}</div>
                <Seg options={SFX_LENGTHS} value={sfxLength} onChange={setSfxLength} />
              </div>
              <button
                className="btn"
                style={{ width: "100%" }}
                disabled={sfx.busy}
                onClick={() => sfx.run("audio.sfx", { prompt: sfxPrompt, duration: sfxLength }, { label: sfxPrompt.slice(0, 40) })}
              >
                {sfx.busy ? "◷ …" : t("⚡ GENERATE SFX")}
              </button>
              <JobResult job={sfx.job} blocked={sfx.blocked} error={sfx.error} placeholder="⚡" height={70} />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Audio Isolation · SAM")}</span>
              <span style={{ flex: 1 }} />
              <span className="tag">POST /v1/ai/audio-isolation</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Dropzone
                label={t("⊕ audio or video file")}
                hint={t("isolate specific sounds — vocals, engine, rain…")}
                accept="audio/*,video/*"
                value={audioFile}
                onChange={setAudioFile}
                needStaging
                minHeight={70}
              />
              <Field label={t("TARGET SOUND")} value={target} onChange={setTarget} placeholder={t("lead vocal")} />
              <button
                className="btn"
                style={{ width: "100%" }}
                disabled={isolate.busy || !audioFile}
                onClick={() => {
                  if (!audioFile) return toast.push("err", t("Drop an audio or video file first"));
                  return isolate.run(
                    "audio.isolate",
                    { audio: audioFile.assetUrl ?? audioFile.dataUrl, description: target },
                    { label: `isolate ${target}` },
                  );
                }}
              >
                {isolate.busy ? "◷ …" : t("◍ ISOLATE STEM")}
              </button>
              <JobResult job={isolate.job} blocked={isolate.blocked} error={isolate.error} placeholder="◍" height={70} />
            </div>
          </div>
        </div>

        {/* TTS */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Text to Speech")}</span>
            <span style={{ flex: 1 }} />
            <span className="badge blue">{t("MCP")}</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="hint" style={{ margin: 0 }}>
              {t("audio_tts is served by the MCP session — same credits, no extra key.")}
            </div>
            <Field label={t("TEXT")} rows={3} value={ttsText} onChange={setTtsText} />
            <Field label={t("FILTER VOICES")} value={voiceQuery} onChange={setVoiceQuery} placeholder={t("name or language…")} />
            <div>
              <div className="label">VOICE · {catalog.data?.voices.length ?? 0} IN CATALOGUE</div>
              <select className="select" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                <option value="">{t("choose a voice…")}</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.provider ? ` · ${v.provider}` : ""}
                    {v.languages?.length ? ` · ${v.languages[0]}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div className="stat" style={{ flex: 1 }}>
                <div className="stat-value">{catalog.data?.voices.length ?? 0}</div>
                <div className="stat-label">{t("VOICES")}</div>
              </div>
              <div className="stat" style={{ flex: 1 }}>
                <div className="stat-value">{ttsEst?.credits ?? "—"}</div>
                <div className="stat-label">{t("CREDITS")}</div>
              </div>
            </div>
            <button
              className="btn"
              style={{ width: "100%" }}
              disabled={tts.busy || !voiceId}
              onClick={() => tts.run("audio.tts", { text: ttsText, voiceId }, { label: ttsText.slice(0, 40), via: "mcp" })}
            >
              {tts.busy ? t("◷ SYNTHESISING…") : t("🎙 SYNTHESIZE")}
            </button>
            <JobResult job={tts.job} blocked={tts.blocked} error={tts.error} placeholder="🎙" height={70} />
          </div>
        </div>
      </div>

      <div className="block-section">
        <div className="block-head">
          <h2>{t("Audio Libraries")}</h2>
          <span className="meta">{t("stock music and sound effects — search and preview")}</span>
          <span style={{ flex: 1 }} />
          <button className={`chip ${stockKind === "music" ? "active" : ""}`} onClick={() => setStockKind("music")}>
            {t("MUSIC")}
          </button>
          <button className={`chip ${stockKind === "sfx" ? "active" : ""}`} onClick={() => setStockKind("sfx")}>
            {t("SFX")}
          </button>
        </div>
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{stockKind === "music" ? t("Stock Music") : t("SFX Library")}</span>
            <span className="meta">GET /v1/{stockKind === "music" ? "music" : "sound-effects"}</span>
            <span style={{ flex: 1 }} />
            <div className="field" style={{ minHeight: 30, width: 260 }}>
              <input
                placeholder={t("⌕ lofi, cinematic, whoosh…")}
                value={stockQuery}
                onChange={(e) => setStockQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setStockTerm(stockQuery);
                }}
              />
            </div>
            <button className="btn" onClick={() => setStockTerm(stockQuery)}>
              {t("⌕ SEARCH")}
            </button>
          </div>
          <div className="panel-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
            {stock.loading ? <div className="hint">{t("searching…")}</div> : null}
            {stock.error ? <div className="error-box">{stock.error}</div> : null}
            {stock.data?.items.map((i) => (
              <div className="provider-row" key={i.id}>
                <span className="icon-btn" style={{ width: 28, height: 28, color: "var(--accent)" }}>
                  ▶
                </span>
                <span style={{ flex: 1 }} className="truncate">
                  {i.title}
                </span>
                {i.tags?.slice(0, 1).map((tag) => (
                  <span className="tag" key={tag}>
                    {tag}
                  </span>
                ))}
                <span className="dim mono">{i.meta}</span>
              </div>
            ))}
            {stock.data && !stock.data.items.length ? <div className="hint">{t("nothing matched that search")}</div> : null}
          </div>
          <div className="panel-foot">
            {stock.data?.total ? `${stock.data.total} ${t("results in the catalogue")} · ` : ""}stock downloads follow plan rules, not credits.
          </div>
        </div>
      </div>
    </>
  );
}
