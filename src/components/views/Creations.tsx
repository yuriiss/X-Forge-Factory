"use client";

import { useT } from "@/lib/i18n";
import { Dropzone, ago, bytes, useJson, useToast, type Upload } from "../ui";
import { useNav } from "../Console";
import Lightbox, { ModelViewer, type LightboxAsset } from "../Lightbox";
import { useEffect, useState } from "react";

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
  const t = useT();
  const toast = useToast();
  const { status } = useNav();
  const [scope, setScope] = useState<"vault" | "account">("vault");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("all");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [selected, setSelected] = useState<VaultItem | null>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

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
          <h1>{t("CREATIONS")}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {scope === "vault" ? t("local vault — downloaded, permanent, playable") : t("account history — GET /v1/creations/recent, URLs expire")}
          </div>
        </div>
        <div className="topbar-spacer" />
        <button className={`chip ${scope === "vault" ? "active" : ""}`} onClick={() => { setScope("vault"); setPage(1); }}>
          {t("VAULT")}
        </button>
        <button className={`chip ${scope === "account" ? "active" : ""}`} onClick={() => { setScope("account"); setPage(1); }}>
          {t("ACCOUNT")}
        </button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "230px minmax(0,1fr) 290px" }}>
        {/* Left */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Type")}</span>
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
                  <span style={{ flex: 1, fontSize: 11, color: "var(--text-2)" }}>{t(k)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot green" />
              <span className="panel-title">{t("Library")}</span>
              <span style={{ flex: 1 }} />
              <span className="tag">{t("ON DISK")}</span>
            </div>
            <div className="panel-body" style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="code-card" style={{ fontSize: 9.5, whiteSpace: "normal", wordBreak: "break-all" }}>
                {status?.vault.root ?? "…"}
              </div>
              <div className="kv">
                <span>{t("files")}</span>
                <b>{status?.vault.files ?? "—"}</b>
              </div>
              <div className="kv">
                <span>{t("size")}</span>
                <b>{status ? bytes(status.vault.bytes) : "—"}</b>
              </div>
              <div className="hint" style={{ margin: 0 }}>
                {t("Sorted into image / video / audio / 3D / vector, named by date and label, with a markdown note beside each file.")}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Folders")}</span>
              <span style={{ flex: 1 }} />
              <span className="tag">{t("REMOTE")}</span>
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
                <div className="hint">{folders.data?.note ?? t("no folders")}</div>
              )}
            </div>
            <div className="panel-foot">{t("Folders in your Magnific account, not on this machine — where the provider files its own copies.")}</div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Spaces")}</span>
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
                <div className="hint">{spaces.data?.note ?? t("no spaces")}</div>
              )}
            </div>
            <div className="panel-foot">{t("Also remote: the infinite canvases where Flows are built.")}</div>
          </div>
        </div>

        {/* Gallery */}
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Gallery")}</span>
            <span style={{ flex: 1 }} />
            <div className="field" style={{ minHeight: 30, width: 210 }}>
              <input
                placeholder={t("⌕ label or model…")}
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
                {list.data.items.map((c, i) => (
                  <div
                    className={`thumb ${c.url ? "zoomable" : ""}`}
                    key={c.id}
                    onClick={() => {
                      setSelected(c);
                      if (c.url) setViewing(i);
                    }}
                  >
                    <div className="thumb-img g1">
                      {c.url && (c.kind === "image" || c.kind === "vector") ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.url} alt={c.label} />
                      ) : c.url && c.kind === "video" ? (
                        <video src={c.url} muted />
                      ) : c.preview ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.preview} alt={c.label} />
                      ) : c.kind === "3d" ? (
                        <span style={{ display: "grid", placeItems: "center", gap: 4 }}>
                          <span style={{ fontSize: 22 }}>◈</span>
                          <span className="badge" style={{ fontSize: 7.5 }}>{t("GLB")}</span>
                        </span>
                      ) : (
                        <span>{c.kind === "audio" ? "♫" : "✦"}</span>
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
                <div className="empty-title">{scope === "vault" ? t("The vault is empty") : t("No account creations")}</div>
                <div className="nav-sub">{t("generate something and it lands here automatically")}</div>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, color: "var(--dim)", fontSize: 10 }}>
              <span>
                page {page} · {list.data?.items.length ?? 0} shown{list.data?.total ? ` · ${list.data.total} ${t("total")}` : ""}
              </span>
              <span>
                <span className="link" onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  {t("‹ prev")}
                </span>
                {" · "}
                <span className="link" onClick={() => setPage((p) => p + 1)}>
                  {t("next ›")}
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
              <span className="panel-title">{t("Inspector")}</span>
              <span style={{ flex: 1 }} />
              {selected ? <span className="badge green">{selected.origin.toUpperCase()}</span> : null}
            </div>
            <div className="panel-body">
              {selected ? (
                <>
                  <div
                    className="result-frame g1 clickable"
                    style={{ height: 190 }}
                    title={t("Open full size")}
                    onClick={() => {
                      const i = list.data?.items.findIndex((x) => x.id === selected.id) ?? -1;
                      if (i >= 0 && selected.url) setViewing(i);
                    }}
                  >
                    {selected.url && (selected.kind === "image" || selected.kind === "vector") ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="result-media" src={selected.url} alt={selected.label} />
                    ) : selected.url && selected.kind === "video" ? (
                      <video className="result-media" src={selected.url} controls />
                    ) : selected.url && selected.kind === "audio" ? (
                      <audio style={{ width: "90%" }} src={selected.url} controls onClick={(e) => e.stopPropagation()} />
                    ) : selected.url && selected.kind === "3d" ? (
                      <InlineModel url={selected.url} />
                    ) : (
                      <span style={{ fontSize: 26, color: "rgba(232,237,245,0.35)" }}>◈</span>
                    )}
                  </div>
                  <div className="kv" style={{ marginTop: 10 }}>
                    <span>{t("label")}</span>
                    <b className="truncate">{selected.label}</b>
                  </div>
                  <div className="kv">
                    <span>{t("kind")}</span>
                    <b>{selected.kind}</b>
                  </div>
                  {selected.mime ? (
                    <div className="kv">
                      <span>{t("mime")}</span>
                      <b>{selected.mime}</b>
                    </div>
                  ) : null}
                  {selected.bytes ? (
                    <div className="kv">
                      <span>{t("size")}</span>
                      <b>{bytes(selected.bytes)}</b>
                    </div>
                  ) : null}
                  <div className="kv">
                    <span>{t("created")}</span>
                    <b>{new Date(selected.created).toLocaleString()}</b>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button
                      className="btn"
                      style={{ flex: 1 }}
                      disabled={!selected.url}
                      onClick={() => {
                        const i = list.data?.items.findIndex((x) => x.id === selected.id) ?? -1;
                        if (i >= 0) setViewing(i);
                      }}
                    >
                      {t("⤢ OPEN")}
                    </button>
                    <a className="btn" style={{ flex: 1 }} href={selected.url} download>
                      ⇩
                    </a>
                    <button
                      className="btn"
                      style={{ flex: 1 }}
                      onClick={() => {
                        void navigator.clipboard.writeText(new URL(selected.url ?? "", window.location.origin).toString());
                        toast.push("ok", t("URL copied"));
                      }}
                    >
                      {t("⧉ URL")}
                    </button>
                  </div>
                </>
              ) : (
                <div className="hint">{t("Pick something from the gallery.")}</div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Import Asset")}</span>
              <span className="meta">{t("vault + MCP")}</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="hint" style={{ margin: 0 }}>
                {t("One drop stores the file locally, stages it for the REST endpoints and imports it as an MCP creation.")}
              </div>
              <Dropzone label={t("⊕ drop file")} hint={t("image / video / audio")} value={upload} onChange={setUpload} needCreation needStaging minHeight={80} />
              {upload ? (
                <div className="ok-box">
                  Stored as {upload.assetId}
                  {upload.creationIdentifier ? ` · ${t("creation")} ${upload.creationIdentifier}` : ""}
                  {upload.assetUrl ? t(" · staged") : ""}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {viewing !== null && list.data?.items[viewing]?.url ? (
        <Lightbox
          asset={toLightbox(list.data.items[viewing])}
          onClose={() => setViewing(null)}
          onPrev={viewing > 0 ? () => step(-1) : undefined}
          onNext={viewing < (list.data.items.length - 1) ? () => step(1) : undefined}
        />
      ) : null}
    </>
  );

  /** Walk the gallery from inside the viewer, skipping anything with nothing to show. */
  function step(by: number) {
    const items = list.data?.items ?? [];
    let i = (viewing ?? 0) + by;
    while (i >= 0 && i < items.length && !items[i].url) i += by;
    if (i >= 0 && i < items.length) {
      setViewing(i);
      setSelected(items[i]);
    }
  }
}

function toLightbox(item: VaultItem): LightboxAsset {
  return {
    id: item.id,
    url: item.url!,
    kind: item.kind,
    mime: item.mime,
    bytes: item.bytes,
    label: item.label,
    model: item.model ?? item.tool ?? undefined,
    created: item.created,
  };
}

/**
 * A model rendered in the inspector.
 *
 * The viewer is over a megabyte, so it is fetched only once a model is actually selected —
 * a gallery of stills should not pay for a 3D engine it never uses.
 */
function InlineModel({ url }: { url: string }) {
  const t = useT();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void import("@google/model-viewer").then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);

  if (!ready)
    return (
      <div style={{ display: "grid", placeItems: "center", gap: 8 }}>
        <span className="spinner" />
        <span className="dim" style={{ fontSize: 9, letterSpacing: 1.5 }}>
          {t("LOADING 3D")}
        </span>
      </div>
    );

  return (
    <ModelViewer
      class="model-inline"
      src={url}
      camera-controls=""
      auto-rotate=""
      shadow-intensity="1"
      exposure="1.1"
      interaction-prompt="none"
    />
  );
}
