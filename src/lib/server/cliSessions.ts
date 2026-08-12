import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

/**
 * Reads the conversation history that other coding CLIs (claude, kimi, qwen, codex, grok,
 * agy) keep for themselves on this machine, so the console can offer a "resume" picker
 * without shelling out to each CLI's own (interactive-only) session browser.
 *
 * The one non-obvious thing: none of these stores is a documented format. Each function
 * below was reverse-engineered by sampling real files on this machine (see its comment for
 * what was found) and is a best-effort reading of a private implementation detail, not a
 * contract — a CLI upgrade can rearrange its store without notice. Every reader is written
 * to degrade to "skip this entry" or "return no title" rather than throw, because a stale
 * or half-written session file is the normal case, not an error.
 */

export interface CliSession { id: string; title: string; at: string; file: string; bytes: number }

const HOME = os.homedir();
const MAX_TITLE = 90;
/** Deep enough to reach the first human message in every sample seen; transcripts run to
 *  multi-megabyte, so a full read per session would make the picker slow for no benefit. */
const SNIFF_BYTES = 65536;
/** What each CLI's own resume flag accepts as an id — reject anything that could turn into
 *  a path segment (`..`, `/`) before it ever reaches a filesystem call. */
const ID_RE = /^[\w.-]+$/;

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string): string {
  return s.length > MAX_TITLE ? s.slice(0, MAX_TITLE) : s;
}

function titleOr(id: string, raw: string | null | undefined): string {
  const s = raw ? collapse(raw) : "";
  return s ? clip(s) : id;
}

/** Reads only the leading bytes of a file — enough for JSONL transcripts, where the first
 *  human message sits near the top and the rest can be tens of megabytes. */
function sniffLines(file: string, budget: number = SNIFF_BYTES): string[] {
  const size = statSync(file).size;
  const len = Math.min(budget, size);
  if (len <= 0) return [];
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    // the chunk boundary can land mid-line; JSON.parse on that partial line just throws
    // and callers skip it like any other malformed line
    return buf.toString("utf8").split("\n").filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

function tryParse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Strips the `/command` wrapper Claude Code writes around slash-command input, so the
 *  preview shows what the operator actually typed rather than `<command-name>/goal...`. */
function unwrapCommandArgs(text: string): string {
  const m = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  return m ? m[1] : text;
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listFiles(dir: string, suffix: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(suffix))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function toSession(id: string, file: string, title: string | null): CliSession | null {
  try {
    const st = statSync(file);
    return { id, title: titleOr(id, title), at: st.mtime.toISOString(), file, bytes: st.size };
  } catch {
    return null;
  }
}

/** Verifies a resolved path is really a descendant of the CLI's own directory before any
 *  filesystem-mutating call — the last line of defence for `deleteSession`, independent of
 *  the id-shape check that runs before it. */
function isInside(base: string, target: string): boolean {
  const rb = path.resolve(base);
  const rt = path.resolve(target);
  return rt === rb || rt.startsWith(rb + path.sep);
}

// ---------------------------------------------------------------------------------------
// claude — ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl, one file per session,
// JSON Lines. Resume flag: `claude --resume <session-uuid>` (also `-r`). The id is the
// filename stem and also appears as `sessionId` on every line. The first genuine human
// turn is a `{"type":"user", "message":{"content": ...}}` line; `content` is either a
// plain string or an array of blocks (tool results also show up as "user" turns, so a
// `tool_result` block must be skipped in favour of a `text` block).
// ---------------------------------------------------------------------------------------

const CLAUDE_DIR = path.join(HOME, ".claude", "projects");

function claudeTitle(file: string): string | null {
  for (const line of sniffLines(file)) {
    const obj = tryParse(line);
    if (!obj || obj.type !== "user") continue;
    const message = obj.message as { content?: unknown } | undefined;
    const content = message?.content;
    let text: string | null = null;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const block = content.find(
        (b): b is { type: string; text: string } =>
          !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string",
      );
      text = block?.text ?? null;
    }
    if (text) return unwrapCommandArgs(text);
  }
  return null;
}

function listClaudeSessions(): CliSession[] {
  const out: CliSession[] = [];
  for (const project of listDirs(CLAUDE_DIR)) {
    const dir = path.join(CLAUDE_DIR, project);
    for (const name of listFiles(dir, ".jsonl")) {
      const file = path.join(dir, name);
      const id = name.slice(0, -".jsonl".length);
      try {
        const s = toSession(id, file, claudeTitle(file));
        if (s) out.push(s);
      } catch {
        // one bad session file should not blank the whole list
      }
    }
  }
  return out;
}

function findClaudeFile(id: string): string | null {
  for (const project of listDirs(CLAUDE_DIR)) {
    const file = path.join(CLAUDE_DIR, project, `${id}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// kimi — ~/.kimi-code/sessions/<workdir-hash>/session_<uuid>/agents/main/wire.jsonl.
// The id is the `session_<uuid>` directory name (also the `sessionId` in
// session_index.jsonl). The installed CLI's actual flag is `-S`/`--session <id>` (not the
// `-r` the task description mentions — checked against `kimi --help` on this machine), but
// the id shape is identical either way. `state.json`'s `title` field is always
// "New Session" in every sample found here, so it is not a usable source; the real first
// prompt lives in `wire.jsonl` as a `turn.prompt` event with `origin.kind === "user"`.
// ---------------------------------------------------------------------------------------

const KIMI_DIR = path.join(HOME, ".kimi-code", "sessions");

function kimiWireFile(sessionDir: string): string {
  return path.join(sessionDir, "agents", "main", "wire.jsonl");
}

function kimiTitle(file: string): string | null {
  for (const line of sniffLines(file)) {
    const obj = tryParse(line);
    if (!obj || obj.type !== "turn.prompt") continue;
    const origin = obj.origin as { kind?: string } | undefined;
    if (origin?.kind !== "user") continue;
    const input = obj.input as Array<{ type?: string; text?: string }> | undefined;
    const block = input?.find((b) => b?.type === "text" && typeof b.text === "string");
    if (block?.text) return block.text;
  }
  return null;
}

function listKimiSessions(): CliSession[] {
  const out: CliSession[] = [];
  for (const workdir of listDirs(KIMI_DIR)) {
    const wdir = path.join(KIMI_DIR, workdir);
    for (const id of listDirs(wdir)) {
      const wire = kimiWireFile(path.join(wdir, id));
      if (!existsSync(wire)) continue; // session created but never actually prompted
      try {
        const s = toSession(id, wire, kimiTitle(wire));
        if (s) out.push(s);
      } catch {
        // skip
      }
    }
  }
  return out;
}

function findKimiSessionDir(id: string): string | null {
  for (const workdir of listDirs(KIMI_DIR)) {
    const dir = path.join(KIMI_DIR, workdir, id);
    if (existsSync(dir)) return dir;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// qwen — ~/.qwen/projects/<encoded-cwd>/chats/<session-uuid>.jsonl, JSON Lines, one file
// per session (a sibling `.runtime.json` tracks only the live pid and is not transcript
// data). Resume flag: `qwen --resume <session-uuid>` (also `-r`; confirmed via
// `qwen --help`). Lines are tagged with `provenance`; only `"real_user"` lines are
// operator-typed text — everything else (`goal_runtime`, `system`, …) is synthetic
// continuation machinery from this build's autonomous-goal mode and would make a useless
// title if used directly.
// ---------------------------------------------------------------------------------------

const QWEN_DIR = path.join(HOME, ".qwen", "projects");

function qwenTitle(file: string): string | null {
  for (const line of sniffLines(file)) {
    const obj = tryParse(line);
    if (!obj || obj.type !== "user" || obj.provenance !== "real_user") continue;
    const message = obj.message as { parts?: Array<{ text?: string }> } | undefined;
    const part = message?.parts?.find((p) => typeof p?.text === "string" && p.text.length > 0);
    if (part?.text) return part.text;
  }
  return null;
}

function listQwenSessions(): CliSession[] {
  const out: CliSession[] = [];
  for (const project of listDirs(QWEN_DIR)) {
    const chats = path.join(QWEN_DIR, project, "chats");
    for (const name of listFiles(chats, ".jsonl")) {
      const file = path.join(chats, name);
      const id = name.slice(0, -".jsonl".length);
      try {
        const s = toSession(id, file, qwenTitle(file));
        if (s) out.push(s);
      } catch {
        // skip
      }
    }
  }
  return out;
}

function findQwenFile(id: string): string | null {
  for (const project of listDirs(QWEN_DIR)) {
    const file = path.join(QWEN_DIR, project, "chats", `${id}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// codex — ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-uuid>.jsonl, JSON
// Lines. Resume flag: `codex resume <thread-uuid>` (confirmed via `codex resume --help`,
// which calls it "session id (UUID)" — Codex's own docs call the same value a thread id).
// The id is the UUID suffix of the filename (also `payload.id` on the first
// `session_meta` line). The first real prompt is an `event_msg` line whose
// `payload.type === "user_message"`; `response_item`/`role":"user"` lines fire earlier but
// are environment boilerplate (recommended-plugins notices, etc.), not operator input.
// ---------------------------------------------------------------------------------------

const CODEX_DIR = path.join(HOME, ".codex", "sessions");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
/** Codex's own `session_meta` line embeds its full base-instructions system prompt — on
 *  this machine that alone runs to ~70KB before the operator's first real message even
 *  starts, so the shared sniff budget has to be widened just for this reader. */
const CODEX_SNIFF_BYTES = 300_000;

function codexId(filename: string): string | null {
  const m = UUID_RE.exec(filename);
  return m ? m[0] : null;
}

function codexTitle(file: string): string | null {
  for (const line of sniffLines(file, CODEX_SNIFF_BYTES)) {
    const obj = tryParse(line);
    if (!obj || obj.type !== "event_msg") continue;
    const payload = obj.payload as { type?: string; message?: string } | undefined;
    if (payload?.type === "user_message" && typeof payload.message === "string") return payload.message;
  }
  return null;
}

/** Depth-bounded walk over the year/month/day tree codex writes; bounded so a stray
 *  symlink loop or unexpected nesting cannot make this run away. */
function walkJsonl(dir: string, depth: number, out: string[]): void {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, depth - 1, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

function listCodexSessions(): CliSession[] {
  const files: string[] = [];
  walkJsonl(CODEX_DIR, 4, files);
  const out: CliSession[] = [];
  for (const file of files) {
    const id = codexId(path.basename(file));
    if (!id) continue;
    try {
      const s = toSession(id, file, codexTitle(file));
      if (s) out.push(s);
    } catch {
      // skip
    }
  }
  return out;
}

function findCodexFile(id: string): string | null {
  const files: string[] = [];
  walkJsonl(CODEX_DIR, 4, files);
  return files.find((f) => codexId(path.basename(f)) === id) ?? null;
}

// ---------------------------------------------------------------------------------------
// grok — ~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/, one directory per session
// holding `chat_history.jsonl` (the transcript) and `summary.json` (a small sidecar with a
// ready-made `generated_title`/`session_summary` — no need to parse the transcript for a
// title here). Resume flag: `grok --resume <session-uuid>` (also `-r`; confirmed via
// `grok --help`).
// ---------------------------------------------------------------------------------------

const GROK_DIR = path.join(HOME, ".grok", "sessions");

function grokTitle(sessionDir: string): string | null {
  try {
    const raw = readFileSync(path.join(sessionDir, "summary.json"), "utf8");
    const obj = JSON.parse(raw) as { generated_title?: string; session_summary?: string };
    return obj.generated_title || obj.session_summary || null;
  } catch {
    return null;
  }
}

function listGrokSessions(): CliSession[] {
  const out: CliSession[] = [];
  for (const cwd of listDirs(GROK_DIR)) {
    const cwdDir = path.join(GROK_DIR, cwd);
    for (const id of listDirs(cwdDir)) {
      const file = path.join(cwdDir, id, "chat_history.jsonl");
      if (!existsSync(file)) continue;
      try {
        const s = toSession(id, file, grokTitle(path.join(cwdDir, id)));
        if (s) out.push(s);
      } catch {
        // skip
      }
    }
  }
  return out;
}

function findGrokSessionDir(id: string): string | null {
  for (const cwd of listDirs(GROK_DIR)) {
    const dir = path.join(GROK_DIR, cwd, id);
    if (existsSync(dir)) return dir;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// agy (Antigravity CLI) — despite the name, this build's on-disk home is
// ~/.gemini/antigravity-cli (not ~/.antigravity or ~/.config/Antigravity, which belong to
// the separate Antigravity IDE). Each conversation is a SQLite database at
// conversations/<conversation-uuid>.db holding protobuf-encoded step payloads — reading
// those would need the app's own .proto schema, which was not available, so message text
// is not extracted from the database itself. What *is* understood and used instead is
// cache/conversation_metadata.json, the CLI's own index of conversation id -> {Title,
// Preview, UpdatedAt} that it maintains for its picker; titles come from there when
// present, and every `.db` file — not just the ones currently in that cache — is still
// listed, so an operator sees every resumable conversation even though only the recently
// touched ones get a rich title. Resume flag: `agy --conversation <conversation-uuid>`.
// ---------------------------------------------------------------------------------------

const AGY_DIR = path.join(HOME, ".gemini", "antigravity-cli", "conversations");
const AGY_METADATA_FILE = path.join(HOME, ".gemini", "antigravity-cli", "cache", "conversation_metadata.json");

interface AgyMetaEntry { summary?: { Title?: string; Preview?: string } }

function loadAgyMetadata(): Map<string, AgyMetaEntry> {
  const map = new Map<string, AgyMetaEntry>();
  try {
    const raw = readFileSync(AGY_METADATA_FILE, "utf8");
    const obj = JSON.parse(raw) as { conversations?: Record<string, AgyMetaEntry> };
    for (const [id, entry] of Object.entries(obj.conversations ?? {})) map.set(id, entry);
  } catch {
    // no cache yet, or it does not parse — every title falls back to the id below
  }
  return map;
}

function listAgySessions(): CliSession[] {
  const meta = loadAgyMetadata();
  const out: CliSession[] = [];
  for (const name of listFiles(AGY_DIR, ".db")) {
    const id = name.slice(0, -".db".length);
    const file = path.join(AGY_DIR, name);
    const entry = meta.get(id)?.summary;
    const title = entry?.Title || entry?.Preview || null;
    try {
      const s = toSession(id, file, title);
      if (s) out.push(s);
    } catch {
      // skip
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------

export function listSessions(agentId: string, limit?: number): CliSession[] {
  const cap = limit && limit > 0 ? limit : 40;
  let sessions: CliSession[];
  switch (agentId) {
    case "claude":
      sessions = listClaudeSessions();
      break;
    case "kimi":
      sessions = listKimiSessions();
      break;
    case "qwen":
      sessions = listQwenSessions();
      break;
    case "codex":
      sessions = listCodexSessions();
      break;
    case "grok":
      sessions = listGrokSessions();
      break;
    case "agy":
      sessions = listAgySessions();
      break;
    default:
      sessions = [];
  }
  sessions.sort((a, b) => b.at.localeCompare(a.at));
  return sessions.slice(0, cap);
}

export function deleteSession(agentId: string, id: string): boolean {
  if (!ID_RE.test(id)) return false;
  try {
    switch (agentId) {
      case "claude": {
        const file = findClaudeFile(id);
        if (!file || !isInside(CLAUDE_DIR, file)) return false;
        unlinkSync(file);
        return true;
      }
      case "kimi": {
        const dir = findKimiSessionDir(id);
        if (!dir || !isInside(KIMI_DIR, dir)) return false;
        rmSync(dir, { recursive: true, force: true });
        return true;
      }
      case "qwen": {
        const file = findQwenFile(id);
        if (!file || !isInside(QWEN_DIR, file)) return false;
        unlinkSync(file);
        // best-effort: the runtime sidecar is not transcript data, so a leftover copy is
        // harmless, but tidy up when it is right there next to the file we just removed
        const runtime = file.slice(0, -".jsonl".length) + ".runtime.json";
        if (existsSync(runtime)) unlinkSync(runtime);
        return true;
      }
      case "codex": {
        const file = findCodexFile(id);
        if (!file || !isInside(CODEX_DIR, file)) return false;
        unlinkSync(file);
        return true;
      }
      case "grok": {
        const dir = findGrokSessionDir(id);
        if (!dir || !isInside(GROK_DIR, dir)) return false;
        rmSync(dir, { recursive: true, force: true });
        return true;
      }
      case "agy": {
        const file = path.join(AGY_DIR, `${id}.db`);
        if (!existsSync(file) || !isInside(AGY_DIR, file)) return false;
        unlinkSync(file);
        // SQLite's write-ahead-log siblings are not always present; remove them when they are
        for (const suffix of ["-wal", "-shm"]) {
          const sidecar = file + suffix;
          if (existsSync(sidecar)) unlinkSync(sidecar);
        }
        return true;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}
