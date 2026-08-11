"use client";

import { useT } from "@/lib/i18n";
import { useState } from "react";
import { ago, num, useJson } from "../ui";
import { badgeFor, shortStatus } from "./Dashboard";

/**
 * Analytics.
 *
 * The chart is the engine's own ledger, which is exact and always available: one row per
 * job, written once, in the same transaction that closed its reservation. Magnific's team
 * analytics are Business-and-above and answer 403 otherwise — that answer is shown as what
 * it is rather than as an empty chart, because "no data" and "not entitled" are different
 * facts and only one of them is worth acting on.
 */

interface Payload {
  days: number;
  daily: { day: string; credits: number; jobs: number }[];
  byModel: { model_id: string; kind: string; uses: number; credits: number }[];
  outcomes: Record<string, number>;
  today: { credits: number; jobs: number };
  totals: { credits: number; generations: number };
  audit: { id: number; job_id: string; to_state: string; detail: string | null; at: string; kind: string; model_id: string }[];
  team: { available: boolean; reason?: string; members?: unknown };
  project: unknown;
}

export default function Analytics() {
  const t = useT();
  const [days, setDays] = useState(14);
  const a = useJson<Payload>(`/api/analytics?days=${days}`, { deps: [days], intervalMs: 30_000 });
  const max = Math.max(1, ...(a.data?.daily.map((d) => d.credits) ?? [1]));

  return (
    <>
      <div className="intro">
        <div>
          <h1>{t("ANALYTICS")}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {t("Credit consumption from the engine ledger · outcomes · audit trail")}
          </div>
        </div>
        <div className="topbar-spacer" />
        {[7, 14, 30].map((d) => (
          <button key={d} className={`chip ${days === d ? "active" : ""}`} onClick={() => setDays(d)}>
            {d} DAYS
          </button>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1.35fr 1fr" }}>
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Credit Usage")}</span>
            <span className="meta">{t("forge_credit_ledger · charged once per job")}</span>
          </div>
          <div className="panel-body">
            {a.data?.daily.length ? (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 150, padding: "0 4px" }}>
                {a.data.daily.map((d) => (
                  <div key={d.day} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 2, height: "100%" }} title={`${d.day} · ${d.credits} credits · ${d.jobs} jobs`}>
                    <div
                      style={{
                        height: `${Math.max(3, (d.credits / max) * 100)}%`,
                        width: "100%",
                        borderRadius: "3px 3px 0 0",
                        background: "linear-gradient(180deg,var(--accent-grad-a),var(--accent-grad-b))",
                      }}
                    />
                    <span className="dim" style={{ fontSize: 8.5, textAlign: "center" }}>
                      {d.day.slice(8)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state" style={{ minHeight: 150 }}>
                <div className="nav-sub">{t("nothing charged in this window yet")}</div>
              </div>
            )}

            <div className="grid cols-3" style={{ marginTop: 16, gap: 10 }}>
              <div className="stat">
                <div className="stat-value" style={{ color: "var(--accent)" }}>
                  {num(a.data?.totals.credits)}
                </div>
                <div className="stat-label">CREDITS · {days}D</div>
              </div>
              <div className="stat">
                <div className="stat-value">{num(a.data?.totals.generations)}</div>
                <div className="stat-label">{t("GENERATIONS")}</div>
              </div>
              <div className="stat">
                <div className="stat-value" style={{ color: "var(--green)" }}>
                  {num(a.data?.today.credits)}
                </div>
                <div className="stat-label">{t("TODAY")}</div>
              </div>
            </div>

            <div className="eyebrow" style={{ marginTop: 16 }}>
              {t("BY MODEL")}
            </div>
            <table className="tbl" style={{ marginTop: 6 }}>
              <tbody>
                <tr>
                  <th>{t("Model")}</th>
                  <th>{t("Family")}</th>
                  <th>{t("Uses")}</th>
                  <th>{t("Credits")}</th>
                </tr>
                {a.data?.byModel.length ? (
                  a.data.byModel.map((m) => (
                    <tr key={`${m.model_id}-${m.kind}`}>
                      <td className="truncate">{m.model_id}</td>
                      <td className="dim">{m.kind}</td>
                      <td className="mono">{m.uses}</td>
                      <td className="mono" style={{ color: "var(--accent)" }}>
                        {num(m.credits)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="dim">
                      {t("nothing charged yet")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Outcomes")}</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {Object.entries(a.data?.outcomes ?? {}).length ? (
                Object.entries(a.data!.outcomes)
                  .sort((x, y) => y[1] - x[1])
                  .map(([state, n]) => (
                    <div className="kv" key={state}>
                      <span>
                        <span className={`badge ${badgeFor(state)}`}>{shortStatus(state)}</span>
                      </span>
                      <b>{n}</b>
                    </div>
                  ))
              ) : (
                <div className="hint">{t("no jobs recorded yet")}</div>
              )}
            </div>
            <div className="panel-foot">{t("Every terminal state is counted, including the ones nobody likes to display.")}</div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Team analytics")}</span>
              <span style={{ flex: 1 }} />
              <span className={`badge ${a.data?.team.available ? "green" : "purple"}`}>
                {a.data?.team.available ? t("AVAILABLE") : t("PLAN-GATED")}
              </span>
            </div>
            <div className="panel-body">
              {a.data?.team.available ? (
                <pre className="json">{JSON.stringify(a.data.team.members, null, 2)}</pre>
              ) : (
                <div className="notice-box">
                  /v1/analytics/* is Business and Enterprise only. The provider's exact answer:
                  <div className="dim" style={{ marginTop: 6 }}>
                    {a.data?.team.reason ?? "…"}
                  </div>
                </div>
              )}
            </div>
            <div className="panel-foot">{t("100 requests per day across /v1/analytics/* · zero credit cost.")}</div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Audit trail")}</span>
              <span style={{ flex: 1 }} />
              <span className="tag">forge_job_events</span>
            </div>
            <div className="panel-body scroll-y" style={{ paddingTop: 6, paddingBottom: 6, maxHeight: 320 }}>
              {a.data?.audit.map((e) => (
                <div className="activity-row" key={e.id}>
                  <span className="dim mono">{new Date(e.at).toISOString().slice(11, 19)}</span>
                  <span className={`badge ${badgeFor(e.to_state)}`}>{shortStatus(e.to_state)}</span>
                  <span className="truncate muted">
                    {e.kind} · {e.detail ?? e.model_id}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span className="dim">{ago(e.at)}</span>
                </div>
              ))}
              {!a.data?.audit.length ? <div className="hint">{t("no events yet")}</div> : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
