"use client";

import { useState } from "react";
import type { ApprovalView } from "@/lib/server/engine";

const REASONS: Record<string, string> = {
  video_generation_requires_approval: "Video generation over the threshold",
  estimate_over_threshold: "Estimate is over this account's approval threshold",
  unknown_price: "The provider could not price this call",
};

export default function ApprovalCard({ approval, jobId, token }: { approval: ApprovalView; jobId: string; token: string }) {
  const [state, setState] = useState(approval.state);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function decide(decision: "approved" | "rejected") {
    setBusy(true);
    try {
      const res = await fetch(`/api/approvals/${jobId}/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const json = (await res.json()) as { message?: string };
      setMessage(json.message ?? (res.ok ? "Done." : "That did not work."));
      setState("used");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const minutesLeft = Math.max(0, Math.round((new Date(approval.expiresAt).getTime() - Date.now()) / 60_000));

  return (
    <div className="panel" style={{ maxWidth: 620, width: "100%" }}>
      <div className="panel-head">
        <span className="dot accent" />
        <span className="panel-title">Approval required</span>
        <span style={{ flex: 1 }} />
        <span className="badge amber">{approval.kind}</span>
      </div>

      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 13 }}>
        <div>
          <h1 style={{ fontSize: 18 }}>{approval.label || approval.modelId}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {REASONS[approval.reason] ?? approval.reason}
          </div>
        </div>

        <div className="metric-row" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          <div className="stat">
            <div className="stat-value" style={{ color: "var(--accent)" }}>
              {approval.estimatedCredits ?? "?"}
            </div>
            <div className="stat-label">Estimate</div>
          </div>
          <div className="stat">
            <div className="stat-value">{approval.balance ?? "—"}</div>
            <div className="stat-label">Spendable</div>
          </div>
          <div className="stat">
            <div className="stat-value">{minutesLeft}m</div>
            <div className="stat-label">Link expires</div>
          </div>
        </div>

        <div className="well" style={{ padding: "10px 12px" }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Parameters
          </div>
          {Object.entries(approval.params)
            .filter(([k]) => !k.startsWith("__"))
            .map(([k, v]) => (
              <div className="kv" key={k}>
                <span>{k}</span>
                <b style={{ maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(v)}</b>
              </div>
            ))}
        </div>

        {state === "pending" ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" style={{ flex: 1 }} disabled={busy} onClick={() => decide("approved")}>
              {busy ? "…" : "✓ APPROVE & RUN"}
            </button>
            <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => decide("rejected")}>
              ✕ CANCEL JOB
            </button>
          </div>
        ) : (
          <div className={state === "expired" ? "error-box" : "ok-box"}>
            {message || (state === "expired" ? "This link expired." : "This link has already been used.")}
          </div>
        )}

        <div className="hint">
          Job {jobId} · one-time link · no agent can lift this gate, only a person on this page.
        </div>
      </div>
    </div>
  );
}
