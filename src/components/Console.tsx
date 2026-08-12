"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { AskProvider, ToastProvider, useJson, num } from "./ui";
import { LangProvider, LANGS, LANG_LABEL, LANG_NAME, useLang, useT } from "@/lib/i18n";
import Dashboard from "./views/Dashboard";
import Chat from "./views/Chat";
import ImageForge from "./views/ImageForge";
import VideoForge from "./views/VideoForge";
import AudioLab from "./views/AudioLab";
import SoulForge from "./views/SoulForge";
import IconFoundry from "./views/IconFoundry";
import UpscaleStudio from "./views/UpscaleStudio";
import EditSuite from "./views/EditSuite";
import Flows from "./views/Flows";
import TaskQueue from "./views/TaskQueue";
import Creations from "./views/Creations";
import Stock from "./views/Stock";
import Utilities from "./views/Utilities";
import McpConsole from "./views/McpConsole";
import Analytics from "./views/Analytics";
import Developers from "./views/Developers";

/**
 * The console shell.
 *
 * The prototype's sidebar, topbar and view switch, kept structurally identical — same
 * sections, same order, same glyphs — with the two differences a live console needs: the
 * status line and credit chip are read from the server, and views are mounted only while
 * they are shown so fifteen panels do not poll fifteen endpoints at once.
 */

export interface Status {
  rest: { connected: boolean; base: string; credential: { present: boolean; last4?: string; fingerprint?: string; verifiedAt?: string | null } };
  mcp: { connected: boolean; server: string; issuer: string | null; scope: string | null; expiresAt: number | null };
  balance: { available: number; reserved: number; spendable: number; totalPlan: number | null; spent: number | null; tier: string | null; at: string } | null;
  today: { credits: number; jobs: number };
  openJobs: number;
  shaper: { tenantRpm: number; tenantLimit: number; globalRpm: number; globalLimit: number; burst: number };
  vault: { root: string; files: number; bytes: number; byKind: Record<string, { files: number; bytes: number }> };
  tenant: {
    id: string;
    displayName: string;
    status: string;
    creditFloor: number;
    approvalThreshold: number;
    videoEnabled: boolean;
    maxConcurrentJobs: number;
    rpmLimit: number;
    retentionDays: number;
  };
}

interface Nav {
  view: string;
  go: (v: string) => void;
  status: Status | null;
  reloadStatus: () => void;
}

const NavCtx = createContext<Nav>({ view: "dashboard", go: () => {}, status: null, reloadStatus: () => {} });
export function useNav() {
  return useContext(NavCtx);
}

const SECTIONS: { title: string; items: { id: string; glyph: string; name: string; sub: string; dot?: boolean }[] }[] = [
  {
    title: "OVERVIEW",
    items: [
      { id: "dashboard", glyph: "▦", name: "Dashboard", sub: "Credits · health · queue" },
      { id: "chat", glyph: "◈", name: "Chat", sub: "Local CLIs · providers · skills" },
    ],
  },
  {
    title: "GENERATE",
    items: [
      { id: "image-forge", glyph: "✦", name: "Image Forge", sub: "Mystic + full catalogue" },
      { id: "video-forge", glyph: "▶", name: "Video Forge", sub: "Kling · Veo · WAN · more" },
      { id: "audio-lab", glyph: "♫", name: "Audio Lab", sub: "Music · SFX · TTS · SAM" },
      { id: "soul-forge", glyph: "◈", name: "3D & Soul", sub: "models3d · custom refs" },
      { id: "icon-foundry", glyph: "◉", name: "Icon Foundry", sub: "text → icon · library" },
    ],
  },
  {
    title: "ENHANCE",
    items: [
      { id: "upscale", glyph: "⇱", name: "Upscale Studio", sub: "Creative · Precision V2" },
      { id: "edit-suite", glyph: "✂", name: "Edit Suite", sub: "Relight · expand · cutout" },
    ],
  },
  {
    title: "PIPELINE",
    items: [
      { id: "flows", glyph: "⌘", name: "Flows", sub: "Spaces pipelines" },
      { id: "tasks", glyph: "≣", name: "Task Queue", sub: "Async jobs · webhooks" },
    ],
  },
  {
    title: "LIBRARY",
    items: [
      { id: "creations", glyph: "▤", name: "Creations", sub: "Gallery · folders · spaces" },
      { id: "stock", glyph: "❖", name: "Stock", sub: "Images · video · audio" },
    ],
  },
  { title: "INTELLIGENCE", items: [{ id: "utilities", glyph: "⚗", name: "Utilities", sub: "I2P · improve · classify" }] },
  {
    title: "CONNECT",
    items: [
      { id: "mcp", glyph: "⌁", name: "MCP Console", sub: "mcp.magnific.com · OAuth", dot: true },
      { id: "analytics", glyph: "∿", name: "Analytics", sub: "Usage · audit logs" },
      { id: "developers", glyph: "⚙", name: "Developers", sub: "Keys · webhooks · uploads" },
    ],
  },
];

const VIEWS: Record<string, () => React.ReactElement> = {
  dashboard: Dashboard,
  chat: Chat,
  "image-forge": ImageForge,
  "video-forge": VideoForge,
  "audio-lab": AudioLab,
  "soul-forge": SoulForge,
  "icon-foundry": IconFoundry,
  upscale: UpscaleStudio,
  "edit-suite": EditSuite,
  flows: Flows,
  tasks: TaskQueue,
  creations: Creations,
  stock: Stock,
  utilities: Utilities,
  mcp: McpConsole,
  analytics: Analytics,
  developers: Developers,
};

/**
 * The provider has to sit ABOVE anything that translates, including the shell itself —
 * a `useT()` called in the same component that renders `<LangProvider>` reads the context
 * default and silently stays English.
 */
export default function Console() {
  return (
    <LangProvider>
      <Shell />
    </LangProvider>
  );
}

function Shell() {
  const t = useT();
  const [view, setView] = useState("dashboard");
  const { data: status, reload } = useJson<Status>("/api/status", { intervalMs: 15_000 });

  // The view is kept in the hash so a reload, or a link an operator sends themselves,
  // lands where they were rather than back on the dashboard.
  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.replace("#", "");
      if (h && VIEWS[h]) setView(h);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  const go = (v: string) => {
    setView(v);
    window.location.hash = v;
    document.querySelector(".content")?.scrollTo({ top: 0 });
  };

  const View = VIEWS[view] ?? Dashboard;

  return (
      <ToastProvider>
        <AskProvider>
        <NavCtx.Provider value={{ view, go, status: status ?? null, reloadStatus: reload }}>
        <div className="app">
          <aside className="sidebar">
            <div className="brand">
              <div className="brand-mark">◆</div>
              <div>
                <div className="brand-title">{t("X-FORGE")}</div>
                <div className="brand-sub">{t("api.magnific.com + MCP")}</div>
              </div>
            </div>

            <nav className="nav-scroll" id="nav">
              {SECTIONS.map((s) => (
                <div key={s.title} style={{ display: "contents" }}>
                  <div className="nav-section">{t(s.title)}</div>
                  {s.items.map((it) => (
                    <div
                      key={it.id}
                      className={`nav-item ${view === it.id ? "active" : ""}`}
                      onClick={() => go(it.id)}
                      role="button"
                      tabIndex={0}
                    >
                      <span className="nav-glyph">{it.glyph}</span>
                      <div>
                        <div className="nav-name">{t(it.name)}</div>
                        <div className="nav-sub">{t(it.sub)}</div>
                      </div>
                      {it.dot ? <span className={`dot ${status?.mcp.connected ? "green" : "red"}`} /> : null}
                    </div>
                  ))}
                </div>
              ))}
            </nav>

            <div className="operator">
              <span className="avatar" style={{ background: "var(--card-head)", border: "1px solid var(--border-2)", color: "var(--text-2)" }}>
                {(status?.tenant.displayName ?? "O").slice(0, 1)}
              </span>
              <div style={{ flex: 1 }}>
                <div className="nav-name">{status?.tenant.displayName ?? t("Operator")}</div>
                <div className="nav-sub">
                  {status?.balance?.tier ?? "—"} {t("plan")}
                </div>
              </div>
              <span className="icon-btn" title={t("Settings")} onClick={() => go("developers")} role="button" tabIndex={0}>
                ⚙
              </span>
              <span className="icon-btn" title={t("Queue")} onClick={() => go("tasks")} role="button" tabIndex={0}>
                ◉
              </span>
            </div>
          </aside>

          <main className="main">
            <Topbar />
            <div className="content">
              <section className="view active">
                <View />
              </section>
            </div>
          </main>
        </div>
        </NavCtx.Provider>
        </AskProvider>
      </ToastProvider>
  );
}

/**
 * The language picker the prototype drew as `EN ▾`.
 *
 * A list rather than a toggle: the chip shows the active language and the menu shows what
 * else exists, which is the difference between a control you can read and one you have to
 * click to understand. Each language is named in itself — a person looking for Ukrainian
 * is not helped by the word "Ukrainian".
 */
function LangSwitch() {
  const { lang, setLang } = useLang();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  // Closes on anything that means "I'm done here": a click elsewhere, or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="lang-picker" ref={box}>
      <button className={`chip ${open ? "active" : ""}`} onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        {LANG_LABEL[lang]} <span className={`lang-caret ${open ? "up" : ""}`}>⌄</span>
      </button>

      {open ? (
        <div className="lang-menu" role="listbox">
          {LANGS.map((l) => (
            <button
              key={l}
              className={`lang-option ${l === lang ? "active" : ""}`}
              role="option"
              aria-selected={l === lang}
              onClick={() => {
                setLang(l);
                setOpen(false);
              }}
            >
              <span className="lang-code">{LANG_LABEL[l]}</span>
              <span className="lang-name">{LANG_NAME[l]}</span>
              <span className="lang-tick">{l === lang ? "✓" : ""}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Topbar() {
  const { t, lang } = useLang();
  const { status, go } = useNav();
  const [now, setNow] = useState<Date | null>(null);

  // Rendered only after mount: the server has a different second than the browser, and a
  // clock is the one thing guaranteed to mismatch during hydration.
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const rest = status?.rest.connected;
  const mcp = status?.mcp.connected;

  // The date follows the chosen language. Hand-written month tables were fine while the
  // console spoke one language; `Intl` already knows every other one, and it declines the
  // Ukrainian months correctly, which a lookup table would not.
  const date = now
    ? new Intl.DateTimeFormat(lang, { weekday: "short", month: "short", day: "2-digit" }).format(now)
    : "";

  return (
    <header className="topbar">
      <div className="status-line">
        <span className={`dot ${rest ? "green" : "red"}`} />
        API <strong style={{ color: rest ? "var(--green-text)" : "var(--red)" }}>{rest ? t("connected") : t("offline")}</strong>
      </div>
      <div className="status-line">
        <span className={`dot ${mcp ? "green" : "red"}`} />
        MCP <strong style={{ color: mcp ? "var(--green-text)" : "var(--red)" }}>{mcp ? "OAuth" : t("not connected")}</strong>
      </div>
      <button className="chip active" onClick={() => go("analytics")}>
        ◆ {num(status?.balance?.spendable ?? null)} {t("CREDITS")}
      </button>
      <button className="chip" onClick={() => go("developers")}>
        {t("KEY")} · {status?.rest.credential.present ? `…${status.rest.credential.last4}` : t("none")}
      </button>
      <button className="chip" onClick={() => go("developers")}>
        {t("x-magnific-api-key")}
      </button>
      {status?.tenant.status !== "active" ? <span className="badge red">{status?.tenant.status.toUpperCase()}</span> : null}
      <div className="topbar-spacer" />
      <LangSwitch />
      <a className="icon-btn" title={t("Magnific docs")} href="https://docs.magnific.com" target="_blank" rel="noreferrer">
        ?
      </a>
      <button className="icon-btn" title={t("MCP console")} onClick={() => go("mcp")}>
        ▷
      </button>
      <div className="clock">
        <strong id="clock-time" suppressHydrationWarning>
          {now ? (
            <>
              {String(now.getHours()).padStart(2, "0")}:{String(now.getMinutes()).padStart(2, "0")}
              <span className="dim">:{String(now.getSeconds()).padStart(2, "0")}</span>
            </>
          ) : (
            "--:--"
          )}
        </strong>
        <small suppressHydrationWarning>{date}</small>
      </div>
    </header>
  );
}
