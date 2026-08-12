"use client";

import { useT } from "@/lib/i18n";
import { useState } from "react";
import { postJson, useJson, useToast } from "../ui";
import Lightbox, { type LightboxAsset } from "../Lightbox";

/**
 * Stock.
 *
 * Four libraries behind one search box. The panel says which endpoint answered and what
 * the plan rules are, because stock is the one place in the product where the cost is a
 * daily download allowance rather than credits — an operator who assumes otherwise will
 * be surprised in the wrong direction.
 */

/**
 * The libraries, and which endpoint each one reads.
 *
 * Six of these are the one resources endpoint with a content-type filter — the provider's
 * own site presents them as separate categories, and so does this. Two of the site's twelve
 * are missing on purpose: 3D models and fonts have no filter that changes the answer, so a
 * tab for either would be a tab that lies.
 */
const TABS = [
  { id: "images", label: "PHOTOS", type: "images", content: "photo" },
  { id: "vectors", label: "VECTORS", type: "images", content: "vector" },
  { id: "illustrations", label: "ILLUSTRATIONS", type: "images", content: "illustration" },
  { id: "templates", label: "TEMPLATES", type: "images", content: "template" },
  { id: "psd", label: "PSD", type: "images", content: "psd" },
  { id: "mockups", label: "MOCKUPS", type: "images", content: "mockup" },
  { id: "videos", label: "VIDEOS", type: "videos" },
  { id: "icons", label: "ICONS", type: "icons" },
  { id: "music", label: "MUSIC", type: "music" },
  { id: "sfx", label: "SFX", type: "sfx" },
] as const;

type TabId = (typeof TABS)[number]["id"];

interface Item {
  id: string;
  title: string;
  preview: string | null;
  /** A playable file, where the library gives one. Music lists a cover but not a track. */
  clip?: string | null;
  meta: string;
  url: string;
  tags?: string[];
}

export default function Stock() {
  const t = useT();
  const [tab, setTab] = useState<TabId>("images");
  const toast = useToast();
  const [playing, setPlaying] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  /**
   * Fetch the item into the vault.
   *
   * The provider's own page is one click away on the caption, but the button does what a
   * download button should: the file lands in the library beside everything else, with the
   * same name, note and gallery entry. Below a Business plan it spends one of the hundred
   * daily downloads rather than any credits.
   */
  const save = async (item: Item) => {
    setSaving(item.id);
    try {
      const answer = await postJson<{ asset?: { file_name?: string } }>("/api/stock/download", {
        type: current.type,
        id: item.id,
        url: item.clip ?? undefined,
        title: item.title,
      });
      toast.push("ok", t("Saved to the vault: {name}", { name: answer.asset?.file_name ?? item.title }));
    } catch (e) {
      toast.push("err", (e as Error).message);
    } finally {
      setSaving(null);
    }
  };
  const [query, setQuery] = useState("neon harbour at night");
  const [term, setTerm] = useState("neon harbour at night");

  const current = TABS.find((x) => x.id === tab) ?? TABS[0];
  const content = "content" in current ? current.content : undefined;

  const res = useJson<{ items: Item[]; total?: number | null; type: string }>(
    `/api/stock?type=${current.type}&q=${encodeURIComponent(term)}&limit=24${content ? `&content=${content}` : ""}`,
    { deps: [tab, term] },
  );

  /**
   * What the viewer shows.
   *
   * The preview is a thumbnail, not the asset — the full file is behind a download the plan
   * counts. Showing the biggest thing the search gave us is honest and costs nothing; a
   * video plays from the same place, which is the point of not having to leave for the
   * provider's website to find out what a clip is.
   */
  const viewable: LightboxAsset[] = (res.data?.items ?? [])
    .filter((i) => i.preview || i.clip)
    .map((i) => ({
      id: i.id,
      url: (i.clip && current.type === "videos" ? i.clip : i.preview) ?? "",
      kind: current.type === "videos" && i.clip ? "video" : "image",
      label: i.title,
      model: i.meta,
    }));

  return (
    <>
      <div className="intro">
        <div>
          <h1>{t("STOCK")}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {t("Curated libraries — photos & templates · icons · video · music · sound effects")}
          </div>
        </div>
        <div className="topbar-spacer" />
        {TABS.map((tb) => (
          <button key={tb.id} className={`chip ${tab === tb.id ? "active" : ""}`} onClick={() => setTab(tb.id)}>
            {t(tb.label)}
          </button>
        ))}
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <span className="dot accent" />
          <span className="panel-title">{t("Search")}</span>
          <span className="meta">
            GET /v1/{current.type === "images" ? "resources" : current.type === "sfx" ? "sound-effects" : current.type}
            {content ? ` · ${content}` : ""}
          </span>
          <span style={{ flex: 1 }} />
          <div className="field" style={{ minHeight: 32, width: 300 }}>
            <input
              placeholder={t("⌕ query — e.g. “neon harbour at night”")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setTerm(query);
              }}
            />
          </div>
          <button className="btn primary" onClick={() => setTerm(query)}>
            {t("⌕ SEARCH")}
          </button>
        </div>
        <div className="panel-body">
          {res.loading ? <div className="hint">{t("searching…")}</div> : null}
          {res.error ? <div className="error-box">{res.error}</div> : null}

          {current.type === "music" || current.type === "sfx" ? (
            <div>
              {res.data?.items.map((i) => (
                <div className="provider-row" key={i.id}>
                  {i.preview ? (
                    <img className="audio-cover" src={i.preview} alt="" />
                  ) : (
                    <span className="audio-cover placeholder">♫</span>
                  )}
                  <button
                    className="icon-btn"
                    style={{ width: 28, height: 28, color: i.clip ? "var(--accent)" : "var(--dim)" }}
                    disabled={!i.clip}
                    title={i.clip ? t("Play") : t("This library gives no preview — the track arrives on download")}
                    onClick={() => setPlaying(playing === i.id ? null : i.id)}
                  >
                    {playing === i.id ? "◼" : "▶"}
                  </button>
                  <span style={{ flex: 1, minWidth: 0 }} className="truncate">
                    {i.title}
                  </span>
                  {playing === i.id && i.clip ? <audio src={i.clip} autoPlay onEnded={() => setPlaying(null)} /> : null}
                  {i.tags?.slice(0, 2).map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                  <span className="dim mono">{i.meta}</span>
                  <button className="badge amber" disabled={saving === i.id} onClick={() => void save(i)}>
                    {saving === i.id ? t("◷") : t("DL")}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="gallery" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))" }}>
              {res.data?.items.map((i, at) => (
                <div className="thumb zoomable" key={i.id} title={i.title} onClick={() => setViewing(at)} role="button" tabIndex={0}>
                  <div className="thumb-img g1" style={{ height: 100 }}>
                    {i.preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={i.preview} alt={i.title} />
                    ) : (
                      <span>❖</span>
                    )}
                  </div>
                  <div className="thumb-meta" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                    <a
                      className="link truncate"
                      style={{ fontSize: 9 }}
                      onClick={(e) => e.stopPropagation()}
                      href={i.url || undefined}
                      target="_blank"
                      rel="noreferrer"
                      title={t("Open the item's page at the provider")}
                    >
                      {i.meta}
                    </a>
                    <button
                      className="badge amber"
                      disabled={saving === i.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void save(i);
                      }}
                    >
                      {saving === i.id ? t("◷") : t("DL")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {res.data && !res.data.items.length && !res.loading ? <div className="hint">{t("nothing matched that search")}</div> : null}
        </div>
        <div className="panel-foot">
          {res.data?.total ? `${res.data.total.toLocaleString()} ${t("results")} · ` : ""}
          {t("Every unique download must be reported; caching is allowed while the plan is active.")}
          {current.type === "music" ? ` ${t("Music is listed without a preview: the library returns neither a cover nor a track until it is downloaded.")}` : ""}
        </div>
      </div>

      <div className="grid cols-3">
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Download Rules")}</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="kv">
              <span>{t("Premium / Pro")}</span>
              <b>{t("100 downloads / day")}</b>
            </div>
            <div className="kv">
              <span>{t("Business / Enterprise")}</span>
              <b>{t("unlimited · credit-based")}</b>
            </div>
            <div className="hint">
              {t("Stock downloads do not consume generation credits below Business — the daily cap applies instead. No data mining, no scraping, no resale without modification.")}
            {" "}
            {t("The provider's own site also lists 3D models and fonts; neither has a filter this API honours, so neither is shown here rather than shown empty.")}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("What each tab reads")}</span>
          </div>
          <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            <table className="tbl">
              <tbody>
                <tr>
                  <th>{t("Tab")}</th>
                  <th>{t("Endpoint")}</th>
                </tr>
                <tr>
                  <td>images</td>
                  <td className="dim">/v1/resources</td>
                </tr>
                <tr>
                  <td>videos</td>
                  <td className="dim">/v1/videos</td>
                </tr>
                <tr>
                  <td>music</td>
                  <td className="dim">/v1/music</td>
                </tr>
                <tr>
                  <td>sfx</td>
                  <td className="dim">/v1/sound-effects</td>
                </tr>
                <tr>
                  <td>icons</td>
                  <td className="dim">/v1/icons</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">{t("Rate")}</span>
            <span className="meta">{t("1 000 RPD on search")}</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="hint" style={{ margin: 0 }}>
              {t("Stock search is rate-limited per day rather than priced. X-Forge counts every outbound call in the same shaper the generators use, so a burst of searches cannot starve a render of its rate budget.")}
            </div>
          </div>
        </div>
      </div>

      {viewing !== null && viewable[viewing] ? (
        <Lightbox
          asset={viewable[viewing]}
          onClose={() => setViewing(null)}
          onPrev={viewing > 0 ? () => setViewing(viewing - 1) : undefined}
          onNext={viewing < viewable.length - 1 ? () => setViewing(viewing + 1) : undefined}
        />
      ) : null}
    </>
  );
}
