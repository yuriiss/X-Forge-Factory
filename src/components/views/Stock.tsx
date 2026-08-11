"use client";

import { useState } from "react";
import { useJson } from "../ui";

/**
 * Stock.
 *
 * Four libraries behind one search box. The panel says which endpoint answered and what
 * the plan rules are, because stock is the one place in the product where the cost is a
 * daily download allowance rather than credits — an operator who assumes otherwise will
 * be surprised in the wrong direction.
 */

const TABS = ["images", "videos", "music", "sfx", "icons"] as const;

interface Item {
  id: string;
  title: string;
  preview: string | null;
  meta: string;
  url: string;
  tags?: string[];
}

export default function Stock() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("images");
  const [query, setQuery] = useState("neon harbour at night");
  const [term, setTerm] = useState("neon harbour at night");

  const res = useJson<{ items: Item[]; total?: number | null; type: string }>(
    `/api/stock?type=${tab}&q=${encodeURIComponent(term)}&limit=24`,
    { deps: [tab, term] },
  );

  return (
    <>
      <div className="intro">
        <div>
          <h1>STOCK</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            Curated libraries — photos &amp; templates · icons · video · music · sound effects
          </div>
        </div>
        <div className="topbar-spacer" />
        {TABS.map((t) => (
          <button key={t} className={`chip ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <span className="dot accent" />
          <span className="panel-title">Search</span>
          <span className="meta">GET /v1/{tab === "images" ? "resources" : tab === "sfx" ? "sound-effects" : tab}</span>
          <span style={{ flex: 1 }} />
          <div className="field" style={{ minHeight: 32, width: 300 }}>
            <input
              placeholder="⌕ query — e.g. “neon harbour at night”"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setTerm(query);
              }}
            />
          </div>
          <button className="btn primary" onClick={() => setTerm(query)}>
            ⌕ SEARCH
          </button>
        </div>
        <div className="panel-body">
          {res.loading ? <div className="hint">searching…</div> : null}
          {res.error ? <div className="error-box">{res.error}</div> : null}

          {tab === "music" || tab === "sfx" ? (
            <div>
              {res.data?.items.map((i) => (
                <div className="provider-row" key={i.id}>
                  <span className="icon-btn" style={{ width: 28, height: 28, color: "var(--accent)" }}>
                    ▶
                  </span>
                  <span style={{ flex: 1 }} className="truncate">
                    {i.title}
                  </span>
                  {i.tags?.slice(0, 2).map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                  <span className="dim mono">{i.meta}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="gallery" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))" }}>
              {res.data?.items.map((i) => (
                <a className="thumb" key={i.id} href={i.url || undefined} target="_blank" rel="noreferrer" title={i.title}>
                  <div className="thumb-img g1" style={{ height: 100 }}>
                    {i.preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={i.preview} alt={i.title} />
                    ) : (
                      <span>❖</span>
                    )}
                  </div>
                  <div className="thumb-meta" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 9, color: "var(--dim)" }} className="truncate">
                      {i.meta}
                    </span>
                    <span className="badge amber">DL</span>
                  </div>
                </a>
              ))}
            </div>
          )}

          {res.data && !res.data.items.length && !res.loading ? <div className="hint">nothing matched that search</div> : null}
        </div>
        <div className="panel-foot">
          {res.data?.total ? `${res.data.total.toLocaleString()} results · ` : ""}
          Every unique download must be reported; caching is allowed while the plan is active.
        </div>
      </div>

      <div className="grid cols-3">
        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">Download Rules</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="kv">
              <span>Premium / Pro</span>
              <b>100 downloads / day</b>
            </div>
            <div className="kv">
              <span>Business / Enterprise</span>
              <b>unlimited · credit-based</b>
            </div>
            <div className="hint">
              Stock downloads do not consume generation credits below Business — the daily cap applies instead. No data mining, no scraping, no
              resale without modification.
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">What each tab reads</span>
          </div>
          <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            <table className="tbl">
              <tbody>
                <tr>
                  <th>Tab</th>
                  <th>Endpoint</th>
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
            <span className="panel-title">Rate</span>
            <span className="meta">1 000 RPD on search</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="hint" style={{ margin: 0 }}>
              Stock search is rate-limited per day rather than priced. X-Forge counts every outbound call in the same shaper the generators use,
              so a burst of searches cannot starve a render of its rate budget.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
