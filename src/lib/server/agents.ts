import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnv } from "./envfile";

/**
 * The models an operator can talk to, and how each one is actually reached.
 *
 * Two kinds sit in one list. A *CLI* model is a program already installed on this machine,
 * already signed in, already holding its own credentials — X-Forge spawns it for one turn
 * and streams what it prints. A *provider* model is an HTTP endpoint that speaks the
 * OpenAI chat shape, reached with a key from `.env.local`.
 *
 * Which CLIs exist is a question about this machine, not a setting, so it is answered by
 * looking rather than by configuration. The catalogue below is the complete set X-Forge
 * knows how to drive; the console shows every entry and marks the ones that are not
 * installed, because "Grok is missing" is more useful to a reader than a list that quietly
 * omits it.
 */

export type Dialect = "claude" | "kimi" | "grok" | "codex" | "agy";

export interface AgentDef {
  id: string;
  label: string;
  /** The binary to look for on PATH. */
  bin: string;
  glyph: string;
  colour: string;
  kind: string;
  /** How to read what the process prints. */
  dialect: Dialect;
  /** Directory whose sub-folders are skills this CLI discovers by itself. */
  skillsDir?: string;
  /** Model ids worth offering. Empty means the CLI decides. */
  models?: string[];
  /** Flags this CLI understands, so the console offers only controls that do something. */
  supports: { resume?: boolean; effort?: boolean; permission?: boolean; systemPrompt?: boolean };
}

export const AGENTS: AgentDef[] = [
  {
    id: "claude",
    label: "Claude",
    bin: "claude",
    glyph: "✳",
    colour: "#d97757",
    kind: "Agentic CLI",
    dialect: "claude",
    skillsDir: "~/.claude/skills",
    models: ["", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    supports: { resume: true, effort: true, permission: true, systemPrompt: true },
  },
  {
    id: "grok",
    label: "Grok",
    bin: "grok",
    glyph: "❖",
    colour: "#f97316",
    kind: "Agentic CLI",
    dialect: "grok",
    skillsDir: "~/.grok/skills",
    models: [""],
    supports: { resume: true, effort: true, permission: true },
  },
  {
    id: "kimi",
    label: "Kimi",
    bin: "kimi",
    glyph: "◐",
    colour: "#5b7cfa",
    kind: "Agentic CLI",
    dialect: "kimi",
    skillsDir: "~/.agents/skills",
    models: [""],
    supports: { resume: true },
  },
  {
    id: "qwen",
    label: "Qwen Code",
    bin: "qwen",
    glyph: "⌘",
    colour: "#a855f7",
    kind: "Agentic CLI",
    dialect: "claude",
    skillsDir: "~/.agents/skills",
    models: [""],
    supports: {},
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    glyph: "◎",
    colour: "#10b981",
    kind: "Agentic CLI",
    dialect: "codex",
    skillsDir: "~/.agents/skills",
    models: [""],
    supports: {},
  },
  {
    id: "antigravity",
    label: "Antigravity",
    // `antigravity` on PATH is the Electron IDE; spawning it opens the whole editor and
    // streams its startup log into the chat. The headless CLI is `agy`.
    bin: "agy",
    glyph: "▲",
    colour: "#4c8bf5",
    kind: "Agentic CLI",
    dialect: "agy",
    skillsDir: "~/.agents/skills",
    models: [""],
    supports: { resume: true, effort: true },
  },
];

/**
 * A usable skill name.
 *
 * It has to start with a letter or a digit, not with a dash: a name is put into a prompt
 * here, but it is also used to build a filesystem path, and in a CLI that takes a
 * `--skills a,b` flag a leading dash is an argument rather than a name. One rule in one
 * place, so the three callers cannot drift apart.
 */
export function isSkillName(name: string): boolean {
  return /^[A-Za-z0-9][\w.-]*$/.test(name) && name.length <= 80;
}

export function agent(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * PATH as a login shell would have it.
 *
 * A Next.js server started from a desktop launcher or a unit file inherits a PATH that
 * often lacks exactly the directories these CLIs install into, so a binary the operator
 * uses daily in a terminal is invisible here. Widening it costs nothing and removes a
 * whole class of "but it works in my shell".
 */
export function spawnEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extra = [
    path.join(home, ".local/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".deno/bin"),
    path.join(home, ".cargo/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".kimi-code/bin"),
    path.join(home, ".grok/bin"),
    path.join(home, "go/bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ].filter((dir) => existsSync(dir));

  // Windows resolves PATH case-insensitively but Node exposes whatever the parent set, so
  // the variable is found by name rather than assumed to be spelled `PATH`.
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const current = (process.env[key] ?? "").split(path.delimiter);
  const merged = [...new Set([...current, ...extra])].filter(Boolean);
  return { ...process.env, [key]: merged.join(path.delimiter) };
}

const CACHE = new Map<string, { at: number; found: string | null }>();
const TTL_MS = 30_000;

/**
 * Absolute path to a binary, or null.
 *
 * `which` does not exist on Windows and `where.exe` prints every match rather than the
 * first, so the platform decides both the command and how to read its answer. Cached
 * briefly, because an operator may install a CLI while the console is open and expects it
 * to be noticed without a restart.
 */
export function resolveBin(name: string): string | null {
  const hit = CACHE.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.found;

  const windows = process.platform === "win32";
  let found: string | null = null;
  try {
    const out = execFileSync(windows ? "where.exe" : "which", [name], {
      env: spawnEnv(),
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });

    // Windows lists every hit, and the useful one is whichever comes first that exists;
    // a bare name may also resolve to a `.cmd` shim rather than an executable.
    for (const line of out.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  } catch {
    found = null;
  }
  CACHE.set(name, { at: Date.now(), found });
  return found;
}

export interface AgentStatus extends AgentDef {
  available: boolean;
  where: string | null;
}

export function agentStatuses(): AgentStatus[] {
  return AGENTS.map((a) => {
    const where = resolveBin(a.bin);
    return { ...a, available: !!where, where };
  });
}

export interface TurnOptions {
  prompt: string;
  model?: string;
  sessionId?: string;
  effort?: string;
  permission?: string;
  skills?: string[];
  cwd?: string;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PERMISSIONS = ["default", "acceptEdits", "plan", "bypassPermissions"];

/**
 * The command line for one turn.
 *
 * Every CLI here runs one prompt and exits; none is kept alive between turns. Continuity
 * comes from the CLI's own transcript via its resume flag, which means the conversation
 * survives a restart of this console — and that the console is not the owner of the
 * history, the CLI is.
 */
export function buildArgs(def: AgentDef, turn: TurnOptions): string[] {
  const skills = (turn.skills ?? []).filter(isSkillName).slice(0, 20);

  // Skills are discovered by the CLI itself from its own directory; naming them in the
  // prompt is what makes the model reach for one rather than merely have it available.
  const nudge = skills.length ? `Use these skills where relevant: ${skills.join(", ")}.\n\n` : "";
  const prompt = `${nudge}${turn.prompt}`;

  switch (def.dialect) {
    case "claude": {
      // Qwen Code shares this envelope but not the flags: it takes `-o`, and neither it nor
      // Kimi understands the partial-message flags, so those stay on the Claude branch.
      if (def.id === "qwen") {
        const args = ["-p", prompt, "-o", "stream-json"];
        if (turn.model) args.push("-m", turn.model);
        return args;
      }
      const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
      if (turn.sessionId) args.push("--resume", turn.sessionId);
      if (turn.model) args.push("--model", turn.model);
      if (turn.effort && EFFORTS.includes(turn.effort)) args.push("--effort", turn.effort);
      if (turn.permission && turn.permission !== "default" && PERMISSIONS.includes(turn.permission)) {
        args.push("--permission-mode", turn.permission);
      }
      return args;
    }
    case "kimi": {
      const args = ["-p", prompt, "--output-format", "stream-json"];
      if (turn.sessionId) args.push("-r", turn.sessionId);
      if (turn.model) args.push("-m", turn.model);
      return args;
    }
    case "grok": {
      const args = ["-p", prompt, "--output-format", "streaming-json"];
      if (turn.sessionId) args.push("--resume", turn.sessionId);
      if (turn.model) args.push("--model", turn.model);
      if (turn.effort && EFFORTS.includes(turn.effort)) args.push("--reasoning-effort", turn.effort);
      return args;
    }
    case "codex": {
      // `exec` is Codex's non-interactive subcommand, and the git check would otherwise
      // refuse to run anywhere that is not a repository — including a home directory.
      const args = ["exec", "--json", "--skip-git-repo-check"];
      if (turn.model) args.push("-m", turn.model);
      args.push(prompt);
      return args;
    }
    case "agy": {
      const args = ["-p", prompt, "--output-format", "stream-json"];
      if (turn.sessionId) args.push("--conversation", turn.sessionId);
      if (turn.model) args.push("--model", turn.model);
      // agy takes only three of the five levels, and passing one it does not know is a
      // hard error rather than a shrug.
      if (turn.effort && ["low", "medium", "high"].includes(turn.effort)) args.push("--effort", turn.effort);
      return args;
    }
    default:
      return ["-p", prompt];
  }
}
