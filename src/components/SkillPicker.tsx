"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { useToast } from "./ui";

/**
 * Choosing skills, and installing new ones.
 *
 * The verdict is the point of this component. A skill is text that will be handed to a
 * model with a shell, so the panel refuses to install one the scanner rejected, offers an
 * override only for the middle verdict, and asks for a reason when the override is used —
 * a reason nobody reads at the time but somebody needs six months later, when the question
 * is how a particular skill got onto this machine.
 */

interface Skill {
  name: string;
  category: string;
  description: string;
}

interface Finding {
  severity: "critical" | "warn" | "info";
  rule: string;
  where: string;
  evidence: string;
}

interface Verdict {
  ok?: boolean;
  outcome: "INSTALL" | "REVIEW" | "REJECT";
  why: string;
  findings: Finding[];
  needsReview?: boolean;
  name?: string;
  candidates?: string[];
  error?: string;
}

interface Hit {
  name: string;
  skillId: string;
  source: string;
  installs?: number;
}

const VERDICT_COLOUR: Record<string, string> = {
  INSTALL: "var(--green-text)",
  REVIEW: "var(--accent)",
  REJECT: "var(--red)",
};

export default function SkillPicker({ agentId, selected, onChange }: { agentId: string; selected: string[]; onChange: (next: string[]) => void }) {
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"installed" | "find">("installed");
  const [installed, setInstalled] = useState<Skill[]>([]);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const box = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/chat/skills?agent=${encodeURIComponent(agentId)}`);
      const json = (await res.json()) as { skills?: Skill[] };
      setInstalled(json.skills ?? []);
    } catch {
      setInstalled([]);
    }
  }, [agentId]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

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

  // The registry is searched as you type, but not on every keystroke: it is somebody else's
  // service and a search per character is rude to it and useless to the reader.
  useEffect(() => {
    if (tab !== "find" || !query.trim()) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void fetch(`/api/chat/skills?agent=${encodeURIComponent(agentId)}&q=${encodeURIComponent(query)}`)
        .then((r) => r.json() as Promise<{ results?: Hit[]; error?: string }>)
        .then((r) => {
          setHits(r.results ?? []);
          if (r.error) toast.push("err", r.error);
        })
        .catch(() => setHits([]));
    }, 450);
    return () => clearTimeout(timer);
  }, [query, tab, agentId, toast]);

  const install = async (hit: Hit, force: boolean) => {
    let reason = "";
    if (force) {
      const answer = window.prompt(t("This skill needs review. Why install it anyway?"));
      if (!answer?.trim()) return;
      reason = answer.trim();
    }
    setBusy(hit.skillId);
    try {
      const res = await fetch("/api/chat/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, source: hit.source, skillId: hit.skillId, force, reason }),
      });
      const json = (await res.json()) as Verdict;
      setVerdicts((prev) => ({ ...prev, [hit.skillId]: json }));
      if (json.ok) {
        toast.push("ok", t("{name} installed", { name: json.name ?? hit.skillId }));
        await reload();
      } else if (json.outcome === "REJECT") {
        toast.push("err", t("Refused: {why}", { why: json.why }));
      }
    } catch (e) {
      toast.push("err", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(t("Delete the {name} skill from disk?", { name }))) return;
    await fetch(`/api/chat/skills?agent=${encodeURIComponent(agentId)}&name=${encodeURIComponent(name)}`, { method: "DELETE" });
    onChange(selected.filter((s) => s !== name));
    await reload();
  };

  const groups = installed
    .filter((s) => !filter || `${s.name} ${s.description}`.toLowerCase().includes(filter.toLowerCase()))
    .reduce<Record<string, Skill[]>>((acc, s) => {
      (acc[s.category] ??= []).push(s);
      return acc;
    }, {});

  return (
    <div className="lang-picker" ref={box}>
      <button className={`chip ${selected.length ? "active" : ""}`} onClick={() => setOpen((v) => !v)}>
        ⚡ {t("SKILLS")}
        {selected.length ? ` · ${selected.length}` : ""}
      </button>

      {open ? (
        <div className="skill-menu">
          <div className="skill-tabs">
            <button className={`seg-btn ${tab === "installed" ? "active" : ""}`} onClick={() => setTab("installed")}>
              {t("Installed")} · {installed.length}
            </button>
            <button className={`seg-btn ${tab === "find" ? "active" : ""}`} onClick={() => setTab("find")}>
              {t("Find new")}
            </button>
          </div>

          {tab === "installed" ? (
            <>
              <div className="field" style={{ margin: "8px 0" }}>
                <input placeholder={t("Search {n} installed skills…", { n: installed.length })} value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
              <div className="skill-list">
                {installed.length === 0 ? <div className="hint">{t("No skills installed for this model yet.")}</div> : null}
                {Object.entries(groups).map(([category, list]) => (
                  <div key={category}>
                    <div className="eyebrow" style={{ margin: "8px 0 4px" }}>
                      {category}
                    </div>
                    {list.slice(0, 200).map((s) => {
                      const on = selected.includes(s.name);
                      return (
                        <div key={s.name} className="skill-row">
                          <button
                            className="skill-toggle"
                            onClick={() => onChange(on ? selected.filter((x) => x !== s.name) : [...selected, s.name])}
                            style={{ color: on ? "var(--accent)" : "var(--text-2)" }}
                          >
                            <span className="skill-box">{on ? "✓" : ""}</span>
                            <span>
                              <b className="mono">{s.name}</b>
                              {s.description ? <span className="dim"> — {s.description}</span> : null}
                            </span>
                          </button>
                          <button className="icon-btn" title={t("Delete")} onClick={() => void remove(s.name)}>
                            ✕
                          </button>
                        </div>
                      );
                    })}
                    {list.length > 200 ? <div className="hint">{t("…and {n} more — narrow the search", { n: list.length - 200 })}</div> : null}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="field" style={{ margin: "8px 0" }}>
                <input placeholder={t("Search skills.sh…")} value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div className="hint" style={{ marginBottom: 6 }}>
                {t("Every download is scanned before anything is written to disk.")}
              </div>
              <div className="skill-list">
                {hits.map((hit) => {
                  const verdict = verdicts[hit.skillId];
                  const already = installed.some((s) => s.name === hit.skillId);
                  return (
                    <div key={`${hit.source}/${hit.skillId}`} className="skill-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 5 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <b className="mono">{hit.skillId}</b>
                          <span className="dim"> · {hit.source}</span>
                        </span>
                        {already ? (
                          <span className="tag" style={{ color: "var(--green-text)" }}>
                            {t("installed")}
                          </span>
                        ) : verdict?.outcome === "REJECT" ? (
                          <span className="tag" style={{ color: "var(--red)" }}>
                            {t("blocked")}
                          </span>
                        ) : verdict?.needsReview ? (
                          <button className="chip" style={{ fontSize: 8.5 }} disabled={busy === hit.skillId} onClick={() => void install(hit, true)}>
                            {t("INSTALL ANYWAY")}
                          </button>
                        ) : (
                          <button className="chip active" style={{ fontSize: 8.5 }} disabled={busy === hit.skillId} onClick={() => void install(hit, false)}>
                            {busy === hit.skillId ? t("◷ SCANNING…") : t("INSTALL")}
                          </button>
                        )}
                      </div>
                      {verdict ? <VerdictCard verdict={verdict} /> : null}
                    </div>
                  );
                })}
                {query && !hits.length ? <div className="hint">{t("Nothing matched on skills.sh.")}</div> : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function VerdictCard({ verdict }: { verdict: Verdict }) {
  const t = useT();
  return (
    <div className="well" style={{ padding: "7px 9px", fontSize: 10 }}>
      <div style={{ color: VERDICT_COLOUR[verdict.outcome], fontWeight: 700, letterSpacing: 1 }}>
        {verdict.outcome === "INSTALL" ? "✓" : verdict.outcome === "REVIEW" ? "⚠" : "⛔"} {verdict.outcome}
      </div>
      <div className="dim" style={{ marginTop: 3 }}>
        {verdict.why || verdict.error}
      </div>
      {verdict.findings?.slice(0, 6).map((f, i) => (
        <div key={i} className="mono" style={{ marginTop: 3, color: f.severity === "critical" ? "var(--red)" : "var(--text-3)" }}>
          [{f.severity}] {f.rule} · {f.where}
        </div>
      ))}
      {verdict.candidates?.length ? (
        <div className="dim" style={{ marginTop: 3 }}>
          {t("holds:")} {verdict.candidates.slice(0, 8).join(", ")}
        </div>
      ) : null}
    </div>
  );
}
