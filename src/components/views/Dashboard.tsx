"use client";

import { useT } from "@/lib/i18n";
import { useNav } from "../Console";
import { ago, num, useJson, type JobView } from "../ui";

/**
 * The dashboard.
 *
 * Every number here is measured, not decorated: the gauge is the account's real balance
 * against its plan, the rate meters are X-Forge's own outbound counters, the queue is the
 * job table, and the activity list is the job event log. Where a number cannot be known —
 * no MCP session means no balance — it says so instead of showing a plausible one.
 */
export default function Dashboard() {
  const t = useT();
  const { status, go } = useNav();
  const jobs = useJson<{ jobs: JobView[] }>("/api/jobs?limit=8", { intervalMs: 4000 });
  const creations = useJson<{ items: { id: string; label: string; kind: string; url?: string; preview?: string | null; model?: string }[] }>(
    "/api/creations?scope=vault&per_page=6",
    { intervalMs: 15_000 },
  );
  const logs = useJson<{ events: { id: number; job_id: string; to_state: string; detail: string | null; at: string; kind: string; model_id: string }[] }>(
    "/api/logs?events=6",
    { intervalMs: 6000 },
  );

  const b = status?.balance;
  const usedPct = b?.totalPlan ? Math.round(((b.totalPlan - b.available) / b.totalPlan) * 100) : null;
  const gaugeDeg = usedPct === null ? 0 : Math.round((usedPct / 100) * 360);
  const shaper = status?.shaper;

  return (
    <>
      <div className="intro">
        <div>
          <h1>{t("DASHBOARD")}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {t("Magnific fleet overview · credit balance · task health")}
          </div>
        </div>
        <div className="topbar-spacer" />
        <span className={`chip ${status?.rest.connected ? "active" : ""}`}>
          <span className={`dot ${status?.rest.connected ? "green" : "red"}`} /> api.magnific.com
        </span>
        <span className="chip">PLAN · {(status?.balance?.tier ?? t("unknown")).toUpperCase()}</span>
        <span className="chip">{status?.mcp.connected ? t("MCP · CONNECTED") : t("MCP · OFFLINE")}</span>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1.15fr 1fr 1fr .95fr" }}>
        {/* Credits */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Credits")}</span>
            <span style={{ flex: 1 }} />
            <span className="badge amber">{(b?.tier ?? "—").toUpperCase()}</span>
          </div>
          <div className="panel-body">
            <div className="gauge-row">
              <div className="gauge">
                <div
                  className="gauge-ring"
                  style={{ background: `conic-gradient(var(--accent) 0deg, var(--accent) ${gaugeDeg}deg, var(--row-border) ${gaugeDeg}deg)` }}
                >
                  <div className="gauge-core" style={{ color: "var(--accent)" }}>
                    {usedPct ?? "—"}
                    <span className="muted" style={{ fontSize: 11 }}>
                      %
                    </span>
                  </div>
                </div>
                <div className="eyebrow">{t("PLAN CONSUMED")}</div>
              </div>
            </div>
            <div className="metric-row" style={{ marginTop: 16, gridTemplateColumns: "repeat(2,1fr)" }}>
              <div className="stat">
                <div className="stat-value" style={{ color: "var(--accent)" }}>
                  {num(b?.available)}
                </div>
                <div className="stat-label">{t("BALANCE")}</div>
              </div>
              <div className="stat">
                <div className="stat-value">{num(b?.totalPlan)}</div>
                <div className="stat-label">{t("PLAN")}</div>
              </div>
              <div className="stat">
                <div className="stat-value" style={{ color: "var(--green)" }}>
                  {num(status?.today.credits)}
                </div>
                <div className="stat-label">{t("SPENT TODAY")}</div>
              </div>
              <div className="stat">
                <div className="stat-value" style={{ color: "var(--blue)" }}>
                  {num(status?.today.jobs)}
                </div>
                <div className="stat-label">{t("JOBS TODAY")}</div>
              </div>
            </div>
            <div className="hint" style={{ marginTop: 12 }}>
              {b?.reserved ? `${num(b.reserved)} ${t("credits reserved by open jobs — spendable")} ${num(b.spendable)}.` : null}
              {!b ? t("Balance comes from the MCP session — connect it to see credits.") : t(" API calls always consume credits.")}
            </div>
          </div>
        </div>

        {/* Rate limits */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Rate Limits")}</span>
            <span style={{ flex: 1 }} />
            <span className={`badge ${(shaper?.tenantRpm ?? 0) < (shaper?.tenantLimit ?? 1) ? "green" : "red"}`}>
              {(shaper?.tenantRpm ?? 0) < (shaper?.tenantLimit ?? 1) ? t("OK") : t("THROTTLING")}
            </span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 13 }}>
            <Meter label={`${t("THIS TENANT ·")} ${shaper?.tenantLimit ?? 0} ${t("RPM")}`} value={shaper?.tenantRpm ?? 0} max={shaper?.tenantLimit ?? 1} />
            <Meter label={`${t("OUTBOUND SHAPER ·")} ${shaper?.globalLimit ?? 0} ${t("RPM")}`} value={shaper?.globalRpm ?? 0} max={shaper?.globalLimit ?? 1} green />
            <Meter label={t("BURST · 5s WINDOW")} value={shaper?.burst ?? 0} max={50} green />
            <div className="kv">
              <span>{t("provider key limit")}</span>
              <b>{t("50 req / min")}</b>
            </div>
            <div className="kv">
              <span>{t("provider IP burst")}</span>
              <b>{t("50 hits/s over 5s")}</b>
            </div>
            <div className="hint">{t("429 = back off · 401 = check header · 503 = retry with jitter")}</div>
          </div>
        </div>

        {/* Task queue */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Task Queue")}</span>
            <span style={{ flex: 1 }} />
            <button className="chip" style={{ minHeight: 24, fontSize: 8.5 }} onClick={() => go("tasks")}>
              {t("OPEN ›")}
            </button>
          </div>
          <div className="panel-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
            {jobs.data?.jobs.length ? (
              jobs.data.jobs.slice(0, 6).map((j) => (
                <div className="task-row" key={j.id}>
                  <span className={`badge ${badgeFor(j.status)}`}>{t(shortStatus(j.status))}</span>
                  <span style={{ flex: 1 }} className="truncate">
                    {j.label || j.modelId}
                  </span>
                  <span className="dim mono">{j.status === "succeeded" ? "✓" : j.status === "failed" ? "✕" : `${j.ageSeconds}s`}</span>
                </div>
              ))
            ) : (
              <div className="empty-state" style={{ minHeight: 120 }}>
                <div className="empty-symbols">
                  <span>◆</span>
                  <span>◇</span>
                  <span>◆</span>
                </div>
                <div className="nav-sub">{t("nothing has run yet")}</div>
              </div>
            )}
          </div>
          <div className="panel-foot">{t("poll every 3s · or register webhook_url per task")}</div>
        </div>

        {/* Services */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Services")}</span>
          </div>
          <div className="panel-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
            <Service ok={!!status?.rest.connected} name="REST API v1" note={status?.rest.connected ? "200" : t("no key")} />
            <Service ok={!!status?.mcp.connected} name="MCP server" note={status?.mcp.connected ? "OAuth" : t("offline")} />
            <Service ok={!!status?.rest.credential.present} name={t("Credential")} note={status?.rest.credential.present ? `…${status.rest.credential.last4}` : t("none")} />
            <Service ok={status?.tenant.status === "active"} name={t("Engine")} note={t(status?.tenant.status ?? "—")} />
            <Service ok={!!status?.tenant.videoEnabled} name={t("Video")} note={status?.tenant.videoEnabled ? t("enabled") : t("disabled")} />
            <Service ok={true} name={t("Vault")} note={`${status?.tenant.retentionDays ?? 30} ${t("d retention")}`} />
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Recent Creations")}</span>
            <span className="meta">{t("local vault")}</span>
            <span style={{ flex: 1 }} />
            <button className="chip" style={{ minHeight: 24, fontSize: 8.5 }} onClick={() => go("creations")}>
              {t("ALL ›")}
            </button>
          </div>
          <div className="panel-body">
            {creations.data?.items.length ? (
              <div className="gallery" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(110px,1fr))" }}>
                {creations.data.items.map((c) => (
                  <div className="thumb" key={c.id} onClick={() => go("creations")}>
                    <div className="thumb-img g1">
                      {c.kind === "image" || c.kind === "vector" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.url} alt={c.label} />
                      ) : c.kind === "video" ? (
                        <video src={c.url} muted />
                      ) : (
                        <span>♫</span>
                      )}
                    </div>
                    <div className="thumb-meta">
                      <div style={{ fontSize: 9.5, color: "var(--text-2)" }} className="truncate">
                        {c.label}
                      </div>
                      <div style={{ fontSize: 8.5, color: "var(--dim)" }}>{c.model}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-title">{t("Nothing forged yet")}</div>
                <div className="nav-sub">{t("generated assets are downloaded here and kept")}</div>
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Activity")}</span>
            <span style={{ flex: 1 }} />
            <span className="chip" style={{ minHeight: 24, fontSize: 8.5 }}>
              {t("job events")}
            </span>
          </div>
          <div className="panel-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
            {logs.data?.events.length ? (
              logs.data.events.map((e) => (
                <div className="activity-row" key={e.id}>
                  <span className="dim mono">{new Date(e.at).toISOString().slice(11, 19)}</span>
                  <span className={`badge ${badgeFor(e.to_state)}`}>{t(shortStatus(e.to_state))}</span>
                  <span className="truncate muted">
                    {e.kind} · {e.detail ?? e.model_id}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span className="dim">{ago(e.at)}</span>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <div className="nav-sub">{t("no events yet")}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="block-section">
        <div className="block-head">
          <h2>{t("Quick Launch")}</h2>
          <span className="meta">{t("every Magnific capability, one hop away")}</span>
        </div>
        <div className="grid cols-4">
          <Quick go={go} to="upscale" glyph="⇱" title={t("Upscale")} text="Creative · Precision V2 · Skin Enhancer — 2× to 16×." />
          <Quick go={go} to="image-forge" glyph="✦" title={t("Generate Image")} text="Mystic, FLUX, Seedream, Imagen, Nano Banana." />
          <Quick go={go} to="video-forge" glyph="▶" title={t("Generate Video")} text="Kling · Veo · Hailuo · WAN · PixVerse · Seedance." />
          <Quick go={go} to="flows" glyph="⌘" title={t("Run a Flow")} text="Published Spaces pipelines · one-call execution." />
        </div>
      </div>
    </>
  );
}

function Meter({ label, value, max, green }: { label: string; value: number; max: number; green?: boolean }) {
  const pct = Math.min(100, Math.round((value / Math.max(1, max)) * 100));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, letterSpacing: 1.5, color: "var(--dim)", marginBottom: 5 }}>
        <span>{label}</span>
        <span style={{ color: green ? "var(--green)" : "var(--accent)" }}>
          {value} / {max}
        </span>
      </div>
      <div className="bar">
        <div className={`bar-fill ${green ? "green" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Service({ ok, name, note }: { ok: boolean; name: string; note: string }) {
  return (
    <div className="provider-row">
      <span className={`dot ${ok ? "green" : ""}`} />
      <span style={{ flex: 1 }}>{name}</span>
      <span className="muted">{note}</span>
    </div>
  );
}

function Quick({ go, to, glyph, title, text }: { go: (v: string) => void; to: string; glyph: string; title: string; text: string }) {
  return (
    <div className="surface" style={{ padding: 16, cursor: "pointer", display: "flex", flexDirection: "column", gap: 9 }} onClick={() => go(to)}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="icon-tile" style={{ width: 32, height: 32 }}>
          {glyph}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 800 }}>{title}</span>
      </div>
      <div style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.6 }}>{text}</div>
    </div>
  );
}

export function badgeFor(status: string): string {
  if (status === "succeeded") return "green";
  if (status === "failed" || status === "rejected_budget") return "red";
  if (status === "queued" || status === "created" || status === "validating" || status === "budget_check") return "blue";
  if (status === "needs_recon") return "purple";
  if (status === "cancelled") return "";
  return "amber";
}

export function shortStatus(status: string): string {
  const map: Record<string, string> = {
    succeeded: "DONE",
    failed: "FAILED",
    rejected_budget: "REJECTED",
    blocked_approval: "APPROVAL",
    needs_recon: "RECON",
    downloading: "SAVING",
    submitted: "SENT",
    running: "RUNNING",
    reserved: "RESERVED",
    queued: "QUEUED",
    cancelled: "CANCELLED",
  };
  return map[status] ?? status.toUpperCase();
}
