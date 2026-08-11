"use client";

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
      toast.push("ok", action === "cancel" ? "Cancelled" : `Reconciled — ${r.outcome ?? "checked"}`);
      jobs.reload();
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
  };

  return (
    <>
      <div className="intro">
        <div>
          <h1>TASK QUEUE</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            Every job across services · the state machine, not a summary of it
          </div>
        </div>
        <div className="topbar-spacer" />
        {FILTERS.map((f) => (
          <button key={f} className={`chip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
            {f.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="dot accent" />
          <span className="panel-title">Jobs</span>
          <span style={{ flex: 1 }} />
          <div className="field" style={{ minHeight: 30, width: 230 }}>
            <input placeholder="⌕ filter by model / label / id…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <button className="chip" onClick={() => jobs.reload()}>
            ⟳ REFRESH
          </button>
        </div>
        <div className="panel-body" style={{ padding: 0, overflowX: "auto" }}>
          <table className="tbl">
            <tbody>
              <tr>
                <th>Job</th>
                <th>Endpoint</th>
                <th>Via</th>
                <th>Status</th>
                <th>Age</th>
                <th>Credits</th>
                <th>Result</th>
              </tr>
              {rows.map((j) => (
                <tr key={j.id} className="clickable" onClick={() => setOpen(open === j.id ? null : j.id)}>
                  <td>
                    <b>{j.label ?? j.modelId}</b>
                    <div className="nav-sub">{j.kind}</div>
                  </td>
                  <td className="dim truncate" style={{ maxWidth: 260 }}>
                    {j.providerPath ?? (j.via === "mcp" ? "mcp tool call" : "—")}
                  </td>
                  <td>
                    <span className="tag">{j.via}</span>
                  </td>
                  <td>
                    <span className={`badge ${badgeFor(j.status)}`}>{shortStatus(j.status)}</span>
                  </td>
                  <td className="mono">{clock(j.ageSeconds)}</td>
                  <td className="mono">{j.actualCredits ?? j.estimatedCredits ?? "—"}</td>
                  <td>
                    {j.assets.length ? (
                      <a className="chip" style={{ minHeight: 24, fontSize: 8.5 }} href={j.assets[0].url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        OPEN
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
                        RECONCILE
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
                        CANCEL
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
                      <div className="nav-sub">nothing matches this filter</div>
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
                <span>kind</span>
                <b>{detail.data.job.kind}</b>
              </div>
              <div className="kv">
                <span>model</span>
                <b>{detail.data.job.modelId}</b>
              </div>
              <div className="kv">
                <span>path</span>
                <b className="truncate">{detail.data.job.providerPath ?? "mcp"}</b>
              </div>
              <div className="kv">
                <span>provider task</span>
                <b>{detail.data.job.providerTaskId ?? "—"}</b>
              </div>
              <div className="kv">
                <span>estimate / actual</span>
                <b>
                  {detail.data.job.estimatedCredits ?? "—"} / {detail.data.job.actualCredits ?? "—"}
                </b>
              </div>
              <div className="kv">
                <span>attempt</span>
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
              <span className="panel-title">State transitions</span>
            </div>
            <div className="panel-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
              {detail.data.events.map((e) => (
                <div className="activity-row" key={e.id}>
                  <span className="dim mono">{new Date(e.at).toISOString().slice(11, 19)}</span>
                  <span className={`badge ${badgeFor(e.to_state)}`}>{shortStatus(e.to_state)}</span>
                  <span className="truncate muted">{e.detail ?? `${e.from_state ?? "—"} → ${e.to_state}`}</span>
                  <span style={{ flex: 1 }} />
                  <span className="dim">{ago(e.at)}</span>
                </div>
              ))}
            </div>
            <div className="panel-foot">
              Charging happens once, in downloading → succeeded, in the same transaction that closes the reservation.
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid cols-3" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">Polling Strategy</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="kv">
              <span>worker tick</span>
              <b>every 3 s</b>
            </div>
            <div className="kv">
              <span>on completed</span>
              <b>download into the vault</b>
            </div>
            <div className="kv">
              <span>on failed</span>
              <b>release the reservation</b>
            </div>
            <div className="kv">
              <span>on lost contact</span>
              <b>needs_recon, never a retry</b>
            </div>
            <div className="hint">A generation that may have happened is never repeated automatically.</div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">Webhook Delivery</span>
          </div>
          <div className="panel-body">
            <div className="kv">
              <span>webhook-id</span>
              <b>replay guard</b>
            </div>
            <div className="kv">
              <span>webhook-timestamp</span>
              <b>freshness window</b>
            </div>
            <div className="kv">
              <span>webhook-signature</span>
              <b>v1,sig… · HMAC-SHA256</b>
            </div>
            <div className="code-card" style={{ marginTop: 10 }}>
              {"content = `${id}.${ts}.${body}`\nsig = base64( HMAC-SHA256( secret, content ) )"}
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">Error Codes</span>
          </div>
          <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            <table className="tbl">
              <tbody>
                <tr>
                  <th>Code</th>
                  <th>What X-Forge does</th>
                </tr>
                <tr>
                  <td>
                    <span className="badge red">401</span>
                  </td>
                  <td>stops — the credential is wrong, not the request</td>
                </tr>
                <tr>
                  <td>
                    <span className="badge">404</span>
                  </td>
                  <td>terminal — the path or parameters are wrong</td>
                </tr>
                <tr>
                  <td>
                    <span className="badge amber">429</span>
                  </td>
                  <td>retries once, then terminal</td>
                </tr>
                <tr>
                  <td>
                    <span className="badge red">5xx</span>
                  </td>
                  <td>after submission → needs_recon</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
