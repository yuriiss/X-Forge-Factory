"use client";

import { useT } from "@/lib/i18n";
import { useState } from "react";
import { ago, clock, postJson, useJson, useToast, type JobView } from "../ui";
import { badgeFor, shortStatus } from "./Dashboard";

/**
 * Task Queue.
 *
 * Every job the engine has, with the states from the spec's machine rather than a
 * simplified traffic light — `needs_recon` in particular has to be visible and actionable,
 * because it means "this may have cost money and we do not know", and the only way out of
 * it is asking the provider what actually happened.
 */

const FILTERS = ["all", "running", "queued", "done", "failed"] as const;

export default function TaskQueue() {
  const t = useT();
  const toast = useToast();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const jobs = useJson<{ jobs: JobView[] }>(`/api/jobs?status=${filter}&limit=100`, { intervalMs: 3000, deps: [filter] });
  const detail = useJson<{ job: JobView; events: { id: number; from_state: string | null; to_state: string; detail: string | null; at: string }[] }>(
    open ? `/api/jobs/${open}` : null,
    { intervalMs: 3000, deps: [open] },
  );

  const rows = (jobs.data?.jobs ?? []).filter(
    (j) => !query || j.modelId.toLowerCase().includes(query.toLowerCase()) || (j.label ?? "").toLowerCase().includes(query.toLowerCase()) || j.id.includes(query),
  );

  const act = async (id: string, action: "cancel" | "reconcile") => {
    try {
      const r = await postJson<{ outcome?: string }>(`/api/jobs/${id}`, { action });
      toast.push("ok", action === "cancel" ? t("Cancelled") : `${t("Reconciled — ")}${r.outcome ?? t("checked")}`);
      jobs.reload();
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
  };

  return (
    <>
      <div className="intro">
        <div>
          <h1>{t("TASK QUEUE")}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {t("Every job across services · the state machine, not a summary of it")}
          </div>
        </div>
        <div className="topbar-spacer" />
        {FILTERS.map((f) => (
          <button key={f} className={`chip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
            {t(f).toUpperCase()}
          </button>
        ))}
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="dot accent" />
          <span className="panel-title">{t("Jobs")}</span>
          <span style={{ flex: 1 }} />
          <div className="field" style={{ minHeight: 30, width: 230 }}>
            <input placeholder={t("⌕ filter by model / label / id…")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <button className="chip" onClick={() => jobs.reload()}>
            {t("⟳ REFRESH")}
          </button>
        </div>
        <div className="panel-body" style={{ padding: 0, overflowX: "auto" }}>
          <table className="tbl">
            <tbody>
              <tr>
                <th>{t("Job")}</th>
                <th>{t("Endpoint")}</th>
                <th>{t("Via")}</th>
                <th>{t("Status")}</th>
                <th>{t("Age")}</th>
                <th>{t("Credits")}</th>
                <th>{t("Result")}</th>
              </tr>
              {rows.map((j) => (
                <tr key={j.id} className="clickable" onClick={() => setOpen(open === j.id ? null : j.id)}>
                  <td>
                    <b>{j.label ?? j.modelId}</b>
                    <div className="nav-sub">{j.kind}</div>
                  </td>
                  <td className="dim truncate" style={{ maxWidth: 260 }}>
                    {j.providerPath ?? (j.via === "mcp" ? t("mcp tool call") : "—")}
                  </td>
                  <td>
                    <span className="tag">{j.via}</span>
                  </td>
                  <td>
                    <span className={`badge ${badgeFor(j.status)}`}>{t(shortStatus(j.status))}</span>
                  </td>
                  <td className="mono">{clock(j.ageSeconds)}</td>
                  <td className="mono">{j.actualCredits ?? j.estimatedCredits ?? "—"}</td>
                  <td>
                    {j.assets.length ? (
                      <a className="chip" style={{ minHeight: 24, fontSize: 8.5 }} href={j.assets[0].url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        {t("OPEN")}
                      </a>
                    ) : j.status === "needs_recon" ? (
                      <button
                        className="chip active"
                        style={{ minHeight: 24, fontSize: 8.5 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          void act(j.id, "reconcile");
                        }}
                      >
                        {t("RECONCILE")}
                      </button>
                    ) : ["queued", "created", "validating", "budget_check", "reserved", "blocked_approval"].includes(j.status) ? (
                      <button
                        className="chip"
                        style={{ minHeight: 24, fontSize: 8.5 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          void act(j.id, "cancel");
                        }}
                      >
                        {t("CANCEL")}
                      </button>
                    ) : (
                      <span className="dim" style={{ fontSize: 10 }}>
                        {j.errorCode ?? "—"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">
                      <div className="nav-sub">{t("nothing matches this filter")}</div>
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="panel-foot">
          Submit → poll every 3 s → download into the vault. Provider URLs expire; the vault copy does not.
        </div>
      </div>

      {open && detail.data ? (
        <div className="grid cols-2" style={{ marginTop: 16 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Job {open}</span>
              <span style={{ flex: 1 }} />
              <span className={`badge ${badgeFor(detail.data.job.status)}`}>{detail.data.job.status}</span>
            </div>
            <div className="panel-body">
              <div className="kv">
                <span>{t("kind")}</span>
                <b>{detail.data.job.kind}</b>
              </div>
              <div className="kv">
                <span>{t("model")}</span>
                <b>{detail.data.job.modelId}</b>
              </div>
              <div className="kv">
                <span>{t("path")}</span>
                <b className="truncate">{detail.data.job.providerPath ?? "mcp"}</b>
              </div>
              <div className="kv">
                <span>{t("provider task")}</span>
                <b>{detail.data.job.providerTaskId ?? "—"}</b>
              </div>
              <div className="kv">
                <span>{t("estimate / actual")}</span>
                <b>
                  {detail.data.job.estimatedCredits ?? "—"} / {detail.data.job.actualCredits ?? "—"}
                </b>
              </div>
              <div className="kv">
                <span>{t("attempt")}</span>
                <b>
                  {detail.data.job.attempt + 1} of 2
                </b>
              </div>
              {detail.data.job.error ? <div className="error-box" style={{ marginTop: 10 }}>{detail.data.job.errorCode}: {detail.data.job.error}</div> : null}
              {detail.data.job.assets.length ? (
                <div className="gallery" style={{ marginTop: 12, gridTemplateColumns: "repeat(auto-fill,minmax(90px,1fr))" }}>
                  {detail.data.job.assets.map((a) => (
                    <a className="thumb" key={a.id} href={a.url} target="_blank" rel="noreferrer">
                      <div className="thumb-img" style={{ height: 70 }}>
                        {a.kind === "image" || a.kind === "vector" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={a.url} alt="" />
                        ) : (
                          <span>{a.kind === "video" ? "▶" : "♫"}</span>
                        )}
                      </div>
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("State transitions")}</span>
            </div>
            <div className="panel-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
              {detail.data.events.map((e) => (
                <div className="activity-row" key={e.id}>
                  <span className="dim mono">{new Date(e.at).toISOString().slice(11, 19)}</span>
                  <span className={`badge ${badgeFor(e.to_state)}`}>{t(shortStatus(e.to_state))}</span>
                  <span className="truncate muted">{e.detail ?? `${e.from_state ?? "—"} → ${e.to_state}`}</span>
                  <span style={{ flex: 1 }} />
                  <span className="dim">{ago(e.at)}</span>
                </div>
              ))}
            </div>
            <div className="panel-foot">
              {t("Charging happens once, in downloading → succeeded, in the same transaction that closes the reservation.")}
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid cols-3" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Polling Strategy")}</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="kv">
              <span>{t("worker tick")}</span>
              <b>{t("every 3 s")}</b>
            </div>
            <div className="kv">
              <span>{t("on completed")}</span>
              <b>{t("download into the vault")}</b>
            </div>
            <div className="kv">
              <span>{t("on failed")}</span>
              <b>{t("release the reservation")}</b>
            </div>
            <div className="kv">
              <span>{t("on lost contact")}</span>
              <b>{t("needs_recon, never a retry")}</b>
            </div>
            <div className="hint">{t("A generation that may have happened is never repeated automatically.")}</div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Webhook Delivery")}</span>
          </div>
          <div className="panel-body">
            <div className="kv">
              <span>{t("webhook-id")}</span>
              <b>{t("replay guard")}</b>
            </div>
            <div className="kv">
              <span>{t("webhook-timestamp")}</span>
              <b>{t("freshness window")}</b>
            </div>
            <div className="kv">
              <span>{t("webhook-signature")}</span>
              <b>{t("v1,sig… · HMAC-SHA256")}</b>
            </div>
            <div className="code-card" style={{ marginTop: 10 }}>
              {"content = `${id}.${ts}.${body}`\nsig = base64( HMAC-SHA256( secret, content ) )"}
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Error Codes")}</span>
          </div>
          <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            <table className="tbl">
              <tbody>
                <tr>
                  <th>{t("Code")}</th>
                  <th>{t("What X-Forge does")}</th>
                </tr>
                <tr>
                  <td>
                    <span className="badge red">401</span>
                  </td>
                  <td>{t("stops — the credential is wrong, not the request")}</td>
                </tr>
                <tr>
                  <td>
                    <span className="badge">404</span>
                  </td>
                  <td>{t("terminal — the path or parameters are wrong")}</td>
                </tr>
                <tr>
                  <td>
                    <span className="badge amber">429</span>
                  </td>
                  <td>{t("retries once, then terminal")}</td>
                </tr>
                <tr>
                  <td>
                    <span className="badge red">5xx</span>
                  </td>
                  <td>{t("after submission → needs_recon")}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
