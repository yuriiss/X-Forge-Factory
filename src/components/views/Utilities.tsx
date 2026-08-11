"use client";

import { useState } from "react";
import { Dropzone, Field, postJson, useToast, type Upload } from "../ui";

/**
 * Utilities.
 *
 * The endpoints that answer in words rather than files. They are cheap, rate-limited by
 * request count rather than credits, and finish in seconds — so they run inline instead of
 * going through the job engine, and a ledger entry per prompt rewrite would be noise.
 */
export default function Utilities() {
  const toast = useToast();

  const [i2pImage, setI2pImage] = useState<Upload | null>(null);
  const [i2pResult, setI2pResult] = useState("");
  const [i2pBusy, setI2pBusy] = useState(false);

  const [prompt, setPrompt] = useState("cat in space");
  const [improved, setImproved] = useState("");
  const [improveBusy, setImproveBusy] = useState(false);

  const [classifyImage, setClassifyImage] = useState<Upload | null>(null);
  const [classifyResult, setClassifyResult] = useState<Record<string, unknown> | null>(null);
  const [classifyBusy, setClassifyBusy] = useState(false);
  const [classifyError, setClassifyError] = useState<string | null>(null);

  const run = async <T,>(setBusy: (b: boolean) => void, fn: () => Promise<T>, onOk: (r: T) => void, onErr?: (m: string) => void) => {
    setBusy(true);
    try {
      onOk(await fn());
    } catch (e) {
      const m = (e as Error).message;
      if (onErr) onErr(m);
      else toast.push("err", m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="intro">
        <div>
          <h1>UTILITIES</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            image → prompt · prompt improver · AI classifier — 1 000 requests per day, no credits
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        {/* Image → prompt */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">Image → Prompt</span>
            <span style={{ flex: 1 }} />
            <span className="tag">POST /v1/ai/image-to-prompt</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Dropzone
              label="⊕ image"
              hint="reverse-engineer any picture into a reusable prompt"
              accept="image/*"
              value={i2pImage}
              onChange={setI2pImage}
              needStaging
              minHeight={84}
            />
            <button
              className="btn primary"
              style={{ width: "100%" }}
              disabled={i2pBusy || !i2pImage}
              onClick={() =>
                run(
                  setI2pBusy,
                  () => postJson<{ result: string }>("/api/utilities/image-to-prompt", { image: i2pImage?.dataUrl ?? i2pImage?.assetUrl }),
                  (r) => setI2pResult(r.result),
                )
              }
            >
              {i2pBusy ? "◷ READING…" : "⚗ DESCRIBE"}
            </button>
            {i2pResult ? (
              <div className="well" style={{ padding: "11px 12px" }}>
                <div className="eyebrow" style={{ marginBottom: 6 }}>
                  RESULT
                </div>
                <div style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.7 }}>{i2pResult}</div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    className="chip active"
                    style={{ fontSize: 8.5 }}
                    onClick={() => {
                      void navigator.clipboard.writeText(i2pResult);
                      toast.push("ok", "Copied");
                    }}
                  >
                    ⧉ COPY
                  </button>
                  <button className="chip" style={{ fontSize: 8.5 }} onClick={() => setPrompt(i2pResult)}>
                    → SEND TO IMPROVER
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Improve prompt */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">Improve Prompt</span>
            <span style={{ flex: 1 }} />
            <span className="tag">POST /v1/ai/improve-prompt</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="INPUT PROMPT" rows={3} value={prompt} onChange={setPrompt} />
            <button
              className="btn primary"
              style={{ width: "100%" }}
              disabled={improveBusy || !prompt.trim()}
              onClick={() =>
                run(
                  setImproveBusy,
                  () => postJson<{ result: string }>("/api/utilities/improve-prompt", { prompt }),
                  (r) => setImproved(r.result),
                )
              }
            >
              {improveBusy ? "◷ IMPROVING…" : "✦ IMPROVE"}
            </button>
            {improved ? (
              <div className="well" style={{ padding: "11px 12px" }}>
                <div className="eyebrow" style={{ marginBottom: 6 }}>
                  ENHANCED
                </div>
                <div style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.7 }}>{improved}</div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    className="chip active"
                    style={{ fontSize: 8.5 }}
                    onClick={() => {
                      void navigator.clipboard.writeText(improved);
                      toast.push("ok", "Copied");
                    }}
                  >
                    ⧉ COPY
                  </button>
                  <button className="chip" style={{ fontSize: 8.5 }} onClick={() => setPrompt(improved)}>
                    ⟳ IMPROVE AGAIN
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Classifier */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">AI Classifier</span>
            <span style={{ flex: 1 }} />
            <span className="tag">detect AI-generated images</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Dropzone
              label="⊕ image to verify"
              hint="moderation & compliance — class_name ∈ { ai, not_ai }"
              accept="image/*"
              value={classifyImage}
              onChange={setClassifyImage}
              needStaging
              minHeight={84}
            />
            <button
              className="btn primary"
              style={{ width: "100%" }}
              disabled={classifyBusy || !classifyImage}
              onClick={() => {
                setClassifyError(null);
                setClassifyResult(null);
                return run(
                  setClassifyBusy,
                  () => postJson<{ result: Record<string, unknown>; path: string }>("/api/utilities/classify", { image: classifyImage?.dataUrl ?? classifyImage?.assetUrl }),
                  (r) => setClassifyResult(r.result),
                  (m) => setClassifyError(m),
                );
              }}
            >
              {classifyBusy ? "◷ CLASSIFYING…" : "⚖ CLASSIFY"}
            </button>
            {classifyError ? (
              <div className="notice-box">
                No classifier endpoint answered for this key. The capability is plan-gated — this is the provider's answer, not a missing feature
                here.
                <div className="dim" style={{ marginTop: 6 }}>
                  {classifyError}
                </div>
              </div>
            ) : null}
            {classifyResult ? <pre className="json">{JSON.stringify(classifyResult, null, 2)}</pre> : null}
          </div>
        </div>

        {/* Notes */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">Rate &amp; cost</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div className="kv">
              <span>image-to-prompt</span>
              <b>1 000 requests / day</b>
            </div>
            <div className="kv">
              <span>improve-prompt</span>
              <b>1 000 requests / day</b>
            </div>
            <div className="kv">
              <span>credits</span>
              <b>none — request-limited</b>
            </div>
            <div className="kv">
              <span>runs through</span>
              <b>the same outbound shaper</b>
            </div>
            <div className="hint">
              These bypass the job engine on purpose: they finish in seconds, produce no asset, and cost nothing — a reservation and a ledger row
              per call would be bookkeeping about nothing.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
