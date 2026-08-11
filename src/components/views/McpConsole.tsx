"use client";

import { useEffect, useMemo, useState } from "react";
import { postJson, useJson, useToast } from "../ui";

/**
 * MCP Console.
 *
 * The mock had a scripted chat bubble here. This is the real thing: the live `tools/list`
 * from the server, an argument form built from each tool's own JSON schema, and a call
 * button that shows exactly what came back. Anything that spends credits is priced with
 * `simulate_cost` first and needs a second, explicit confirmation — the console will not
 * let a curious click cost money.
 */

interface ToolInfo {
  name: string;
  description: string;
  schema: { properties?: Record<string, { type?: string; description?: string; enum?: unknown[]; default?: unknown }>; required?: string[] } | null;
}

interface ToolsPayload {
  connected: boolean;
  count?: number;
  groups: { name: string; items: { name: string; description: string; free: boolean }[] }[];
  tools: ToolInfo[];
}

interface CallResult {
  tool: string;
  isError?: boolean;
  ms?: number;
  text?: string;
  data?: unknown;
  urls?: string[];
  identifiers?: string[];
  needsConfirmation?: boolean;
  estimate?: { credits: number; certainty?: string; reason?: string } | null;
  message?: string;
}

const CLIENTS = [
  {
    id: "claude",
    label: "CLAUDE CODE",
    body: "claude mcp add --transport http magnific https://mcp.magnific.com",
    hint: "First call opens the OAuth flow in your browser — approve once, the tools stay available.",
  },
  {
    id: "cursor",
    label: "CURSOR",
    body: '{\n  "mcpServers": {\n    "magnific": { "url": "https://mcp.magnific.com" }\n  }\n}',
    hint: "Settings → MCP → Add new global MCP server → paste → reload → sign in.",
  },
  {
    id: "chatgpt",
    label: "CHATGPT",
    body: "Settings → Advanced → Developer mode ON\nApps → Create app\nName: Magnific · URL: https://mcp.magnific.com · Auth: OAuth",
    hint: "Developer-mode custom apps require Pro, Business or Enterprise.",
  },
  {
    id: "web",
    label: "CLAUDE WEB",
    body: "Profile → Customize → Connectors → Add connector\n→ Add custom connector\nName: Magnific · URL: https://mcp.magnific.com → OAuth sign-in",
    hint: "Also works in Windsurf, VS Code, Codex — any streamable-HTTP MCP client.",
  },
] as const;

export default function McpConsole() {
  const toast = useToast();
  const [client, setClient] = useState<(typeof CLIENTS)[number]["id"]>("claude");
  const [selected, setSelected] = useState<string>("account_balance");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState("");
  const [rawMode, setRawMode] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  const status = useJson<{ connected: boolean; server: string; serverInfo?: { name?: string; version?: string } | null; reason?: string; protocol?: string; issuer?: string | null; scope?: string | null; expiresAt?: number | null; sessionId?: string | null }>(
    "/api/mcp/status",
    { intervalMs: 30_000 },
  );
  const tools = useJson<ToolsPayload>("/api/mcp/tools", { intervalMs: 120_000 });

  const tool = useMemo(() => tools.data?.tools.find((t) => t.name === selected) ?? null, [tools.data, selected]);

  useEffect(() => {
    setArgs({});
    setResult(null);
    setRaw("{}");
  }, [selected]);

  const connect = async () => {
    try {
      const { url } = await postJson<{ url: string }>("/api/mcp/connect", {});
      window.open(url, "x-forge-mcp", "width=560,height=760");
      toast.push("info", "Approve the sign-in in the popup, then this panel refreshes");
      const t = setInterval(() => {
        status.reload();
        tools.reload();
      }, 4000);
      setTimeout(() => clearInterval(t), 120_000);
    } catch (e) {
      toast.push("err", (e as Error).message);
    }
  };

  const call = async (confirm = false) => {
    setBusy(true);
    try {
      const parsed = rawMode ? (JSON.parse(raw || "{}") as Record<string, unknown>) : coerce(args, tool);
      const r = await postJson<CallResult>("/api/mcp/call", { tool: selected, args: parsed, confirm });
      setResult(r);
      if (r.needsConfirmation) toast.push("info", r.message ?? "Confirm the spend to run this");
      else if (r.isError) toast.push("err", `${selected} reported an error`);
      else toast.push("ok", `${selected} · ${r.ms} ms`);
    } catch (e) {
      toast.push("err", (e as Error).message);
      setResult({ tool: selected, isError: true, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const groups = (tools.data?.groups ?? []).map((g) => ({
    ...g,
    items: g.items.filter((i) => !filter || i.name.includes(filter.toLowerCase())),
  }));

  return (
    <>
      <div className="intro">
        <div>
          <h1>MCP CONSOLE</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            Remote Model Context Protocol server · OAuth 2.1 with PKCE · no API key involved
          </div>
        </div>
        <div className="topbar-spacer" />
        <span className={`chip ${status.data?.connected ? "active" : ""}`}>
          <span className={`dot ${status.data?.connected ? "green" : "red"}`} /> {status.data?.connected ? "CONNECTED" : "OFFLINE"}
        </span>
        <span className="chip">{tools.data?.count ?? 0} TOOLS</span>
        <span className="chip">STREAMABLE HTTP</span>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1.05fr 1fr" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Server */}
          <div className="panel">
            <div className="panel-head">
              <span className={`dot ${status.data?.connected ? "green" : "red"}`} />
              <span className="panel-title">Server Endpoint</span>
              <span style={{ flex: 1 }} />
              {status.data?.connected ? (
                <button className="chip" onClick={() => void postJson("/api/mcp/disconnect", {}).then(() => { status.reload(); tools.reload(); })}>
                  DISCONNECT
                </button>
              ) : (
                <button className="btn primary" style={{ minHeight: 28 }} onClick={connect}>
                  ⌁ CONNECT
                </button>
              )}
            </div>
            <div className="panel-body">
              <div className="code-card" style={{ fontSize: 12, color: "var(--accent)" }}>
                {status.data?.server ?? "https://mcp.magnific.com"}
              </div>
              <div className="kv" style={{ marginTop: 12 }}>
                <span>transport</span>
                <b>{status.data?.protocol ?? "streamable HTTP"}</b>
              </div>
              <div className="kv">
                <span>server</span>
                <b>
                  {status.data?.serverInfo?.name ?? "—"} {status.data?.serverInfo?.version ?? ""}
                </b>
              </div>
              <div className="kv">
                <span>issuer</span>
                <b className="truncate">{status.data?.issuer ?? "—"}</b>
              </div>
              <div className="kv">
                <span>scope</span>
                <b className="truncate">{status.data?.scope ?? "—"}</b>
              </div>
              <div className="kv">
                <span>token expires</span>
                <b>{status.data?.expiresAt ? new Date(status.data.expiresAt).toLocaleString() : "—"}</b>
              </div>
              <div className="kv">
                <span>session</span>
                <b>{status.data?.sessionId ?? "—"}</b>
              </div>
              {status.data && !status.data.connected ? <div className="error-box" style={{ marginTop: 10 }}>{status.data.reason}</div> : null}
              <div className="eyebrow" style={{ marginTop: 14 }}>
                DISCOVERY
              </div>
              <div className="code-card" style={{ marginTop: 6 }}>
                {"/.well-known/oauth-protected-resource\n/.well-known/oauth-authorization-server"}
              </div>
            </div>
          </div>

          {/* Tool caller */}
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Call a tool</span>
              <span style={{ flex: 1 }} />
              <button className={`chip ${rawMode ? "active" : ""}`} onClick={() => setRawMode(!rawMode)}>
                RAW JSON
              </button>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div className="label">TOOL</div>
                <select className="select" value={selected} onChange={(e) => setSelected(e.target.value)}>
                  {tools.data?.tools.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {tool?.description ? <div className="hint">{tool.description.split("\n")[0].slice(0, 200)}</div> : null}
              </div>

              {rawMode ? (
                <div>
                  <div className="label">ARGUMENTS · JSON</div>
                  <div className="field col">
                    <textarea rows={6} value={raw} onChange={(e) => setRaw(e.target.value)} />
                  </div>
                </div>
              ) : tool?.schema?.properties && Object.keys(tool.schema.properties).length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 320, overflow: "auto" }}>
                  {Object.entries(tool.schema.properties).map(([name, spec]) => (
                    <div key={name}>
                      <div className="label">
                        {name}
                        {tool.schema?.required?.includes(name) ? " · REQUIRED" : ""} · {spec.type ?? "any"}
                      </div>
                      {spec.enum?.length ? (
                        <select className="select" value={args[name] ?? ""} onChange={(e) => setArgs((a) => ({ ...a, [name]: e.target.value }))}>
                          <option value="">—</option>
                          {spec.enum.map((v) => (
                            <option key={String(v)} value={String(v)}>
                              {String(v)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="field">
                          <input
                            placeholder={spec.description?.slice(0, 60) ?? spec.type}
                            value={args[name] ?? ""}
                            onChange={(e) => setArgs((a) => ({ ...a, [name]: e.target.value }))}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="hint">This tool takes no arguments.</div>
              )}

              <button className="btn primary" style={{ width: "100%" }} disabled={busy || !status.data?.connected} onClick={() => call(false)}>
                {busy ? "◷ CALLING…" : "▷ CALL TOOL"}
              </button>

              {result?.needsConfirmation ? (
                <div className="notice-box">
                  <b style={{ color: "var(--accent)" }}>{result.message}</b>
                  {result.estimate?.reason ? <div className="dim" style={{ marginTop: 6 }}>{result.estimate.reason}</div> : null}
                  <button className="btn accent" style={{ width: "100%", marginTop: 10 }} onClick={() => call(true)}>
                    ✓ CONFIRM AND SPEND
                  </button>
                </div>
              ) : null}

              {result && !result.needsConfirmation ? (
                <div className={result.isError ? "error-box" : "well"} style={{ padding: "11px 12px" }}>
                  <div className="eyebrow" style={{ marginBottom: 6 }}>
                    RESULT · {result.ms ?? 0} ms
                  </div>
                  {result.urls?.length ? (
                    <div className="gallery" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(90px,1fr))", marginBottom: 10 }}>
                      {result.urls.map((u) => (
                        <a className="thumb" key={u} href={u} target="_blank" rel="noreferrer">
                          <div className="thumb-img" style={{ height: 70 }}>
                            {/\.(png|jpe?g|webp|svg|gif)/i.test(u) ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={u} alt="" />
                            ) : (
                              <span>▶</span>
                            )}
                          </div>
                        </a>
                      ))}
                    </div>
                  ) : null}
                  <pre className="json">{typeof result.data === "string" ? result.data : JSON.stringify(result.data ?? result.text, null, 2)}</pre>
                </div>
              ) : null}
            </div>
          </div>

          {/* Client setup */}
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">Connect another client</span>
            </div>
            <div className="panel-body">
              <div className="tabs" style={{ marginBottom: 12 }}>
                {CLIENTS.map((c) => (
                  <button key={c.id} className={`chip ${client === c.id ? "active" : ""}`} onClick={() => setClient(c.id)}>
                    {c.label}
                  </button>
                ))}
              </div>
              {CLIENTS.filter((c) => c.id === client).map((c) => (
                <div key={c.id}>
                  <div className="code-card">{c.body}</div>
                  <div className="hint">{c.hint}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Catalogue */}
        <div className="panel" style={{ alignSelf: "start" }}>
          <div className="panel-head">
            <span className="dot accent" />
            <span className="panel-title">Tool Catalog</span>
            <span style={{ flex: 1 }} />
            <div className="field" style={{ minHeight: 28, width: 150 }}>
              <input placeholder="⌕ filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <button className="chip" onClick={() => tools.reload()}>
              ⟳
            </button>
          </div>
          <div className="panel-body scroll-y" style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: 1100 }}>
            {!tools.data?.connected ? (
              <div className="empty-state">
                <div className="empty-title">Not connected</div>
                <div className="nav-sub">the catalogue is whatever tools/list answers — connect to read it</div>
              </div>
            ) : (
              groups.map((g) =>
                g.items.length ? (
                  <div key={g.name}>
                    <div className="eyebrow" style={{ marginBottom: 8 }}>
                      {g.name}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      {g.items.map((t) => (
                        <div className="mcp-tool clickable" key={t.name} onClick={() => setSelected(t.name)}>
                          <code>{t.name}</code>
                          <small style={{ flex: 1 }}>{t.description}</small>
                          <span className={`badge ${t.free ? "green" : "amber"}`}>{t.free ? "FREE" : "CREDITS"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null,
              )
            )}
          </div>
          <div className="panel-foot">
            The server is the source of truth — this list is `tools/list`, read live, not a snapshot in this repository.
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Turn a form of strings into the types the schema asks for.
 *
 * Sending `"5"` where a tool wants a number is a validation error from the server, which
 * reads as "the console is broken" rather than "a text input holds text".
 */
function coerce(args: Record<string, string>, tool: ToolInfo | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === "") continue;
    const type = tool?.schema?.properties?.[k]?.type;
    if (type === "number" || type === "integer") out[k] = Number(v);
    else if (type === "boolean") out[k] = v === "true" || v === "1";
    else if (type === "array" || type === "object") {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    } else out[k] = v;
  }
  return out;
}
