"use client";

import { useT } from "@/lib/i18n";
import { useState } from "react";
import { useNav } from "../Console";
import { ago, num, postJson, useAsk, useJson, useToast } from "../ui";

/**
 * Where this console's source lives.
 *
 * The AGPL asks that anyone interacting with a modified copy over a network can get its
 * source. A local console rarely has such users, but the offer costs one link and is the
 * difference between complying and intending to.
 */
const SOURCE_URL = "https://github.com/yuriiss/X-Forge-Factory";

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
  const t = useT();
  const toast = useToast();
  const ask = useAsk();
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
      toast.push("ok", t("Saved"));
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
  };

  const tenant = status?.tenant;

  return (
    <>
      <div className="intro">
        <div>
          <h1>{t("DEVELOPERS")}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {t("Credential · engine limits · webhook signing · staging area · reconciliation")}
          </div>
        </div>
        <div className="topbar-spacer" />
        <span className={`chip ${tenant?.status === "active" ? "active" : ""}`}>ENGINE · {(tenant?.status ?? "—").toUpperCase()}</span>
      </div>

      <div className="grid cols-2">
        {/* Credential */}
        <div className="panel">
          <div className="panel-head">
            <span className={`dot ${cred.data?.credential.present ? "green" : "red"}`} />
            <span className="panel-title">{t("Magnific Credential")}</span>
            <span className="meta">{t("envelope-encrypted at rest")}</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {cred.data?.credential.present ? (
              <>
                <div className="kv">
                  <span>{t("key")}</span>
                  <b>…{cred.data.credential.last4}</b>
                </div>
                <div className="kv">
                  <span>{t("fingerprint")}</span>
                  <b>{cred.data.credential.fingerprint}</b>
                </div>
                <div className="kv">
                  <span>{t("last verified")}</span>
                  <b>{cred.data.credential.verifiedAt ? `${ago(cred.data.credential.verifiedAt)} ${t("ago")}` : t("not yet")}</b>
                </div>
              </>
            ) : (
              <div className="error-box">{t("No credential stored. Nothing can run until one is saved.")}</div>
            )}

            <div>
              <div className="label">{t("REPLACE KEY")}</div>
              <div className="field">
                <input type="password" placeholder={t("paste a Magnific API key")} value={newKey} onChange={(e) => setNewKey(e.target.value)} />
              </div>
              <div className="hint">
                {t("Verified with a live call before it is stored — an invalid key is never saved, and the key itself is not returned by any endpoint afterwards.")}
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
                    toast.push("ok", t("Key verified and stored"));
                  } catch (e) {
                    toast.push("err", (e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("✓ VERIFY & SAVE")}
              </button>
              <button
                className="btn"
                style={{ flex: 1 }}
                disabled={!cred.data?.credential.present}
                onClick={async () => {
                  const yes = await ask.confirm({
                    title: t("Revoke the stored key?"),
                    body: t("Queued jobs are cancelled and nothing can run until another key is saved."),
                    confirmLabel: t("REVOKE"),
                    danger: true,
                  });
                  if (!yes) return;
                  await postJson("/api/credentials", undefined, "DELETE");
                  cred.reload();
                  reloadStatus();
                  toast.push("ok", t("Credential revoked, queue cancelled"));
                }}
              >
                {t("✕ REVOKE")}
              </button>
            </div>
          </div>
          <div className="panel-foot">
            {t("Per-tenant DEK, master key from the environment. Revocation erases the ciphertext immediately and cancels queued work.")}
          </div>
        </div>

        {/* Engine limits */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Engine Limits")}</span>
            <span className="meta">{t("yours to set")}</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            <NumberRow label={t("APPROVAL THRESHOLD · CREDITS")} value={tenant?.approvalThreshold ?? 0} onSave={(v) => patchTenant({ approval_threshold: v })} hint={t("Above this, a job waits for a human on a one-time link.")} />
            <NumberRow label={t("CREDIT FLOOR")} value={tenant?.creditFloor ?? 0} onSave={(v) => patchTenant({ credit_floor: v })} hint={t("A job that would drop the balance below this is rejected, never downgraded.")} />
            <NumberRow label={t("MAX CONCURRENT JOBS")} value={tenant?.maxConcurrentJobs ?? 0} onSave={(v) => patchTenant({ max_concurrent_jobs: v })} />
            <NumberRow label={t("RPM LIMIT")} value={tenant?.rpmLimit ?? 0} onSave={(v) => patchTenant({ rpm_limit: v })} hint={t("Your own ceiling, under the provider's 50 per key.")} />
            <NumberRow label={t("RETENTION · DAYS")} value={tenant?.retentionDays ?? 0} onSave={(v) => patchTenant({ retention_days: v })} />

            <div className="toggle-row" onClick={() => patchTenant({ video_enabled: !tenant?.videoEnabled })} role="button" tabIndex={0}>
              <span>{t("VIDEO GENERATION")}</span>
              <span className={`toggle ${tenant?.videoEnabled ? "on" : ""}`} />
            </div>

            {tenant?.status === "safe_mode" ? (
              <div className="error-box">
                  {t("The reconciler parked this tenant in safe_mode — new jobs are refused.")}
                <button className="btn" style={{ width: "100%", marginTop: 8 }} onClick={() => patchTenant({ status: "active" })}>
                  {t("↺ RESUME")}
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
              {t("⟳ RECONCILE NOW")}
            </button>
          </div>
          <div className="panel-foot">
            {t("Drift past the threshold moves this tenant to safe_mode: running work finishes, nothing new starts, and only a human resumes it.")}
          </div>
        </div>

        {/* Webhooks */}
        <div className="panel">
          <div className="panel-head">
            <span className={`dot ${hooks.data?.configured ? "green" : ""}`} />
            <span className="panel-title">{t("Webhook Receiver")}</span>
            <span style={{ flex: 1 }} />
            <span className={`badge ${hooks.data?.configured ? "green" : "amber"}`}>
              {hooks.data?.configured ? t("SIGNING SECRET SET") : t("NO SECRET")}
            </span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div className="label">{t("RECEIVER URL · pass as webhook_url on any job")}</div>
              <div className="field">
                <input readOnly value={hooks.data?.endpoint ?? ""} />
                <button
                  className="icon-btn"
                  style={{ border: 0 }}
                  onClick={() => {
                    void navigator.clipboard.writeText(hooks.data?.endpoint ?? "");
                    toast.push("ok", t("Copied"));
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
                {t("DELIVERIES")}
              </div>
              {hooks.data?.deliveries.length ? (
                hooks.data.deliveries.slice(0, 8).map((d, i) => (
                  <div className="activity-row" key={`${d.at}-${i}`}>
                    <span className="dim mono">{new Date(d.at).toISOString().slice(11, 19)}</span>
                    <span className={`badge ${d.verified ? "green" : "red"}`}>{d.verified ? t("VERIFIED") : t("REJECTED")}</span>
                    <span className="truncate muted">
                      {d.taskId ?? "?"} · {d.status ?? d.note}
                    </span>
                  </div>
                ))
              ) : (
                <div className="hint">{t("nothing delivered yet — pass the receiver URL as webhook_url on a job to test it")}</div>
              )}
            </div>
          </div>
          <div className="panel-foot">
            {t("An unverified delivery is answered 401 and never acted on. A replayed delivery outside the freshness window is refused even with a valid signature.")}
          </div>
        </div>

        {/* Staging + reference */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Uploads · Staging Area")}</span>
              <span style={{ flex: 1 }} />
              <span className="tag">POST /v1/ai/uploads/request-url</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="code-card">
                {"# 1 — request signed URLs\nPOST /v1/ai/uploads/request-url  { files: [{ content_type: \"image/png\" }] }\n# 2 — PUT raw bytes to upload_url (no API key on that request)\n# 3 — feed asset_url into any endpoint"}
              </div>
              <div className="kv">
                <span>{t("staged right now")}</span>
                <b>{uploads.data?.files.length ?? 0} file(s)</b>
              </div>
              <div className="hint">
                {t("URLs are valid about 24 h and files auto-delete after roughly 7 days — staging, not storage. The vault is what keeps anything.")}
              </div>
            </div>
          </div>

          <ModelKeys />

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Integration Kit")}</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="kv">
                <span>{t("base URL")}</span>
                <b>https://api.magnific.com</b>
              </div>
              <div className="kv">
                <span>{t("auth header")}</span>
                <b>{t("x-magnific-api-key")}</b>
              </div>
              <div className="kv">
                <span>{t("MCP server")}</span>
                <b>https://mcp.magnific.com</b>
              </div>
              <div className="kv">
                <span>{t("balance")}</span>
                <b>{num(status?.balance?.available ?? null)} credits</b>
              </div>
              <div className="kv">
                <span>{t("reserved")}</span>
                <b>{num(status?.balance?.reserved ?? null)}</b>
              </div>
              <div className="kv">
                <span>{t("licence")}</span>
                <b>{t("AGPL-3.0-or-later")}</b>
              </div>
              <div className="kv">
                <span>{t("source")}</span>
                <b>
                  <a className="link" href={SOURCE_URL} target="_blank" rel="noreferrer">
                    {t("github.com/yuriiss/X-Forge-Factory")}
                  </a>
                </b>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <a className="btn" style={{ flex: 1 }} href="https://docs.magnific.com" target="_blank" rel="noreferrer">
                  {t("⧉ DOCS")}
                </a>
                <a className="btn" style={{ flex: 1 }} href="https://magnific.com/user/api-keys" target="_blank" rel="noreferrer">
                  {t("⚙ KEYS")}
                </a>
                <a className="btn" style={{ flex: 1 }} href={SOURCE_URL} target="_blank" rel="noreferrer">
                  {t("⌁ SOURCE")}
                </a>
              </div>
              <div className="hint">
                {t("Server-to-server only — the key never reaches the browser. Every call on these pages is made by the X-Forge server.")}
              </div>
              <div className="hint">
                {t("X-Forge is free software under the GNU AGPL v3, with no warranty. If you are using a modified copy of this console that someone else is running for you, that operator owes you its source — the link above is where this one lives.")}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function NumberRow({ label, value, onSave, hint }: { label: string; value: number; onSave: (v: number) => void; hint?: string }) {
  const t = useT();
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
            {t("SAVE")}
          </button>
        ) : null}
      </div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

interface EnvVariable {
  name: string;
  value: string;
  secret: boolean;
}

interface ProviderRow {
  id: string;
  label: string;
  base: string;
  builtin: boolean;
  configured: boolean;
}

/**
 * Keys for the models in Chat.
 *
 * These go into `.env.local` in the clear, unlike the Magnific credential, which is
 * envelope-encrypted in the database. The difference is deliberate and worth stating on the
 * panel itself: the CLIs on this machine already read their own keys from the environment,
 * an operator expects to be able to open that file and see what is set, and encrypting one
 * of two adjacent stores would look like protection without being any.
 *
 * Nothing is checked against the provider before it is saved. A wrong key becomes a failed
 * call a few seconds later carrying the provider's own words, which is a better error than
 * anything this panel could invent, and a verification round-trip would spend a request
 * every time somebody fixes a typo.
 */
function ModelKeys() {
  const t = useT();
  const toast = useToast();
  const ask = useAsk();
  const { data, reload } = useJson<{ providers: ProviderRow[]; variables: EnvVariable[]; file: string }>("/api/providers");

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [custom, setCustom] = useState({ id: "", label: "", base: "", key: "" });
  const [adding, setAdding] = useState(false);

  const post = async (body: Record<string, unknown>, ok: string) => {
    try {
      await postJson("/api/providers", body);
      toast.push("ok", ok);
      reload();
      return true;
    } catch (e) {
      toast.push("err", (e as Error).message);
      return false;
    }
  };

  const providers = data?.providers ?? [];
  const variables = data?.variables ?? [];

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="dot accent" />
        <span className="panel-title">{t("Model & Provider Keys")}</span>
        <span style={{ flex: 1 }} />
        <span className="tag mono">{data?.file ?? ".env.local"}</span>
      </div>

      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            {t("PROVIDERS")}
          </div>
          {providers.map((p) => (
            <div className="kv" key={p.id}>
              <span>
                {p.label}
                <span className="dim mono" style={{ marginLeft: 6, fontSize: 9 }}>
                  {p.base.replace(/^https?:\/\//, "")}
                </span>
              </span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <b style={{ color: p.configured ? "var(--green-text)" : "var(--muted)" }}>{p.configured ? t("key set") : t("no key")}</b>
                <button
                  className="chip"
                  style={{ fontSize: 8, minHeight: 20 }}
                  onClick={async () => {
                    const entered = await ask.prompt({
                      title: t("API key for {label}", { label: p.label }),
                      body: t("Written to .env.local at mode 600 and applied immediately. It is never sent back to this page."),
                      placeholder: "sk-…",
                      confirmLabel: t("SAVE"),
                    });
                    if (entered) void post({ action: "add-provider", id: p.id, base: p.base, key: entered }, t("Saved"));
                  }}
                >
                  {p.configured ? t("REPLACE") : t("ADD")}
                </button>
                {p.configured || !p.builtin ? (
                  <button className="chip" style={{ fontSize: 8, minHeight: 20 }} onClick={() => void post({ action: "remove-provider", id: p.id }, t("Removed"))}>
                    ✕
                  </button>
                ) : null}
              </span>
            </div>
          ))}

          {adding ? (
            <div className="well" style={{ padding: "10px 11px", marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="field">
                <input placeholder={t("id — e.g. together")} value={custom.id} onChange={(e) => setCustom({ ...custom, id: e.target.value })} />
              </div>
              <div className="field">
                <input placeholder={t("label — e.g. Together AI")} value={custom.label} onChange={(e) => setCustom({ ...custom, label: e.target.value })} />
              </div>
              <div className="field">
                <input placeholder="https://api.together.xyz/v1" value={custom.base} onChange={(e) => setCustom({ ...custom, base: e.target.value })} />
              </div>
              <div className="field">
                <input type="password" placeholder={t("API key")} value={custom.key} onChange={(e) => setCustom({ ...custom, key: e.target.value })} />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn primary"
                  style={{ flex: 1 }}
                  disabled={!custom.id.trim() || !custom.base.trim()}
                  onClick={async () => {
                    const ok = await post({ action: "add-provider", ...custom }, t("Provider added"));
                    if (ok) {
                      setCustom({ id: "", label: "", base: "", key: "" });
                      setAdding(false);
                    }
                  }}
                >
                  {t("SAVE PROVIDER")}
                </button>
                <button className="btn" onClick={() => setAdding(false)}>
                  {t("CANCEL")}
                </button>
              </div>
              <div className="hint">{t("Any endpoint that answers the OpenAI chat shape at /chat/completions works here.")}</div>
            </div>
          ) : (
            <button className="chip" style={{ marginTop: 8, fontSize: 8.5 }} onClick={() => setAdding(true)}>
              {t("+ ADD A PROVIDER")}
            </button>
          )}
        </div>

        <div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            {t("EVERYTHING IN THE FILE")}
          </div>
          {variables.length === 0 ? <div className="hint">{t("Nothing set yet.")}</div> : null}
          {variables.map((v) => (
            <div className="kv" key={v.name}>
              <span className="mono" style={{ fontSize: 9.5 }}>
                {v.name}
              </span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <b className="mono" style={{ fontSize: 9.5, color: v.secret ? "var(--text-3)" : "var(--text-2)" }}>
                  {v.value || "—"}
                </b>
                <button className="chip" style={{ fontSize: 8, minHeight: 20 }} onClick={() => void post({ action: "clear", name: v.name }, t("Removed"))}>
                  ✕
                </button>
              </span>
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <input
                placeholder="ANTHROPIC_API_KEY"
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <input type="password" placeholder={t("value")} value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
            <button
              className="btn primary"
              disabled={!name.trim() || !value.trim()}
              onClick={async () => {
                const ok = await post({ action: "set", name, value }, t("Saved"));
                if (ok) {
                  setName("");
                  setValue("");
                }
              }}
            >
              {t("SAVE")}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            {t("Written at mode 600 and applied immediately — a CLI started after this picks it up. Secrets are shown masked; the full value never leaves the server.")}
          </div>
        </div>
      </div>
    </div>
  );
}
