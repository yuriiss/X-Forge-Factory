"use client";

import { useEffect, useState } from "react";
import { getJson, postJson, useJson, useToast } from "../ui";

/**
 * Flows.
 *
 * A flow is someone else's pipeline, so nothing about its form can be hardcoded: the
 * inputs come from `GET /v1/ai/flows/{sqid}` and the fields are built from whatever that
 * returns, keyed by `api_key` with the UUID accepted as a fallback. The node canvas draws
 * the flow's own steps when the definition exposes them.
 */

interface FlowSummary {
  sqid: string;
  name: string;
}

interface FlowInput {
  api_key?: string;
  id?: string;
  name?: string;
  type?: string;
  [k: string]: unknown;
}

interface FlowDetail {
  sqid: string;
  flow: Record<string, unknown>;
  inputs: FlowInput[];
  cost: number | null;
}

interface RunRecord {
  runId: string;
  status: string;
  at: string;
  raw?: unknown;
}

export default function Flows() {
  const toast = useToast();
  const [scope, setScope] = useState<"published" | "mine">("published");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [webhook, setWebhook] = useState("");
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [busy, setBusy] = useState(false);

  const list = useJson<{ flows: FlowSummary[] }>(`/api/flows?scope=${scope === "mine" ? "mine" : "published"}`, { deps: [scope] });

  useEffect(() => {
    if (!selected) return;
    setDetail(null);
    void getJson<FlowDetail>(`/api/flows/${selected}`)
      .then((d) => {
        setDetail(d);
        setValues({});
      })
      .catch((e) => toast.push("err", (e as Error).message));
  }, [selected, toast]);

  const run = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await postJson<{ run: Record<string, unknown>; runId: string }>(`/api/flows/${selected}`, {
        inputs: values,
        webhook: webhook || undefined,
      });
      setRuns((prev) => [{ runId: r.runId, status: String(r.run?.status ?? "pending"), at: new Date().toISOString(), raw: r.run }, ...prev]);
      toast.push("ok", `Run started — ${r.runId || "no id returned"}`);
    } catch (e) {
      toast.push("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const poll = async (runId: string) => {
    if (!selected) return;
    try {
      const r = await postJson<{ run: Record<string, unknown> }>(`/api/flows/${selected}`, { action: "status", runId });
      setRuns((prev) => prev.map((x) => (x.runId === runId ? { ...x, status: String(r.run?.status ?? x.status), raw: r.run } : x)));
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
  };

  const nodes = (detail?.flow?.nodes ?? detail?.flow?.steps ?? []) as { name?: string; type?: string }[];

  return (
    <>
      <div className="forge-toolbar" style={{ marginBottom: 16 }}>
        <span className="icon-tile" style={{ width: 30, height: 30 }}>
          ⌘
        </span>
        <div style={{ marginRight: 10 }}>
          <h3 style={{ letterSpacing: 2 }}>FLOWS</h3>
          <div className="nav-sub">visual pipelines built in Magnific Spaces · run over the API</div>
        </div>
        <div className="stat">
          <div className="stat-value">{list.data?.flows.length ?? 0}</div>
          <div className="stat-label">{scope === "mine" ? "MINE" : "PUBLISHED"}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{runs.length}</div>
          <div className="stat-label">RUNS</div>
        </div>
        <span style={{ flex: 1 }} />
        <button className={`chip ${scope === "published" ? "active" : ""}`} onClick={() => setScope("published")}>
          PUBLISHED
        </button>
        <button className={`chip ${scope === "mine" ? "active" : ""}`} onClick={() => setScope("mine")}>
          MINE
        </button>
        <button className="btn primary" disabled={!selected || busy} onClick={run}>
          {busy ? "◷ …" : "▷ RUN SELECTED"}
        </button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) 330px" }}>
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{detail ? String(detail.flow.name ?? selected) : "Flow"}</span>
            <span className="meta">{selected ? `SQID ${selected}` : "pick one on the right"}</span>
            <span style={{ flex: 1 }} />
            {detail?.cost ? <span className="badge amber">≈ {detail.cost} CREDITS / RUN</span> : null}
          </div>

          <div className="node-canvas" style={{ minHeight: 400 }}>
            {selected ? (
              <>
                <div className="node primary" style={{ left: 40, top: 40 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ color: "var(--accent)" }}>⊕</span>
                    <h3>Inputs · {detail?.inputs.length ?? 0}</h3>
                    <span style={{ flex: 1 }} />
                    <span className="dot green" />
                  </div>
                  <div className="nav-sub">keyed by api_key</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                    {detail?.inputs.slice(0, 2).map((i) => (
                      <span className="tag" key={String(i.api_key ?? i.id)}>
                        {String(i.api_key ?? i.name ?? "input")}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="connector" style={{ left: 135, top: 122, width: 1, height: 48 }} />
                <div className="node" style={{ left: 40, top: 170 }}>
                  <div className="node-badge">flow</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span className="muted">⌘</span>
                    <h3 className="truncate">{String(detail?.flow.name ?? "pipeline")}</h3>
                  </div>
                  <div className="nav-sub">{nodes.length ? `${nodes.length} nodes` : "server-side pipeline"}</div>
                </div>
                <div className="connector h" style={{ left: 232, top: 196, height: 1, width: 70 }} />
                <div className="node" style={{ left: 302, top: 170 }}>
                  <div className="node-badge">output</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span className="muted">▤</span>
                    <h3>Result</h3>
                  </div>
                  <div className="nav-sub">URL valid ~12 h</div>
                </div>
              </>
            ) : (
              <div className="empty-state" style={{ minHeight: 380 }}>
                <div className="empty-symbols">
                  <span>⌘</span>
                  <span>◇</span>
                  <span>▷</span>
                </div>
                <div className="empty-title">No flow selected</div>
                <div className="nav-sub">pick one from the list to see its inputs</div>
              </div>
            )}
          </div>
          <div className="panel-foot">
            GET /v1/ai/flows/&#123;sqid&#125; returns dynamic inputs and tool_metadata.total_cost · POST …/run starts one.
          </div>
        </div>

        <div className="grid" style={{ gap: 14, alignContent: "start" }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Available Flows</span>
              <span style={{ flex: 1 }} />
              <span className="chip" style={{ minHeight: 22, fontSize: 8.5 }}>
                {list.data?.flows.length ?? 0}
              </span>
            </div>
            <div className="panel-body scroll-y" style={{ display: "flex", flexDirection: "column", gap: 9, maxHeight: 320 }}>
              {list.loading ? <div className="hint">loading…</div> : null}
              {list.error ? <div className="error-box">{list.error}</div> : null}
              {list.data?.flows.map((f) => (
                <div key={f.sqid} className={`flow-item ${selected === f.sqid ? "active" : ""}`} onClick={() => setSelected(f.sqid)}>
                  <span className="icon-tile" style={{ width: 30, height: 30, fontSize: 12 }}>
                    ⌘
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-2)" }} className="truncate">
                      {f.name}
                    </div>
                    <div style={{ fontSize: 9, color: "var(--dim)" }}>{f.sqid}</div>
                  </div>
                </div>
              ))}
              {list.data && !list.data.flows.length ? (
                <div className="hint">
                  {scope === "mine" ? "nothing published from this account yet" : "no published flows returned"}
                </div>
              ) : null}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span style={{ color: "var(--accent)" }}>▷</span>
              <span className="panel-title">Run Flow</span>
              <span className="meta">POST …/run</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              {!selected ? (
                <div className="hint">Select a flow first.</div>
              ) : !detail ? (
                <div className="hint">reading inputs…</div>
              ) : detail.inputs.length ? (
                detail.inputs.map((i) => {
                  const key = String(i.api_key ?? i.id ?? i.name ?? "input");
                  return (
                    <div key={key}>
                      <div className="label">
                        {String(i.name ?? key)} · {String(i.type ?? "text")}
                      </div>
                      <div className="field">
                        <input
                          placeholder={String(i.type ?? "value")}
                          value={values[key] ?? ""}
                          onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                        />
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="hint">This flow declares no dynamic inputs — it runs as published.</div>
              )}
              <div>
                <div className="label">WEBHOOK · OPTIONAL</div>
                <div className="field">
                  <input placeholder="https://your-server.com/webhook" value={webhook} onChange={(e) => setWebhook(e.target.value)} />
                </div>
              </div>
              <button className="btn primary" style={{ width: "100%" }} disabled={!selected || busy} onClick={run}>
                {busy ? "◷ STARTING…" : `▷ RUN${detail?.cost ? ` · ≈ ${detail.cost} CREDITS` : ""}`}
              </button>
              <div className="hint">Inputs are keyed by api_key; the UUID is accepted for backward compatibility.</div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span style={{ color: "var(--accent)" }}>〜</span>
              <span className="panel-title">Runs</span>
              <span style={{ flex: 1 }} />
              <span className="chip" style={{ minHeight: 22, fontSize: 8.5 }}>
                GET runs/&#123;id&#125;
              </span>
            </div>
            <div className="panel-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
              {runs.length ? (
                runs.map((r) => (
                  <div className="activity-row" key={r.runId}>
                    <span className={`badge ${r.status === "completed" ? "green" : r.status === "failed" ? "red" : "amber"}`}>
                      {r.status.toUpperCase()}
                    </span>
                    <span className="truncate muted">{r.runId}</span>
                    <span style={{ flex: 1 }} />
                    <button className="chip" style={{ minHeight: 22, fontSize: 8.5 }} onClick={() => poll(r.runId)}>
                      POLL
                    </button>
                  </div>
                ))
              ) : (
                <div className="hint">no runs started from this console yet</div>
              )}
            </div>
            <div className="panel-foot">pending · running · completed · completed_with_errors · failed · cancelled</div>
          </div>
        </div>
      </div>
    </>
  );
}
