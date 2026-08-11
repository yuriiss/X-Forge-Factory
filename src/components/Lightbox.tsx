"use client";

import { useT } from "@/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The full-size viewer.
 *
 * A thumbnail tells you an asset exists; it does not tell you whether the upscale actually
 * resolved the fabric or whether the 3D reconstruction closed the mesh. So every asset
 * opens here at full resolution, with the controls its kind needs: zoom and pan for
 * pictures, orbit for models, a real player for clips.
 */

export interface LightboxAsset {
  id: string;
  url: string;
  kind: string;
  mime?: string;
  bytes?: number;
  label?: string;
  model?: string;
  created?: string;
}

const MIN_SCALE = 0.15;
const MAX_SCALE = 12;

export default function Lightbox({
  asset,
  onClose,
  onPrev,
  onNext,
}: {
  asset: LightboxAsset;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const t = useT();
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragging = useRef<{ x: number; y: number } | null>(null);

  const isPicture = asset.kind === "image" || asset.kind === "vector";
  const is3d = asset.kind === "3d";

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    reset();
    setNatural(null);
  }, [asset.id, reset]);

  // Keyboard is the fastest way through a gallery, so the viewer answers to it: arrows to
  // move between assets, +/- to zoom, 0 to fit, Escape to leave.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && onPrev) onPrev();
      else if (e.key === "ArrowRight" && onNext) onNext();
      else if (e.key === "+" || e.key === "=") setScale((s) => clamp(s * 1.25));
      else if (e.key === "-" || e.key === "_") setScale((s) => clamp(s / 1.25));
      else if (e.key === "0") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, reset]);

  /**
   * Zoom towards the pointer rather than the centre — anchoring at the centre means every
   * zoom is followed by a pan to find the detail you were already looking at.
   */
  const onWheel = (e: React.WheelEvent) => {
    if (!isPicture) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left - rect.width / 2;
    const py = e.clientY - rect.top - rect.height / 2;
    setScale((prev) => {
      const next = clamp(prev * (e.deltaY < 0 ? 1.18 : 1 / 1.18));
      const k = next / prev;
      setOffset((o) => ({ x: px - (px - o.x) * k, y: py - (py - o.y) * k }));
      return next;
    });
  };

  const percent = (() => {
    const el = imgRef.current;
    if (!el || !natural) return null;
    // The element is laid out at fit size; the transform multiplies it. Reading the rect
    // would include the transform, so the base is taken from the untransformed layout box.
    const base = el.offsetWidth || 1;
    return Math.round(((base * scale) / natural.w) * 100);
  })();

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={asset.label ?? t("asset")}>
      <div className="lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-head">
          <span className="badge amber">{asset.kind.toUpperCase()}</span>
          <span className="truncate" style={{ color: "var(--text-2)", fontSize: 12, fontWeight: 700 }}>
            {asset.label ?? asset.id}
          </span>
          <span className="dim" style={{ fontSize: 10 }}>
            {asset.model ? `${asset.model} · ` : ""}
            {natural ? `${natural.w}×${natural.h} · ` : ""}
            {asset.bytes ? bytes(asset.bytes) : ""}
            {asset.mime ? ` · ${asset.mime}` : ""}
          </span>

          <span style={{ flex: 1 }} />

          {isPicture ? (
            <>
              <button className="icon-btn" title={t("Zoom out  −")} onClick={() => setScale((s) => clamp(s / 1.25))}>
                −
              </button>
              <button className="chip" style={{ minWidth: 62 }} title={t("Fit  0")} onClick={reset}>
                {percent !== null ? `${percent}%` : t("FIT")}
              </button>
              <button className="icon-btn" title={t("Zoom in  +")} onClick={() => setScale((s) => clamp(s * 1.25))}>
                +
              </button>
              <button
                className="chip"
                title={t("Actual pixels")}
                onClick={() => {
                  const el = imgRef.current;
                  if (el && natural) {
                    setScale(clamp(natural.w / (el.offsetWidth || 1)));
                    setOffset({ x: 0, y: 0 });
                  }
                }}
              >
                1:1
              </button>
            </>
          ) : null}

          <a className="icon-btn" href={asset.url} download title={t("Download")}>
            ⇩
          </a>
          <button className="icon-btn" onClick={onClose} title={t("Close  Esc")}>
            ✕
          </button>
        </div>

        <div
          className="lightbox-stage"
          onWheel={onWheel}
          onDoubleClick={() => (scale === 1 ? setScale(2) : reset())}
          onPointerDown={(e) => {
            if (!isPicture || scale <= 1) return;
            dragging.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            setOffset({ x: e.clientX - dragging.current.x, y: e.clientY - dragging.current.y });
          }}
          onPointerUp={() => {
            dragging.current = null;
          }}
          style={{ cursor: isPicture ? (scale > 1 ? "grab" : "zoom-in") : "default" }}
        >
          {isPicture ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={imgRef}
              src={asset.url}
              alt={asset.label ?? ""}
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                transformOrigin: "center",
                imageRendering: scale > 2 ? "pixelated" : "auto",
                transition: dragging.current ? "none" : "transform .08s linear",
              }}
            />
          ) : is3d ? (
            <ModelStage url={asset.url} />
          ) : asset.kind === "video" ? (
            <video src={asset.url} controls autoPlay style={{ maxWidth: "100%", maxHeight: "100%" }} />
          ) : asset.kind === "audio" ? (
            <div style={{ width: "min(560px, 90%)", textAlign: "center" }}>
              <div style={{ fontSize: 46, color: "var(--accent)", marginBottom: 18 }}>♫</div>
              <audio src={asset.url} controls autoPlay style={{ width: "100%" }} />
            </div>
          ) : (
            <a className="btn" href={asset.url} download>
              ⇩ {asset.mime ?? t("file")}
            </a>
          )}
        </div>

        <div className="lightbox-foot">
          <span className="dim">
            {isPicture ? t("scroll to zoom · drag to pan · double-click to toggle · 0 fits") : is3d ? t("drag to orbit · scroll to zoom") : ""}
          </span>
          <span style={{ flex: 1 }} />
          {onPrev ? (
            <button className="chip" onClick={onPrev}>
              {t("‹ prev")}
            </button>
          ) : null}
          {onNext ? (
            <button className="chip" onClick={onNext}>
              {t("next ›")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function clamp(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/**
 * The 3D stage.
 *
 * `model-viewer` is loaded on demand, in the browser only: it is a custom element that
 * registers itself against `window`, and it is over a megabyte — nobody visiting the
 * dashboard should pay for a viewer they never open.
 */
function ModelStage({ url }: { url: string }) {
  const t = useT();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    import("@google/model-viewer")
      .then(() => alive && setReady(true))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error-box">3D viewer failed to load: {error}</div>;
  if (!ready)
    return (
      <div style={{ display: "grid", placeItems: "center", gap: 10 }}>
        <span className="spinner" style={{ width: 22, height: 22 }} />
        <span className="dim" style={{ fontSize: 10, letterSpacing: 1.5 }}>
          {t("LOADING VIEWER")}
        </span>
      </div>
    );

  return (
    <ModelViewer
      src={url}
      camera-controls=""
      auto-rotate=""
      shadow-intensity="1"
      exposure="1.1"
      interaction-prompt="none"
      style={{ width: "100%", height: "100%", background: "transparent", "--poster-color": "transparent" } as React.CSSProperties}
    />
  );
}

/**
 * A custom element rendered from React.
 *
 * Typing `<model-viewer>` as an intrinsic element means augmenting the JSX namespace,
 * which moved between React versions; casting the tag keeps this working regardless, and
 * React 19 passes unknown props through to a custom element as attributes.
 */
export const ModelViewer = "model-viewer" as unknown as React.FC<Record<string, unknown>>;
