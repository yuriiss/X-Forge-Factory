"use client";

import { useT } from "@/lib/i18n";
import Lightbox, { type LightboxAsset } from "./Lightbox";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * The shared client pieces.
 *
 * The prototype's markup is the contract: every control here renders the same classes it
 * did as a static mock (`.chip`, `.slider-btns`, `.toggle`, `.dropzone`), and only their
 * behaviour is new. That is why these are thin wrappers rather than a component library —
 * the styling already exists and re-inventing it would drift away from the design.
 */

/* --------------------------------------------------------------- fetching -- */

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

export async function postJson<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

export interface Loadable<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Load a URL, optionally on a timer.
 *
 * Polling is opt-in per caller because the right cadence differs: the queue wants three
 * seconds, the catalogue wants never. An in-flight request is never overlapped by the
 * timer, which is what keeps a slow endpoint from queueing up behind itself.
 */
export function useJson<T>(url: string | null, opts: { intervalMs?: number; deps?: unknown[] } = {}): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const [nonce, setNonce] = useState(0);

  const deps = opts.deps ?? [];

  useEffect(() => {
    if (!url) return;
    let alive = true;
    // The overlap guard belongs to THIS effect run, not to the component. As a ref it
    // survived React's development double-mount: the first mount set it, its cleanup
    // marked the result stale, and the second mount saw a busy flag it could never clear —
    // so the panel polled forever and rendered nothing.
    let inFlight = false;

    const run = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      try {
        const json = await getJson<T>(url);
        if (alive) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        inFlight = false;
        if (alive) setLoading(false);
      }
    };

    void run();
    if (!opts.intervalMs) return () => {
      alive = false;
    };
    const timer = setInterval(run, opts.intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, nonce, opts.intervalMs, ...deps]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

/* ----------------------------------------------------------------- toasts -- */

export interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  message: string;
}

const ToastCtx = createContext<{ push: (kind: Toast["kind"], message: string) => void }>({ push: () => {} });

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { id, kind, message }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), kind === "err" ? 9000 : 4500);
  }, []);
  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind === "err" ? "err" : toast.kind === "ok" ? "ok" : ""}`}>
            <span style={{ color: toast.kind === "err" ? "var(--red)" : toast.kind === "ok" ? "var(--green)" : "var(--accent)" }}>
              {toast.kind === "err" ? "✕" : toast.kind === "ok" ? "✓" : "◆"}
            </span>
            <span style={{ flex: 1 }}>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* --------------------------------------------------------------- controls -- */

/** The prototype's `.slider-btns` row, as a real single-choice control. */
export function Seg<T extends string | number>({
  options,
  value,
  onChange,
  wrap,
  labels,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  wrap?: boolean;
  labels?: Record<string, string>;
}) {
  return (
    <div className="slider-btns" style={wrap ? { flexWrap: "wrap", gap: 6 } : undefined}>
      {options.map((o) => (
        <span key={String(o)} className={o === value ? "active" : ""} onClick={() => onChange(o)} role="button" tabIndex={0}>
          {labels?.[String(o)] ?? String(o)}
        </span>
      ))}
    </div>
  );
}

/** The `.chip` filter row from every view's intro. */
export function Chips<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  labels?: Record<string, string>;
}) {
  return (
    <>
      {options.map((o) => (
        <button key={o} className={`chip ${o === value ? "active" : ""}`} onClick={() => onChange(o)}>
          {labels?.[o] ?? o.toUpperCase()}
        </button>
      ))}
    </>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="toggle-row" onClick={() => onChange(!on)} role="button" tabIndex={0}>
      <span>{label}</span>
      <span className={`toggle ${on ? "on" : ""}`} />
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: 1.5,
          color: "var(--dim)",
          marginBottom: 6,
        }}
      >
        <span>{label}</span>
        <span style={{ color: "var(--accent)" }}>{value > 0 && min < 0 ? `+${value}` : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step ?? 1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

/**
 * A text field that opens with a worked example in it.
 *
 * The example is prose and belongs in the reader's language, but the instant somebody
 * types, the box holds their words and no language switch may touch it. So the seed is
 * replaced only while the field still contains the seed — which is also what makes this
 * safe on first paint, where the console renders in English before it has read the stored
 * choice from the browser.
 */
export function useExample(text: string): [string, (v: string) => void] {
  const t = useT();
  const example = t(text);
  const [value, setValue] = useState(example);
  const seed = useRef(example);

  useEffect(() => {
    setValue((current) => (current === seed.current ? example : current));
    seed.current = example;
  }, [example]);

  return [value, setValue];
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  rows,
  hint,
  type,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: ReactNode;
  type?: string;
}) {
  return (
    <div>
      {label ? <div className="label">{label}</div> : null}
      <div className={rows ? "field col" : "field"}>
        {rows ? (
          <textarea rows={rows} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input type={type ?? "text"} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Select<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label?: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  hint?: ReactNode;
}) {
  return (
    <div>
      {label ? <div className="label">{label}</div> : null}
      <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------- dropzone -- */

export interface Upload {
  assetId: string;
  url: string;
  mime: string;
  bytes: number;
  kind: string;
  dataUrl: string | null;
  creationIdentifier: string | null;
  assetUrl: string | null;
  name: string;
}

/**
 * A dropzone that actually takes a file.
 *
 * One upload produces three usable forms — a local vault copy, base64 for the REST
 * endpoints, and a creation identifier for the MCP tools — because which one is needed
 * depends on the path the job will take, and asking the operator to care about that would
 * be exposing our plumbing as a feature.
 */
export function Dropzone({
  label,
  hint,
  accept,
  value,
  onChange,
  needCreation,
  needStaging,
  minHeight,
}: {
  label: string;
  hint?: string;
  accept?: string;
  value: Upload | null;
  onChange: (u: Upload | null) => void;
  needCreation?: boolean;
  needStaging?: boolean;
  minHeight?: number;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const send = useCallback(
    async (file: File) => {
      setBusy(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        if (needCreation) fd.append("creation", "1");
        if (needStaging) fd.append("staging", "1");
        const res = await fetch("/api/uploads", { method: "POST", body: fd });
        const json = (await res.json()) as {
          asset: { id: string; url: string; mime: string; bytes: number; kind: string };
          dataUrl: string | null;
          creationIdentifier: string | null;
          assetUrl: string | null;
          message?: string;
        };
        if (!res.ok) throw new Error(json.message || "upload failed");
        onChange({
          assetId: json.asset.id,
          url: json.asset.url,
          mime: json.asset.mime,
          bytes: json.asset.bytes,
          kind: json.asset.kind,
          dataUrl: json.dataUrl,
          creationIdentifier: json.creationIdentifier,
          assetUrl: json.assetUrl,
          name: file.name,
        });
      } catch (e) {
        toast.push("err", (e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [needCreation, needStaging, onChange, toast],
  );

  return (
    <div
      className={`dropzone ${value ? "has-file" : ""} ${dragging ? "dragging" : ""}`}
      style={{ minHeight: minHeight ?? 84 }}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) void send(f);
      }}
      role="button"
      tabIndex={0}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void send(f);
        }}
      />
      {busy ? (
        <>
          <span className="spinner" />
          <span style={{ fontSize: 10 }}>{t("uploading…")}</span>
        </>
      ) : value ? (
        <>
          {value.kind === "image" || value.kind === "vector" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value.url} alt={value.name} />
          ) : value.kind === "video" ? (
            <video src={value.url} muted />
          ) : (
            <span style={{ fontSize: 18 }}>♫</span>
          )}
          <span style={{ fontSize: 10, color: "var(--text-2)" }}>{value.name}</span>
          <span style={{ fontSize: 9, color: "var(--dim)" }}>
            {(value.bytes / 1024).toFixed(0)} KB
            {value.creationIdentifier ? " · creation ready" : ""}
            {value.assetUrl ? " · staged" : ""}
            {" · "}
            <span
              className="link"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            >
              remove
            </span>
          </span>
        </>
      ) : (
        <>
          <span style={{ fontSize: 11 }}>{label}</span>
          {hint ? <span style={{ fontSize: 9 }}>{hint}</span> : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ jobs -- */

export interface JobAsset {
  id: string;
  kind: string;
  mime: string;
  bytes: number;
  url: string;
}

export interface JobView {
  id: string;
  kind: string;
  label: string | null;
  modelId: string;
  status: string;
  via: string;
  estimatedCredits: number | null;
  actualCredits: number | null;
  providerTaskId: string | null;
  providerPath: string | null;
  error: string | null;
  errorCode: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  ageSeconds: number;
  assets: JobAsset[];
}

export interface SubmitAnswer {
  status: string;
  jobId: string;
  reason?: string;
  message?: string;
  estimatedCredits?: number | null;
  approveUrl?: string;
  expiresInS?: number;
  reused?: boolean;
}

const LIVE = ["created", "validating", "budget_check", "queued", "reserved", "submitted", "running", "downloading"];

/**
 * Submit a job and follow it to the end.
 *
 * Every forge view uses this, so they all behave identically: submit, watch, show the
 * result or the reason there is none. The approval case is not an error — it returns a
 * link the operator opens, and the poll keeps running so the job appears the moment the
 * gate lifts.
 */
export function useJobRunner() {
  const [job, setJob] = useState<JobView | null>(null);
  const [blocked, setBlocked] = useState<SubmitAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const t = useT();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const watch = useCallback((jobId: string) => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const { job: j } = await getJson<{ job: JobView }>(`/api/jobs/${jobId}`);
        setJob(j);
        if (!LIVE.includes(j.status)) {
          if (timer.current) clearInterval(timer.current);
          timer.current = null;
          setBusy(false);
        }
      } catch {
        /* a single failed poll is not a failed job */
      }
    }, 2500);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  const run = useCallback(
    async (kind: string, params: Record<string, unknown>, opts: { label?: string; via?: "rest" | "mcp"; preapproved?: boolean } = {}) => {
      setError(null);
      setBlocked(null);
      setJob(null);
      setBusy(true);
      try {
        const answer = await postJson<SubmitAnswer>("/api/jobs", { kind, params, ...opts });
        if (answer.status === "blocked_approval") {
          setBlocked(answer);
          toast.push("info", `Approval needed — ${answer.estimatedCredits ?? "?"} credits`);
          watch(answer.jobId);
          return answer;
        }
        if (answer.status === "rejected_budget" || answer.status === "failed") {
          setError(answer.message ?? answer.reason ?? "rejected");
          toast.push("err", answer.message ?? answer.reason ?? "rejected");
          setBusy(false);
          return answer;
        }
        if (answer.reused) toast.push("info", t("Identical request — showing the original job"));
        watch(answer.jobId);
        return answer;
      } catch (e) {
        setError((e as Error).message);
        toast.push("err", (e as Error).message);
        setBusy(false);
        return null;
      }
    },
    [toast, watch, t],
  );

  const cancel = useCallback(async () => {
    if (!job) return;
    try {
      await postJson(`/api/jobs/${job.id}`, { action: "cancel" });
      toast.push("ok", t("Job cancelled"));
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
  }, [job, toast, t]);

  return { job, blocked, error, busy, run, cancel, watch, setJob };
}

/** The estimate a form shows next to its button, refreshed as parameters change. */
export function useEstimate(kind: string, params: Record<string, unknown>, enabled = true) {
  const [est, setEst] = useState<{ credits: number | null; certainty: string; source: string; reason?: string; willNeedApproval?: boolean } | null>(null);
  const key = JSON.stringify(params);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await postJson<{ credits: number | null; certainty: string; source: string; reason?: string; willNeedApproval?: boolean }>(
          "/api/estimate",
          { kind, params },
        );
        if (alive) setEst(r);
      } catch {
        if (alive) setEst(null);
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, key, enabled]);

  return est;
}

/* --------------------------------------------------------------- results -- */

export function AssetView({ asset, height }: { asset: JobAsset; height?: number }) {
  const style = { width: "100%", height: height ? `${height}px` : "100%" } as const;
  if (asset.kind === "image" || asset.kind === "vector")
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="result-media" style={style} src={asset.url} alt="result" />;
  if (asset.kind === "video") return <video className="result-media" style={style} src={asset.url} controls playsInline />;
  if (asset.kind === "audio")
    return (
      <div style={{ padding: 16, width: "100%" }}>
        <audio style={{ width: "100%" }} src={asset.url} controls />
      </div>
    );
  return (
    <a className="link" href={asset.url} download style={{ padding: 16 }}>
      ⇩ {asset.mime} · {(asset.bytes / 1024).toFixed(0)} KB
    </a>
  );
}

const STATUS_BADGE: Record<string, string> = {
  succeeded: "green",
  failed: "red",
  rejected_budget: "red",
  cancelled: "",
  needs_recon: "purple",
  blocked_approval: "amber",
};

export function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_BADGE[status] ?? "amber";
  return <span className={`badge ${cls}`}>{status.replace(/_/g, " ").toUpperCase()}</span>;
}

/**
 * The workspace panel every forge shares: the live job, its result, and what it cost.
 *
 * It deliberately shows the same information for a failure as for a success — the state
 * it reached, the reason, and the provider task id — because "nothing happened" is the
 * least useful thing a console can say after a spend.
 */
export function JobResult({
  job,
  blocked,
  error,
  placeholder,
  height,
}: {
  job: JobView | null;
  blocked: SubmitAnswer | null;
  error: string | null;
  placeholder: string;
  height?: number;
}) {
  const t = useT();
  const live = job && LIVE.includes(job.status);
  // A result you cannot inspect at full size is a thumbnail of your own money.
  const [open, setOpen] = useState<number | null>(null);

  return (
    <>
      {error ? <div className="error-box">{error}</div> : null}

      {blocked ? (
        <div className="notice-box">
          <b style={{ color: "var(--accent)" }}>{t("Approval required")}</b> — about {blocked.estimatedCredits ?? "?"} credits.
          <br />
          <a className="link" href={blocked.approveUrl} target="_blank" rel="noreferrer">
            {blocked.approveUrl}
          </a>
          <br />
          <span className="dim">One-time link, expires in {Math.round((blocked.expiresInS ?? 900) / 60)} minutes.</span>
        </div>
      ) : null}

      <div
        className={`result-frame g2 ${job?.assets.length ? "clickable" : ""}`}
        style={{ flex: 1, minHeight: height ?? 260 }}
        title={job?.assets.length ? "Open full size" : undefined}
        onClick={() => job?.assets.length && setOpen(0)}
      >
        {job?.assets.length ? (
          <AssetView asset={job.assets[0]} />
        ) : live ? (
          <div style={{ display: "grid", placeItems: "center", gap: 10 }}>
            <span className="spinner" style={{ width: 22, height: 22 }} />
            <span className="dim" style={{ fontSize: 10, letterSpacing: 1.5 }}>
              {job?.status.toUpperCase()} · {job?.ageSeconds}s
            </span>
          </div>
        ) : (
          <span style={{ color: "rgba(232,237,245,0.35)", fontSize: 40 }}>{placeholder}</span>
        )}

        {job ? (
          <div style={{ position: "absolute", left: 10, bottom: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
            <StatusBadge status={job.status} />
            <span className="badge">{job.via.toUpperCase()}</span>
            {job.estimatedCredits !== null ? <span className="badge amber">≈{job.estimatedCredits} cr</span> : null}
            {job.assets.length > 1 ? <span className="badge">{job.assets.length} files</span> : null}
          </div>
        ) : null}
      </div>

      {job && job.assets.length > 1 ? (
        <div className="gallery" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(90px,1fr))" }}>
          {job.assets.slice(1).map((a, i) => (
            <div className="thumb zoomable clickable" key={a.id} onClick={() => setOpen(i + 1)}>
              <div className="thumb-img" style={{ height: 70 }}>
                <AssetView asset={a} height={70} />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {job?.error ? <div className="error-box">{job.errorCode}: {job.error}</div> : null}

      {open !== null && job?.assets[open] ? (
        <Lightbox
          asset={assetToLightbox(job, open)}
          onClose={() => setOpen(null)}
          onPrev={open > 0 ? () => setOpen(open - 1) : undefined}
          onNext={open < job.assets.length - 1 ? () => setOpen(open + 1) : undefined}
        />
      ) : null}
    </>
  );
}

function assetToLightbox(job: JobView, index: number): LightboxAsset {
  const a = job.assets[index];
  return { id: a.id, url: a.url, kind: a.kind, mime: a.mime, bytes: a.bytes, label: job.label ?? job.modelId, model: job.modelId };
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US").replace(/,/g, " ");
}

export function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
