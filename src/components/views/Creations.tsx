"use client";

import { useState } from "react";
import { Dropzone, ago, bytes, useJson, useToast, type Upload } from "../ui";

/**
 * Creations.
 *
 * The vault first, because those files are the ones that will still be there tomorrow —
 * every job downloads its output the moment it completes, since provider URLs expire in
 * about a day. The account's own recent creations are a second tab rather than a merged
 * grid, so it is always obvious which thumbnails are local and which are borrowed.
 */

const KINDS = ["all", "image", "video", "audio", "3d", "vector"] as const;

interface VaultItem {
  id: string;
  origin: string;
  label: string;
  kind: string;
  mime?: string;
  bytes?: number;
  created: string;
  jobId?: string;
  url?: string;
  model?: string;
  preview?: string | null;
  tool?: string | null;
}

export default function Creations() {
  const toast = useToast();
  const [scope, setScope] = useState<"vault" | "account">("vault");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("all");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<VaultItem | null>(null);
  const [upload, setUpload] = useState<Upload | null>(null);

  const perPage = 24;
  const list = useJson<{ items: VaultItem[]; total: number }>(
    `/api/creations?scope=${scope}&kind=${kind}&page=${page}&per_page=${perPage}&q=${encodeURIComponent(term)}`,
    { deps: [scope, kind, page, term], intervalMs: 20_000 },
  );
  const folders = useJson<{ folders: { reference: string; name: string }[]; note?: string }>("/api/creations?scope=folders");
  const spaces = useJson<{ spaces: { id: string; name: string }[]; note?: string }>("/api/creations?scope=spaces");

  return (
    <>
      <div className="intro">
        <div>
          <h1>CREATIONS</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {scope === "vault" ? "local vault — downloaded, permanent, playable" : "account history — GET /v1/creations/recent, URLs expire"}
          </div>
        </div>
        <div className="topbar-spacer" />
        <button className={`chip ${scope === "vault" ? "active" : ""}`} onClick={() => { setScope("vault"); setPage(1); }}>
          VAULT
        </button>
        <button className={`chip ${scope === "account" ? "active" : ""}`} onClick={() => { setScope("account"); setPage(1); }}>
          ACCOUNT
        </button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "230px minmax(0,1fr) 290px" }}>
        {/* Left */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Type</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 7, paddingTop: 10 }}>
              {KINDS.map((k) => (
                <div
                  key={k}
                  className={`flow-item ${kind === k ? "active" : ""}`}
                  style={{ padding: "8px 10px" }}
                  onClick={() => {
                    setKind(k);
                    setPage(1);
                  }}
                >
                  <span style={{ fontSize: 12 }}>{k === "video" ? "▶" : k === "audio" ? "♫" : k === "3d" ? "◈" : k === "vector" ? "⌗" : "▤"}</span>
                  <span style={{ flex: 1, fontSize: 11, color: "var(--text-2)" }}>{k}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Folders</span>
              <span style={{ flex: 1 }} />
              <span className="tag">MCP</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 7, paddingTop: 10 }}>
              {folders.data?.folders.length ? (
                folders.data.folders.map((f) => (
                  <div className="flow-item" style={{ padding: "8px 10px" }} key={f.reference}>
                    <span style={{ fontSize: 12 }}>▤</span>
                    <span style={{ flex: 1, fontSize: 11, color: "var(--text-2)" }} className="truncate">
                      {f.name}
                    </span>
                  </div>
                ))
              ) : (
                <div className="hint">{folders.data?.note ?? "no folders"}</div>
              )}
            </div>
            <div className="panel-foot">folders_list · create · rename · delete</div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Spaces</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 7, paddingTop: 10 }}>
              {spaces.data?.spaces.length ? (
                spaces.data.spaces.map((s) => (
                  <div className="flow-item" style={{ padding: "8px 10px" }} key={s.id}>
                    <span style={{ fontSize: 12, color: "var(--purple)" }}>⌘</span>
                    <span style={{ flex: 1, fontSize: 11, color: "var(--text-2)" }} className="truncate">
                      {s.name}
                    </span>
                    <span className="dot green" />
                  </div>
                ))
              ) : (
                <div className="hint">{spaces.data?.note ?? "no spaces"}</div>
              )}
            </div>
          </div>
        </div>

        {/* Gallery */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">Gallery</span>
            <span style={{ flex: 1 }} />
            <div className="field" style={{ minHeight: 30, width: 210 }}>
              <input
                placeholder="⌕ label or model…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setTerm(query);
                    setPage(1);
                  }
                }}
              />
            </div>
            <button className="chip" onClick={() => { setTerm(query); setPage(1); }}>
              ⌕
            </button>
          </div>
          <div className="panel-body">
            {list.error ? <div className="error-box">{list.error}</div> : null}
            {list.data?.items.length ? (
              <div className="gallery">
                {list.data.items.map((c) => (
                  <div className="thumb" key={c.id} onClick={() => setSelected(c)}>
                    <div className="thumb-img g1">
                      {c.url && (c.kind === "image" || c.kind === "vector") ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.url} alt={c.label} />
                      ) : c.url && c.kind === "video" ? (
                        <video src={c.url} muted />
                      ) : c.preview ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.preview} alt={c.label} />
                      ) : (
                        <span>{c.kind === "audio" ? "♫" : c.kind === "3d" ? "◈" : "✦"}</span>
                      )}
                    </div>
                    <div className="thumb-meta">
                      <div style={{ fontSize: 9.5, color: "var(--text-2)" }} className="truncate">
                        {c.label}
                      </div>
                      <div style={{ fontSize: 8.5, color: "var(--dim)" }}>
                        {c.model ?? c.tool ?? c.kind} · {ago(c.created)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-symbols">
                  <span>▤</span>
                  <span>◇</span>
                  <span>✦</span>
                </div>
                <div className="empty-title">{scope === "vault" ? "The vault is empty" : "No account creations"}</div>
                <div className="nav-sub">generate something and it lands here automatically</div>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, color: "var(--dim)", fontSize: 10 }}>
              <span>
                page {page} · {list.data?.items.length ?? 0} shown{list.data?.total ? ` · ${list.data.total} total` : ""}
              </span>
              <span>
                <span className="link" onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  ‹ prev
                </span>
                {" · "}
                <span className="link" onClick={() => setPage((p) => p + 1)}>
                  next ›
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* Inspector */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14, alignSelf: "start" }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Inspector</span>
              <span style={{ flex: 1 }} />
              {selected ? <span className="badge green">{selected.origin.toUpperCase()}</span> : null}
            </div>
            <div className="panel-body">
              {selected ? (
                <>
                  <div className="result-frame g1" style={{ height: 150 }}>
                    {selected.url && (selected.kind === "image" || selected.kind === "vector") ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="result-media" src={selected.url} alt={selected.label} />
                    ) : selected.url && selected.kind === "video" ? (
                      <video className="result-media" src={selected.url} controls />
                    ) : selected.url && selected.kind === "audio" ? (
                      <audio style={{ width: "90%" }} src={selected.url} controls />
                    ) : (
                      <span style={{ fontSize: 26, color: "rgba(232,237,245,0.35)" }}>◈</span>
                    )}
                  </div>
                  <div className="kv" style={{ marginTop: 10 }}>
                    <span>label</span>
                    <b className="truncate">{selected.label}</b>
                  </div>
                  <div className="kv">
                    <span>kind</span>
                    <b>{selected.kind}</b>
                  </div>
                  {selected.mime ? (
                    <div className="kv">
                      <span>mime</span>
                      <b>{selected.mime}</b>
                    </div>
                  ) : null}
                  {selected.bytes ? (
                    <div className="kv">
                      <span>size</span>
                      <b>{bytes(selected.bytes)}</b>
                    </div>
                  ) : null}
                  <div className="kv">
                    <span>created</span>
                    <b>{new Date(selected.created).toLocaleString()}</b>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <a className="btn" style={{ flex: 1 }} href={selected.url} download>
                      ⇩
                    </a>
                    <button
                      className="btn"
                      style={{ flex: 1 }}
                      onClick={() => {
                        void navigator.clipboard.writeText(new URL(selected.url ?? "", window.location.origin).toString());
                        toast.push("ok", "URL copied");
                      }}
                    >
                      ⧉ URL
                    </button>
                  </div>
                </>
              ) : (
                <div className="hint">Pick something from the gallery.</div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Import Asset</span>
              <span className="meta">vault + MCP</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="hint" style={{ margin: 0 }}>
                One drop stores the file locally, stages it for the REST endpoints and imports it as an MCP creation.
              </div>
              <Dropzone label="⊕ drop file" hint="image / video / audio" value={upload} onChange={setUpload} needCreation needStaging minHeight={80} />
              {upload ? (
                <div className="ok-box">
                  Stored as {upload.assetId}
                  {upload.creationIdentifier ? ` · creation ${upload.creationIdentifier}` : ""}
                  {upload.assetUrl ? " · staged" : ""}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
