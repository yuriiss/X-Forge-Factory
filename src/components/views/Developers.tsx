"use client";

import { useState } from "react";
import { useNav } from "../Console";
import { ago, num, postJson, useJson, useToast } from "../ui";

/**
 * Developers.
 *
 * The engine's control panel: the credential (described, never revealed), the tenant's own
 * limits, the webhook receiver with its verification record, the staging area, and the
 * reconciler. These are the controls the spec puts in the operator's hands — the credit
 * floor and the approval threshold belong to whoever's credits they are, not to us.
 */

interface Credential {
  present: boolean;
  last4?: string;
  fingerprint?: string;
  verifiedAt?: string | null;
}

interface Webhooks {
  configured: boolean;
  endpoint: string;
  deliveries: { at: string; taskId: string | null; status: string | null; verified: boolean; note: string }[];
}

export default function Developers() {
  const toast = useToast();
  const { status, reloadStatus } = useNav();
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);

  const cred = useJson<{ credential: Credential }>("/api/credentials", { intervalMs: 60_000 });
  const hooks = useJson<Webhooks>("/api/webhooks/magnific", { intervalMs: 10_000 });
  const uploads = useJson<{ files: unknown[] }>("/api/uploads?scope=staging", { intervalMs: 30_000 });

  const patchTenant = async (patch: Record<string, unknown>) => {
    try {
      await postJson("/api/tenant", patch, "PATCH");
      reloadStatus();
      toast.push("ok", "Saved");
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
  };

  const t = status?.tenant;

  return (
    <>
      <div className="intro">
        <div>
          <h1>DEVELOPERS</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            Credential · engine limits · webhook signing · staging area · reconciliation
          </div>
        </div>
        <div className="topbar-spacer" />
        <span className={`chip ${t?.status === "active" ? "active" : ""}`}>ENGINE · {(t?.status ?? "—").toUpperCase()}</span>
      </div>

      <div className="grid cols-2">
        {/* Credential */}
        <div className="panel">
          <div className="panel-head">
            <span className={`dot ${cred.data?.credential.present ? "green" : "red"}`} />
            <span className="panel-title">Magnific Credential</span>
            <span className="meta">envelope-encrypted at rest</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {cred.data?.credential.present ? (
              <>
                <div className="kv">
                  <span>key</span>
                  <b>…{cred.data.credential.last4}</b>
                </div>
                <div className="kv">
                  <span>fingerprint</span>
                  <b>{cred.data.credential.fingerprint}</b>
                </div>
                <div className="kv">
                  <span>last verified</span>
                  <b>{cred.data.credential.verifiedAt ? ago(cred.data.credential.verifiedAt) + " ago" : "not yet"}</b>
                </div>
              </>
            ) : (
              <div className="error-box">No credential stored. Nothing can run until one is saved.</div>
            )}

            <div>
              <div className="label">REPLACE KEY</div>
              <div className="field">
                <input type="password" placeholder="paste a Magnific API key" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
              </div>
              <div className="hint">
                Verified with a live call before it is stored — an invalid key is never saved, and the key itself is not returned by any endpoint
                afterwards.
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn primary"
                style={{ flex: 1 }}
                disabled={busy || newKey.trim().length < 12}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await postJson("/api/credentials", { key: newKey.trim() });
                    setNewKey("");
                    cred.reload();
                    reloadStatus();
                    toast.push("ok", "Key verified and stored");
                  } catch (e) {
                    toast.push("err", (e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                ✓ VERIFY &amp; SAVE
              </button>
              <button
                className="btn"
                style={{ flex: 1 }}
                disabled={!cred.data?.credential.present}
                onClick={async () => {
                  if (!confirm("Revoke the stored key? Queued jobs will be cancelled.")) return;
                  await postJson("/api/credentials", undefined, "DELETE");
                  cred.reload();
                  reloadStatus();
                  toast.push("ok", "Credential revoked, queue cancelled");
                }}
              >
                ✕ REVOKE
              </button>
            </div>
          </div>
          <div className="panel-foot">
            Per-tenant DEK, master key from the environment. Revocation erases the ciphertext immediately and cancels queued work.
          </div>
        </div>

        {/* Engine limits */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">Engine Limits</span>
            <span className="meta">yours to set</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            <NumberRow label="APPROVAL THRESHOLD · CREDITS" value={t?.approvalThreshold ?? 0} onSave={(v) => patchTenant({ approval_threshold: v })} hint="Above this, a job waits for a human on a one-time link." />
            <NumberRow label="CREDIT FLOOR" value={t?.creditFloor ?? 0} onSave={(v) => patchTenant({ credit_floor: v })} hint="A job that would drop the balance below this is rejected, never downgraded." />
            <NumberRow label="MAX CONCURRENT JOBS" value={t?.maxConcurrentJobs ?? 0} onSave={(v) => patchTenant({ max_concurrent_jobs: v })} />
            <NumberRow label="RPM LIMIT" value={t?.rpmLimit ?? 0} onSave={(v) => patchTenant({ rpm_limit: v })} hint="Your own ceiling, under the provider's 50 per key." />
            <NumberRow label="RETENTION · DAYS" value={t?.retentionDays ?? 0} onSave={(v) => patchTenant({ retention_days: v })} />

            <div className="toggle-row" onClick={() => patchTenant({ video_enabled: !t?.videoEnabled })} role="button" tabIndex={0}>
              <span>VIDEO GENERATION</span>
              <span className={`toggle ${t?.videoEnabled ? "on" : ""}`} />
            </div>

            {t?.status === "safe_mode" ? (
              <div className="error-box">
                The reconciler parked this tenant in safe_mode — new jobs are refused.
                <button className="btn" style={{ width: "100%", marginTop: 8 }} onClick={() => patchTenant({ status: "active" })}>
                  ↺ RESUME
                </button>
              </div>
            ) : null}

            <button
              className="btn"
              style={{ width: "100%" }}
              onClick={async () => {
                try {
                  const r = await postJson<{ message: string }>("/api/reconcile", {});
                  toast.push("ok", r.message);
                  reloadStatus();
                } catch (e) {
                  toast.push("err", (e as Error).message);
                }
              }}
            >
              ⟳ RECONCILE NOW
            </button>
          </div>
          <div className="panel-foot">
            Drift past the threshold moves this tenant to safe_mode: running work finishes, nothing new starts, and only a human resumes it.
          </div>
        </div>

        {/* Webhooks */}
        <div className="panel">
          <div className="panel-head">
            <span className={`dot ${hooks.data?.configured ? "green" : ""}`} />
            <span className="panel-title">Webhook Receiver</span>
            <span style={{ flex: 1 }} />
            <span className={`badge ${hooks.data?.configured ? "green" : "amber"}`}>
              {hooks.data?.configured ? "SIGNING SECRET SET" : "NO SECRET"}
            </span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div className="label">RECEIVER URL · pass as webhook_url on any job</div>
              <div className="field">
                <input readOnly value={hooks.data?.endpoint ?? ""} />
                <button
                  className="icon-btn"
                  style={{ border: 0 }}
                  onClick={() => {
                    void navigator.clipboard.writeText(hooks.data?.endpoint ?? "");
                    toast.push("ok", "Copied");
                  }}
                >
                  ⧉
                </button>
              </div>
            </div>
            <div className="code-card">
              {"// every delivery is verified before it is trusted\ncontent = `${webhook_id}.${webhook_timestamp}.${body}`\nsig     = base64( hmac_sha256( secret, content ) )\n// header carries \"v1,sig1 v2,sig2\" — ANY match passes\nok = header.split(' ').some(s => s.split(',')[1] === sig)"}
            </div>
            <div>
              <div className="eyebrow" style={{ marginBottom: 6 }}>
                DELIVERIES
              </div>
              {hooks.data?.deliveries.length ? (
                hooks.data.deliveries.slice(0, 8).map((d, i) => (
                  <div className="activity-row" key={`${d.at}-${i}`}>
                    <span className="dim mono">{new Date(d.at).toISOString().slice(11, 19)}</span>
                    <span className={`badge ${d.verified ? "green" : "red"}`}>{d.verified ? "VERIFIED" : "REJECTED"}</span>
                    <span className="truncate muted">
                      {d.taskId ?? "?"} · {d.status ?? d.note}
                    </span>
                  </div>
                ))
              ) : (
                <div className="hint">nothing delivered yet — pass the receiver URL as webhook_url on a job to test it</div>
              )}
            </div>
          </div>
          <div className="panel-foot">
            An unverified delivery is answered 401 and never acted on. A replayed delivery outside the freshness window is refused even with a
            valid signature.
          </div>
        </div>

        {/* Staging + reference */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Uploads · Staging Area</span>
              <span style={{ flex: 1 }} />
              <span className="tag">POST /v1/ai/uploads/request-url</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="code-card">
                {"# 1 — request signed URLs\nPOST /v1/ai/uploads/request-url  { files: [{ content_type: \"image/png\" }] }\n# 2 — PUT raw bytes to upload_url (no API key on that request)\n# 3 — feed asset_url into any endpoint"}
              </div>
              <div className="kv">
                <span>staged right now</span>
                <b>{uploads.data?.files.length ?? 0} file(s)</b>
              </div>
              <div className="hint">
                URLs are valid about 24 h and files auto-delete after roughly 7 days — staging, not storage. The vault is what keeps anything.
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Integration Kit</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="kv">
                <span>base URL</span>
                <b>https://api.magnific.com</b>
              </div>
              <div className="kv">
                <span>auth header</span>
                <b>x-magnific-api-key</b>
              </div>
              <div className="kv">
                <span>MCP server</span>
                <b>https://mcp.magnific.com</b>
              </div>
              <div className="kv">
                <span>balance</span>
                <b>{num(status?.balance?.available ?? null)} credits</b>
              </div>
              <div className="kv">
                <span>reserved</span>
                <b>{num(status?.balance?.reserved ?? null)}</b>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <a className="btn" style={{ flex: 1 }} href="https://docs.magnific.com" target="_blank" rel="noreferrer">
                  ⧉ DOCS
                </a>
                <a className="btn" style={{ flex: 1 }} href="https://magnific.com/user/api-keys" target="_blank" rel="noreferrer">
                  ⚙ KEYS
                </a>
              </div>
              <div className="hint">
                Server-to-server only — the key never reaches the browser. Every call on these pages is made by the X-Forge server.
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function NumberRow({ label, value, onSave, hint }: { label: string; value: number; onSave: (v: number) => void; hint?: string }) {
  const [v, setV] = useState(String(value));
  const [dirty, setDirty] = useState(false);

  return (
    <div>
      <div className="label">{label}</div>
      <div className="field">
        <input
          value={dirty ? v : String(value)}
          onChange={(e) => {
            setV(e.target.value);
            setDirty(true);
          }}
        />
        {dirty ? (
          <button
            className="chip active"
            style={{ minHeight: 24, fontSize: 8.5 }}
            onClick={() => {
              onSave(Number(v));
              setDirty(false);
            }}
          >
            SAVE
          </button>
        ) : null}
      </div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
