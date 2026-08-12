"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { readEvent, type ChatEvent } from "@/lib/chatEvents";
import { stash, TARGETS } from "@/lib/handoff";
import { useNav } from "../Console";
import { bytes as humanBytes, useAsk, useJson, useToast } from "../ui";
import SkillPicker from "../SkillPicker";

/**
 * Chat.
 *
 * One conversation with a model selector, not one conversation per model. The models are
 * not Magnific's — they are the coding CLIs already installed on this machine, each holding
 * its own credentials, plus any OpenAI-shaped provider with a key in `.env.local`. Nothing
 * here spends Magnific credits, which is why there is no estimate, no reservation and no
 * approval gate: the console is not paying, the CLI's own account is.
 *
 * The transcript lives in this browser and the CLI keeps its own, better one on disk; the
 * console resumes that by id rather than maintaining a worse copy. Because those session
 * ids belong to one CLI each, they are kept per model — switch to Grok and back, and Claude
 * picks up where it was, while Grok is handed a short recap so a switch mid-conversation
 * does not read as amnesia.
 */

interface CliAgent {
  id: string;
  label: string;
  kind: string;
  glyph: string;
  colour: string;
  models: string[];
  supports: { resume?: boolean; effort?: boolean; permission?: boolean; systemPrompt?: boolean };
  skillsDir: string | null;
  dialect: string;
  available: boolean;
  where: string | null;
}

interface ProviderInfo {
  id: string;
  label: string;
  base: string;
  builtin: boolean;
  configured: boolean;
}

interface Choice {
  id: string;
  provider: boolean;
  model?: string;
}

interface Attachment {
  name: string;
  path: string;
  kind: string;
  bytes: number;
  dataUrl?: string;
}

type Block =
  | { kind: "text"; text: string; streaming?: boolean }
  | { kind: "tool"; id?: string; name: string; input?: string; done?: boolean };

interface Msg {
  role: "user" | "assistant" | "system";
  at: number;
  blocks: Block[];
  files?: { name: string; kind: string }[];
}

interface Turn {
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  failed?: boolean;
}

const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
const PERMISSIONS = ["default", "acceptEdits", "plan", "bypassPermissions"];

const CHATS = "x-forge.chat.list";
const ACTIVE = "x-forge.chat.active";
const skillsKey = (id: string) => `x-forge.skills.${id}`;

/**
 * A saved conversation.
 *
 * `sessions` maps a model id to the id of the CLI transcript that belongs to this
 * conversation, which is what lets an old chat be reopened and continued rather than merely
 * read: the browser holds what was said, the CLI holds the real context, and this is the
 * thread between them.
 */
interface Conversation {
  id: string;
  title: string;
  at: number;
  msgs: Msg[];
  sessions: Record<string, string>;
}

interface CliSession {
  id: string;
  title: string;
  at: string;
  bytes: number;
}

function loadChats(): Conversation[] {
  try {
    return (JSON.parse(window.localStorage.getItem(CHATS) ?? "[]") as Conversation[]).filter((c) => c?.id);
  } catch {
    return [];
  }
}

/** The first thing the operator said, which is what they will recognise it by later. */
function titleOf(msgs: Msg[]): string {
  const first = msgs.find((m) => m.role === "user");
  const text = first?.blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("") ?? "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 70) : "untitled";
}

export default function Chat() {
  const t = useT();
  const toast = useToast();
  const ask = useAsk();
  const { go } = useNav();
  const fleet = useJson<{ cli: CliAgent[]; providers: ProviderInfo[] }>("/api/chat/agents", { intervalMs: 30_000 });
  const saved = useJson<{ choice: Choice }>("/api/chat/settings");

  const [choice, setChoice] = useState<Choice>({ id: "claude", provider: false });
  const [effort, setEffort] = useState("");
  const [permission, setPermission] = useState("default");
  const [cwd, setCwd] = useState("");

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [running, setRunning] = useState(false);
  const [sessions, setSessions] = useState<Record<string, string>>({});
  const [chatId, setChatId] = useState<string>("");
  const [chats, setChats] = useState<Conversation[]>([]);
  const [tab, setTab] = useState<"chat" | "history" | "sessions">("chat");
  const [cliSessions, setCliSessions] = useState<CliSession[]>([]);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [skills, setSkills] = useState<string[]>([]);
  const [providerModels, setProviderModels] = useState<{ id: string; label: string }[]>([]);

  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement | null>(null);
  const filePick = useRef<HTMLInputElement | null>(null);

  const cli = fleet.data?.cli ?? [];
  const providers = fleet.data?.providers ?? [];
  const active = choice.provider ? undefined : cli.find((a) => a.id === choice.id);
  const activeProvider = choice.provider ? providers.find((p) => p.id === choice.id) : undefined;
  const dialect = active?.dialect ?? "claude";
  const title = activeProvider?.label ?? active?.label ?? choice.id;
  const sessionId = sessions[choice.id];

  // The server holds the choice, so it is the same model in every tab and after a restart.
  useEffect(() => {
    if (saved.data?.choice) setChoice(saved.data.choice);
  }, [saved.data]);

  useEffect(() => {
    const list = loadChats();
    setChats(list);
    const wanted = window.localStorage.getItem(ACTIVE) ?? list[0]?.id ?? "";
    const open = list.find((c) => c.id === wanted) ?? list[0];
    setChatId(open?.id ?? `c${Date.now().toString(36)}`);
    setMsgs(open?.msgs ?? []);
    setSessions(open?.sessions ?? {});
  }, []);

  useEffect(() => {
    try {
      setSkills(JSON.parse(window.localStorage.getItem(skillsKey(choice.id)) ?? "[]") as string[]);
    } catch {
      setSkills([]);
    }
  }, [choice.id]);

  // An empty conversation is never saved: a list full of chats nobody said anything in is
  // worse than no list.
  useEffect(() => {
    if (!chatId || !msgs.length) return;
    const entry: Conversation = { id: chatId, title: titleOf(msgs), at: Date.now(), msgs: msgs.slice(-200), sessions };
    const next = [entry, ...loadChats().filter((c) => c.id !== chatId)].slice(0, 40);
    setChats(next);
    try {
      window.localStorage.setItem(CHATS, JSON.stringify(next));
      window.localStorage.setItem(ACTIVE, chatId);
    } catch {
      /* a full quota should not take the conversation down with it */
    }
  }, [msgs, sessions, chatId]);

  // The CLI's own transcripts, which outlive this browser entirely.
  useEffect(() => {
    if (tab !== "sessions" || choice.provider) return;
    void fetch(`/api/chat/sessions?agent=${encodeURIComponent(choice.id)}`)
      .then((r) => r.json() as Promise<{ sessions?: CliSession[] }>)
      .then((r) => setCliSessions(r.sessions ?? []))
      .catch(() => setCliSessions([]));
  }, [tab, choice.id, choice.provider]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [msgs, turn]);

  useEffect(() => {
    if (!choice.provider) {
      setProviderModels([]);
      return;
    }
    let live = true;
    void fetch(`/api/providers?models=${encodeURIComponent(choice.id)}`)
      .then((r) => r.json() as Promise<{ models?: { id: string; label: string }[]; error?: string }>)
      .then((r) => {
        if (!live) return;
        setProviderModels(r.models ?? []);
        if (r.error) toast.push("err", r.error);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [choice.provider, choice.id, toast]);

  const pick = useCallback(
    async (next: Choice) => {
      setChoice(next);
      setTurn(null);
      try {
        await fetch("/api/chat/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
      } catch {
        /* the choice still applies to this tab; the server copy catches up next time */
      }
    },
    [],
  );

  const chooseSkills = useCallback(
    (next: string[]) => {
      setSkills(next);
      try {
        window.localStorage.setItem(skillsKey(choice.id), JSON.stringify(next));
      } catch {
        /* the selection is a convenience, not state worth failing over */
      }
    },
    [choice.id],
  );

  const attach = useCallback(
    async (list: FileList | null) => {
      if (!list?.length) return;
      setUploading(true);
      for (const file of Array.from(list).slice(0, 8)) {
        try {
          const form = new FormData();
          form.append("file", file);
          const res = await fetch("/api/chat/upload", { method: "POST", body: form });
          const json = (await res.json()) as Attachment & { error?: string };
          if (json.error) toast.push("err", json.error);
          else setFiles((prev) => [...prev, json]);
        } catch (e) {
          toast.push("err", (e as Error).message);
        }
      }
      setUploading(false);
    },
    [toast],
  );

  const streamed = useRef(false);

  const apply = useCallback((event: ChatEvent, model: string) => {
    if (event.kind === "session") {
      setSessions((prev) => ({ ...prev, [model]: event.id }));
      return;
    }
    if (event.kind === "result") {
      setTurn({
        costUsd: event.costUsd,
        durationMs: event.durationMs,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        failed: event.failed,
      });
      return;
    }
    if (event.kind === "exit") return;

    setMsgs((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];

      if (event.kind === "error") {
        next.push({ role: "system", at: Date.now(), blocks: [{ kind: "text", text: event.message }] });
        return next;
      }

      if (!last || last.role !== "assistant") next.push({ role: "assistant", at: Date.now(), blocks: [] });
      const target = next[next.length - 1];
      const blocks = [...target.blocks];

      if (event.kind === "text") {
        // Claude streams deltas and then repeats the finished message; Kimi, Codex and Qwen
        // send only the finished one. Taking both would print every answer twice, so a
        // final is ignored once anything has been streamed in this turn.
        if (event.final && streamed.current) return prev;
        if (!event.final) streamed.current = true;

        const tail = blocks[blocks.length - 1];
        if (tail?.kind === "text" && tail.streaming) blocks[blocks.length - 1] = { ...tail, text: tail.text + event.text };
        else blocks.push({ kind: "text", text: event.text, streaming: !event.final });
      } else if (event.kind === "tool") {
        // The chip is opened by the stream and completed by the final message, so a tool
        // arriving with a known id updates rather than duplicates.
        const at = blocks.findIndex((b) => b.kind === "tool" && b.id && b.id === event.id);
        const chip: Block = { kind: "tool", id: event.id, name: event.name, input: event.input };
        if (at >= 0) blocks[at] = { ...blocks[at], ...chip };
        else blocks.push(chip);
      } else if (event.kind === "tool-done") {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === "tool" && !b.done) {
            blocks[i] = { ...b, done: true };
            break;
          }
        }
      }

      next[next.length - 1] = { ...target, blocks };
      return next;
    });
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if ((!text && !files.length) || running) return;

    const sending = files;
    setDraft("");
    setFiles([]);
    setTurn(null);
    setMsgs((prev) => [
      ...prev,
      { role: "user", at: Date.now(), blocks: [{ kind: "text", text }], files: sending.map((f) => ({ name: f.name, kind: f.kind })) },
    ]);
    setRunning(true);

    const model = choice.id;
    streamed.current = false;
    const controller = new AbortController();
    abort.current = controller;

    const plain = (m: Msg) => m.blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("");

    try {
      const history = msgs
        .filter((m) => m.role !== "system")
        .slice(-20)
        .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), content: plain(m) }))
        .filter((m) => m.content.trim());

      // A CLI that has no session for this conversation yet has no idea what was said
      // before it was picked. Handing it a short recap is what makes one chat behave like
      // one chat when the model is switched halfway through.
      const needsRecap = !choice.provider && !sessions[model] && history.length > 0;
      const recap = needsRecap
        ? `Earlier in this conversation:\n${history
            .slice(-6)
            .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 600)}`)
            .join("\n")}\n\n---\n\n`
        : "";

      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          agentId: choice.provider ? "claude" : model,
          providerId: choice.provider ? model : undefined,
          prompt: `${recap}${text}`,
          model: choice.model || undefined,
          sessionId: choice.provider ? undefined : sessions[model],
          effort: effort || undefined,
          permission,
          skills,
          cwd: cwd || undefined,
          attachments: sending,
          history: choice.provider ? history : undefined,
        }),
      });

      if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
        const json = (await res.json()) as { error?: string };
        apply({ kind: "error", message: json.error ?? `the server answered ${res.status}` }, model);
        return;
      }
      if (!res.body) throw new Error("no stream came back");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              for (const event of readEvent(dialect, JSON.parse(line.slice(6)) as Record<string, unknown>)) apply(event, model);
            } catch {
              /* a half-delivered frame is not an error worth showing */
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") apply({ kind: "error", message: (e as Error).message }, model);
    } finally {
      setRunning(false);
      abort.current = null;
      setMsgs((prev) =>
        prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, blocks: m.blocks.map((b) => (b.kind === "text" ? { ...b, streaming: false } : b)) } : m,
        ),
      );
    }
  }, [draft, files, running, msgs, choice, sessions, effort, permission, skills, cwd, dialect, apply]);

  const newChat = () => {
    abort.current?.abort();
    setChatId(`c${Date.now().toString(36)}`);
    setMsgs([]);
    setSessions({});
    setTurn(null);
    setTab("chat");
  };

  const openChat = (c: Conversation) => {
    abort.current?.abort();
    setChatId(c.id);
    setMsgs(c.msgs);
    setSessions(c.sessions ?? {});
    setTurn(null);
    setTab("chat");
    try {
      window.localStorage.setItem(ACTIVE, c.id);
    } catch {
      /* the conversation is open either way */
    }
  };

  const dropChat = (id: string) => {
    const next = loadChats().filter((c) => c.id !== id);
    setChats(next);
    try {
      window.localStorage.setItem(CHATS, JSON.stringify(next));
    } catch {
      /* nothing to clean up */
    }
    if (id === chatId) newChat();
  };

  /** Continue a transcript the CLI wrote, which may predate this console entirely. */
  const resumeCli = (session: CliSession) => {
    abort.current?.abort();
    setChatId(`c${Date.now().toString(36)}`);
    setMsgs([{ role: "system", at: Date.now(), blocks: [{ kind: "text", text: t("Resumed {id} — the model has the earlier context, this panel does not.", { id: session.id.slice(0, 8) }) }] }]);
    setSessions({ [choice.id]: session.id });
    setTurn(null);
    setTab("chat");
  };

  const push = (view: string, prompt: string, label: string) => {
    stash(view, { prompt, from: title });
    toast.push("ok", t("Sent to {label}", { label }));
    go(view);
  };

  const models = choice.provider ? providerModels.map((m) => m.id) : active?.models ?? [""];

  return (
    <>
      <div className="intro">
        <div>
          <h1>{t("CHAT")}</h1>
          <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
            {t("models installed on this machine · providers on your own keys · skills")}
          </div>
        </div>
        <div className="topbar-spacer" />
        <ModelChooser cli={cli} providers={providers} choice={choice} onPick={pick} />
        <button className="chip" onClick={newChat}>
          {t("+ NEW CHAT")}
        </button>
      </div>

      <div className="chat-layout">
        <div className="panel chat-panel" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div className="panel-head">
            <span
              className="avatar"
              style={{ background: activeProvider ? "var(--accent)" : active?.colour ?? "var(--accent)", width: 22, height: 22, fontSize: 11 }}
            >
              {activeProvider ? "⇉" : active?.glyph ?? "◆"}
            </span>
            <span className="panel-title">{title}</span>
            <span className="tag">{activeProvider ? t("provider · your key") : active?.kind ?? ""}</span>
            <span style={{ flex: 1 }} />
            {!choice.provider && active?.skillsDir ? <SkillPicker agentId={choice.id} selected={skills} onChange={chooseSkills} /> : null}
            {sessionId ? <span className="tag mono">{sessionId.slice(0, 8)}</span> : null}
          </div>

          <div className="chat-tabs">
            <button className={`seg-btn ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}>
              {t("CHAT")}
            </button>
            <button className={`seg-btn ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>
              {t("HISTORY")} · {chats.length}
            </button>
            {!choice.provider ? (
              <button className={`seg-btn ${tab === "sessions" ? "active" : ""}`} onClick={() => setTab("sessions")}>
                {t("CLI SESSIONS")}
              </button>
            ) : null}
          </div>

          {tab === "history" ? (
            <div className="chat-log">
              <div className="hint" style={{ marginBottom: 6 }}>
                {t("Conversations held in this browser. The model's own transcript is under CLI SESSIONS.")}
              </div>
              {chats.length === 0 ? <div className="hint">{t("Nothing saved yet.")}</div> : null}
              {chats.map((c) => (
                <div key={c.id} className={`history-row ${c.id === chatId ? "active" : ""}`}>
                  <button className="history-open" onClick={() => openChat(c)}>
                    <b>{c.title}</b>
                    <span className="dim">
                      {new Date(c.at).toLocaleString()} · {c.msgs.length} {t("messages")}
                    </span>
                  </button>
                  <button className="icon-btn" title={t("Delete")} onClick={() => dropChat(c.id)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : tab === "sessions" ? (
            <div className="chat-log">
              <div className="hint" style={{ marginBottom: 6 }}>
                {t("Transcripts {label} wrote on this machine. Opening one continues it — the model keeps the context, this panel starts empty.", { label: title })}
              </div>
              {cliSessions.length === 0 ? <div className="hint">{t("No transcripts found for this model.")}</div> : null}
              {cliSessions.map((session) => (
                <div key={session.id} className="history-row">
                  <button className="history-open" onClick={() => resumeCli(session)}>
                    <b>{session.title}</b>
                    <span className="dim mono">
                      {new Date(session.at).toLocaleString()} · {session.id.slice(0, 8)}
                    </span>
                  </button>
                  <button
                    className="icon-btn"
                    title={t("Delete")}
                    onClick={async () => {
                      const yes = await ask.confirm({
                        title: t("Delete this transcript?"),
                        body: t("It is removed from disk — this is the model's own record of the conversation, not just this console's copy."),
                        confirmLabel: t("DELETE"),
                        danger: true,
                      });
                      if (!yes) return;
                      await fetch(`/api/chat/sessions?agent=${encodeURIComponent(choice.id)}&id=${encodeURIComponent(session.id)}`, { method: "DELETE" });
                      setCliSessions((prev) => prev.filter((x) => x.id !== session.id));
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : (
          <div className="chat-log" ref={log}>
            {msgs.length === 0 ? (
              <div className="empty-state" style={{ margin: "auto", textAlign: "center" }}>
                <div className="empty-symbols" style={{ fontSize: 30, color: active?.colour ?? "var(--accent)" }}>
                  {activeProvider ? "⇉" : active?.glyph ?? "◆"}
                </div>
                <div className="empty-title">{t("Talk to {name}", { name: title })}</div>
                <div className="hint" style={{ maxWidth: 430, margin: "6px auto 0" }}>
                  {activeProvider
                    ? t("This runs over your provider key and is billed by them, not by Magnific.")
                    : t("This runs the CLI already installed on this machine, with its own sign-in and its own transcript.")}
                </div>
              </div>
            ) : (
              msgs.map((m, i) => (
                <Message
                  key={`${m.at}-${i}`}
                  msg={m}
                  colour={active?.colour}
                  glyph={activeProvider ? "⇉" : active?.glyph}
                  onPush={push}
                />
              ))
            )}
            {turn ? <ResultBar turn={turn} /> : null}
          </div>
          )}

          <div className="panel-foot" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {skills.length ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {skills.map((s) => (
                  <button key={s} className="chip active" style={{ fontSize: 8.5 }} onClick={() => chooseSkills(skills.filter((x) => x !== s))}>
                    ⚡ {s} ✕
                  </button>
                ))}
              </div>
            ) : null}

            {files.length ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {files.map((f, i) => (
                  <button
                    key={`${f.path}-${i}`}
                    className="chip"
                    style={{ fontSize: 8.5 }}
                    onClick={() => setFiles(files.filter((_, at) => at !== i))}
                    title={f.path}
                  >
                    📎 {f.name} · {humanBytes(f.bytes)} ✕
                  </button>
                ))}
              </div>
            ) : null}

            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <input
                ref={filePick}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  void attach(e.target.files);
                  e.target.value = "";
                }}
              />
              <button className="btn" title={t("Attach a file")} disabled={uploading} onClick={() => filePick.current?.click()}>
                {uploading ? "◷" : "⊕"}
              </button>
              <textarea
                className="composer"
                rows={Math.min(6, Math.max(1, draft.split("\n").length))}
                placeholder={t("Message {name}…", { name: title })}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onPaste={(e) => {
                  // A screenshot in the clipboard is the commonest attachment there is, and
                  // making somebody save it to disk first to send it is a step for nothing.
                  const pasted = Array.from(e.clipboardData.files);
                  if (pasted.length) {
                    e.preventDefault();
                    const bag = new DataTransfer();
                    for (const f of pasted) bag.items.add(f);
                    void attach(bag.files);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {running ? (
                <button className="btn" onClick={() => abort.current?.abort()}>
                  {t("◼ STOP")}
                </button>
              ) : (
                <button className="btn primary" disabled={!draft.trim() && !files.length} onClick={() => void send()}>
                  {t("↑ SEND")}
                </button>
              )}
            </div>
            <div className="hint">{t("Enter sends · Shift+Enter starts a new line · paste or attach an image and ask about it")}</div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("Settings")}</span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              <div>
                <div className="label">{t("MODEL")}</div>
                <select className="select" value={choice.model ?? ""} onChange={(e) => void pick({ ...choice, model: e.target.value })}>
                  {(models.length ? models : [""]).map((m) => (
                    <option key={m} value={m}>
                      {m || t("default — the CLI decides")}
                    </option>
                  ))}
                </select>
              </div>

              {!choice.provider && active?.supports.effort ? (
                <div>
                  <div className="label">{t("EFFORT")}</div>
                  <select className="select" value={effort} onChange={(e) => setEffort(e.target.value)}>
                    {EFFORTS.map((e) => (
                      <option key={e} value={e}>
                        {e || t("default")}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {!choice.provider && active?.supports.permission ? (
                <div>
                  <div className="label">{t("PERMISSIONS")}</div>
                  <select className="select" value={permission} onChange={(e) => setPermission(e.target.value)}>
                    {PERMISSIONS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <div className="hint" style={{ marginTop: 5 }}>
                    {t("These models can edit files. The permission mode decides what they may do without asking.")}
                  </div>
                </div>
              ) : null}

              {!choice.provider ? (
                <div>
                  <div className="label">{t("WORKING DIRECTORY")}</div>
                  <div className="field">
                    <input placeholder="~" value={cwd} onChange={(e) => setCwd(e.target.value)} />
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="dot accent" />
              <span className="panel-title">{t("This turn")}</span>
            </div>
            <div className="panel-body">
              <div className="metric-row" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div className="stat">
                  <div className="stat-value" style={{ color: "var(--accent)" }}>
                    {turn?.costUsd !== undefined ? `$${turn.costUsd.toFixed(4)}` : "—"}
                  </div>
                  <div className="stat-label">{t("COST")}</div>
                </div>
                <div className="stat">
                  <div className="stat-value">{turn?.durationMs ? `${(turn.durationMs / 1000).toFixed(1)}s` : "—"}</div>
                  <div className="stat-label">{t("DURATION")}</div>
                </div>
                <div className="stat">
                  <div className="stat-value">{turn?.inputTokens ?? "—"}</div>
                  <div className="stat-label">{t("TOKENS IN")}</div>
                </div>
                <div className="stat">
                  <div className="stat-value">{turn?.outputTokens ?? "—"}</div>
                  <div className="stat-label">{t("TOKENS OUT")}</div>
                </div>
              </div>
              <div className="hint" style={{ marginTop: 8 }}>
                {t("Reported by the model, not by X-Forge — no Magnific credits are involved here.")}
              </div>
            </div>
          </div>

          {active && !active.available && !choice.provider ? (
            <div className="panel">
              <div className="panel-head">
                <span className="dot red" />
                <span className="panel-title">{t("Not installed")}</span>
              </div>
              <div className="panel-body">
                <div className="hint">
                  {t("The {bin} command is not on this machine's PATH. Install it, or pick another model.", { bin: choice.id })}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

/**
 * The model selector.
 *
 * One control for both kinds, because from where the operator sits they are the same
 * decision: which model answers. The availability light is the same one the settings panel
 * uses, and an unreachable model stays on the list rather than disappearing — a model going
 * quiet must never look like the console silently reassigned the choice.
 */
function ModelChooser({
  cli,
  providers,
  choice,
  onPick,
}: {
  cli: CliAgent[];
  providers: ProviderInfo[];
  choice: Choice;
  onPick: (c: Choice) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  const current = choice.provider ? providers.find((p) => p.id === choice.id) : cli.find((a) => a.id === choice.id);
  const label = current?.label ?? choice.id;

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
      <button className="chip active" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="dim" style={{ fontSize: 7.5, letterSpacing: 1, marginRight: 6 }}>
          {t("MODEL")}
        </span>
        {label} <span className={`lang-caret ${open ? "up" : ""}`}>⌄</span>
      </button>

      {open ? (
        <div className="model-menu" role="listbox">
          <div className="eyebrow" style={{ padding: "4px 8px" }}>
            {t("INSTALLED ON THIS MACHINE")}
          </div>
          {cli.map((a) => (
            <Row
              key={a.id}
              glyph={a.glyph}
              colour={a.colour}
              label={a.label}
              sub={a.available ? a.kind : t("not installed")}
              on={a.available}
              active={!choice.provider && choice.id === a.id}
              onClick={() => {
                onPick({ id: a.id, provider: false });
                setOpen(false);
              }}
            />
          ))}
          <div className="eyebrow" style={{ padding: "8px 8px 4px" }}>
            {t("PROVIDERS")}
          </div>
          {providers.map((p) => (
            <Row
              key={p.id}
              glyph="⇉"
              colour="var(--accent)"
              label={p.label}
              sub={p.configured ? t("your key") : t("no key")}
              on={p.configured}
              active={choice.provider && choice.id === p.id}
              onClick={() => {
                onPick({ id: p.id, provider: true });
                setOpen(false);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Row({
  glyph,
  colour,
  label,
  sub,
  on,
  active,
  onClick,
}: {
  glyph: string;
  colour: string;
  label: string;
  sub: string;
  on: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`model-option ${active ? "active" : ""}`} onClick={onClick} role="option" aria-selected={active}>
      <span className="avatar" style={{ background: colour, width: 20, height: 20, fontSize: 10 }}>
        {glyph}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <b>{label}</b>
        <span className="dim" style={{ display: "block", fontSize: 9 }}>
          {sub}
        </span>
      </span>
      <span className={`dot ${on ? "green" : "red"}`} />
      <span className="lang-tick">{active ? "✓" : ""}</span>
    </button>
  );
}

function Message({
  msg,
  colour,
  glyph,
  onPush,
}: {
  msg: Msg;
  colour?: string;
  glyph?: string;
  onPush: (view: string, prompt: string, label: string) => void;
}) {
  const t = useT();
  const who = msg.role === "user" ? t("YOU") : msg.role === "system" ? t("CONSOLE") : t("MODEL");
  const text = msg.blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();

  return (
    <div className={`message ${msg.role === "user" ? "user" : ""}`}>
      <div className="message-meta">{who}</div>
      <div className="bubble-line">
        {msg.role !== "user" ? (
          <span
            className="avatar"
            style={{ background: msg.role === "system" ? "var(--red)" : colour ?? "var(--accent)", width: 24, height: 24, fontSize: 11 }}
          >
            {msg.role === "system" ? "!" : glyph ?? "◆"}
          </span>
        ) : null}
        <div className="bubble" style={msg.role === "system" ? { borderColor: "var(--red)" } : undefined}>
          {msg.files?.length ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
              {msg.files.map((f, i) => (
                <span key={i} className="tag">
                  📎 {f.name}
                </span>
              ))}
            </div>
          ) : null}
          {msg.blocks.map((b, i) =>
            b.kind === "text" ? (
              <Prose key={i} text={b.text} streaming={b.streaming} />
            ) : (
              <ToolChip key={i} name={b.name} input={b.input} done={b.done} />
            ),
          )}
        </div>
      </div>

      {msg.role === "assistant" && text && !msg.blocks.some((b) => b.kind === "text" && b.streaming) ? (
        <PushRow text={text} onPush={onPush} />
      ) : null}
    </div>
  );
}

/**
 * Sending an answer to a generator.
 *
 * The reason this exists: a model writes a prompt, and the next step was always to select
 * it, copy it, open a generator and paste it. The button does that, and the fenced block is
 * preferred over the prose around it — when a model is asked for a prompt it puts the prompt
 * in a fence and the explanation outside, and the explanation is not what should be
 * generated.
 */
function PushRow({ text, onPush }: { text: string; onPush: (view: string, prompt: string, label: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const payload = useMemo(() => {
    const fenced = text.match(/```[\w-]*\n([\s\S]*?)```/);
    return (fenced ? fenced[1] : text).trim();
  }, [text]);

  return (
    <div className="push-row">
      {open ? (
        <>
          {TARGETS.map((target) => (
            <button
              key={target.view}
              className="chip"
              style={{ fontSize: 8.5 }}
              onClick={() => {
                onPush(target.view, payload, target.label);
                setOpen(false);
              }}
            >
              {target.glyph} {target.label}
            </button>
          ))}
          <button className="chip" style={{ fontSize: 8.5 }} onClick={() => setOpen(false)}>
            ✕
          </button>
        </>
      ) : (
        <>
          <button className="chip" style={{ fontSize: 8.5 }} onClick={() => setOpen(true)}>
            {t("→ USE AS PROMPT")}
          </button>
          <button
            className="chip"
            style={{ fontSize: 8.5 }}
            onClick={() => {
              void navigator.clipboard.writeText(payload);
            }}
          >
            {t("⧉ COPY")}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Fenced code is the one piece of markdown worth parsing here.
 *
 * A model asked for a command answers with a fenced block, and a block rendered as running
 * prose is the difference between copying a command and retyping it. Everything else stays
 * as written: half-parsed markdown reads worse than none.
 */
function Prose({ text, streaming }: { text: string; streaming?: boolean }) {
  const parts = useMemo(() => text.split(/```/), [text]);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre className="json" key={i} style={{ margin: "8px 0" }}>
            {part.replace(/^\w*\n/, "")}
          </pre>
        ) : (
          <span key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {part}
          </span>
        ),
      )}
      {streaming ? <span className="stream-caret">▍</span> : null}
    </>
  );
}

function ToolChip({ name, input, done }: { name: string; input?: string; done?: boolean }) {
  return (
    <div className="tool-chip">
      <span className="tool-chip-dot">{done ? "✓" : "◷"}</span>
      <b>{name}</b>
      {input ? <span className="dim mono">{input}</span> : null}
    </div>
  );
}

function ResultBar({ turn }: { turn: Turn }) {
  const t = useT();
  return (
    <div className="well" style={{ padding: "7px 11px", display: "flex", gap: 14, alignItems: "center", fontSize: 10 }}>
      <span style={{ color: turn.failed ? "var(--red)" : "var(--green-text)" }}>{turn.failed ? t("✕ failed") : t("✓ done")}</span>
      {turn.costUsd !== undefined ? <span className="dim">${turn.costUsd.toFixed(4)}</span> : null}
      {turn.durationMs ? <span className="dim">{(turn.durationMs / 1000).toFixed(1)}s</span> : null}
      {turn.outputTokens ? (
        <span className="dim">
          {turn.outputTokens} {t("tokens out")}
        </span>
      ) : null}
    </div>
  );
}
