import { execFile } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { agent, expandHome, isSkillName, spawnEnv } from "./agents";
import { forgeHome } from "./paths";
import { scanSkill, type Verdict } from "./skillscan";

const run = promisify(execFile);

/**
 * Skills — folders of instructions a CLI can be told to follow.
 *
 * A skill is somebody else's text arriving on your machine and then being handed to a model
 * that can run commands, so installation is the security boundary of this whole feature.
 * Nothing is ever written into the live directory before it has been scanned: a download
 * lands in a quarantine directory, the scanner reads it there, and only a clean verdict is
 * promoted. A rejected skill is deleted, not parked somewhere "for later".
 *
 * The scan is static. It reads files and matches patterns; it does not execute anything.
 * That catches the obvious attacks — a pipe from curl into a shell, an instruction to mail
 * the contents of `.ssh` somewhere, a "never mention this to the user" line — and it does
 * not catch a clever one. Passing is not proof of safety, which is why the verdict is shown
 * to the operator rather than swallowed.
 */

export interface Skill {
  name: string;
  category: string;
  description: string;
}

function liveDir(agentId: string): string {
  const def = agent(agentId);
  return expandHome(def?.skillsDir ?? "~/.agents/skills");
}

function frontmatter(md: string, field: string): string {
  const match = md.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  const value = match ? match[1].trim().replace(/^["']|["']$/g, "") : "";

  // Some published skills are templates whose front matter still holds `{{SKILL_NAME}}`.
  // The folder name is the honest answer in that case; a list of identical placeholders
  // is not a list.
  return value.includes("{{") ? "" : value;
}

/** Skills sit one or two levels deep. Deeper than that is somebody's source tree, not a skill. */
export function scanInstalled(agentId: string): Skill[] {
  const root = liveDir(agentId);
  if (!existsSync(root)) return [];

  const out: Skill[] = [];
  const read = (dir: string, name: string, category: string) => {
    const manifest = path.join(dir, "SKILL.md");
    if (!existsSync(manifest)) return false;
    let md = "";
    try {
      md = readFileSync(manifest, "utf8").slice(0, 8000);
    } catch {
      return false;
    }
    // The folder name, not the one in the front matter. A skill is addressed by its
    // directory — that is what the CLI loads and what an uninstall has to delete — and
    // forks of a popular skill all declare the same `name:`, so trusting the manifest
    // produces a list with forty identical rows and a delete button that removes the
    // wrong one.
    out.push({ name, category, description: frontmatter(md, "description") });
    return true;
  };

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (read(dir, entry.name, "general")) continue;
    for (const nested of readdirSync(dir, { withFileTypes: true })) {
      if (nested.isDirectory()) read(path.join(dir, nested.name), nested.name, entry.name);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The body of a skill, for the preview an operator reads before installing. */
export function readSkillBody(agentId: string, name: string): string | null {
  if (!isSkillName(name)) return null;
  const root = liveDir(agentId);
  for (const candidate of [path.join(root, name, "SKILL.md"), ...nestedCandidates(root, name)]) {
    if (existsSync(candidate)) {
      try {
        return readFileSync(candidate, "utf8").slice(0, 20_000);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function nestedCandidates(root: string, name: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name, name, "SKILL.md"));
}

function quarantine(): string {
  const base = path.join(os.tmpdir(), "x-forge-skills");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, "q-"));
}

/** Every directory under `dir` that holds a SKILL.md. */
function skillDirs(dir: string, depth = 0): string[] {
  if (depth > 4 || !existsSync(dir)) return [];
  const found: string[] = [];
  if (existsSync(path.join(dir, "SKILL.md"))) found.push(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") {
      found.push(...skillDirs(path.join(dir, entry.name), depth + 1));
    }
  }
  return found;
}

export interface InstallResult {
  ok: boolean;
  outcome: Verdict["outcome"];
  why: string;
  findings: Verdict["findings"];
  name?: string;
  /** A REVIEW verdict can be overridden by a person; a REJECT cannot. */
  needsReview?: boolean;
  candidates?: string[];
}

/**
 * Install one skill from the skills.sh registry.
 *
 * The registry is reached through its own `skills` CLI rather than by fetching an archive
 * here: it is the tool that knows the registry's layout, and reimplementing that layout
 * would mean tracking it forever. It downloads into quarantine, never into the live folder.
 */
export async function installFromRegistry(
  agentId: string,
  source: string,
  skillId: string,
  force: boolean,
  reason: string,
): Promise<InstallResult> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(source)) throw new Error("source must look like owner/repo");
  if (!isSkillName(skillId)) throw new Error("invalid skill id");

  const pen = quarantine();
  try {
    await run("npx", ["-y", "skills", "add", source, "-s", skillId, "-y", "--copy"], {
      cwd: pen,
      env: spawnEnv(),
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const found = skillDirs(pen);
    if (!found.length) return reject("the download contained no SKILL.md, so there was nothing to scan");

    // A repository can hold a hundred skills. Installing the one that was asked for, rather
    // than everything that came down with it, is the difference between a skill and a haul.
    const wanted = found.filter((dir) => path.basename(dir).toLowerCase() === skillId.toLowerCase());
    const target = wanted[0] ?? (found.length === 1 ? found[0] : null);
    if (!target) {
      return {
        ok: false,
        outcome: "REVIEW",
        why: "that download holds several skills — install one at a time so each verdict is about something",
        findings: [],
        candidates: found.map((d) => path.basename(d)),
      };
    }

    return promote(agentId, target, force, reason, source);
  } catch (e) {
    return reject(`the registry download failed: ${(e as Error).message.slice(0, 300)}`);
  } finally {
    rmSync(pen, { recursive: true, force: true });
  }
}

/** Install a skill the operator supplied themselves, already unpacked into `dir`. */
export function installFromDir(agentId: string, dir: string, force: boolean, reason: string): InstallResult {
  const found = skillDirs(dir);
  if (!found.length) return reject("no SKILL.md in that upload, so there was nothing to scan");
  if (found.length > 1) {
    return {
      ok: false,
      outcome: "REVIEW",
      why: "that upload holds several skills — one at a time",
      findings: [],
      candidates: found.map((d) => path.basename(d)),
    };
  }
  return promote(agentId, found[0], force, reason, "upload");
}

function reject(why: string): InstallResult {
  return { ok: false, outcome: "REJECT", why, findings: [] };
}

function promote(agentId: string, dir: string, force: boolean, reason: string, source: string): InstallResult {
  const verdict = scanSkill(dir);
  const md = existsSync(path.join(dir, "SKILL.md")) ? readFileSync(path.join(dir, "SKILL.md"), "utf8") : "";
  const name = safeName(frontmatter(md, "name") || path.basename(dir));

  if (verdict.outcome === "REJECT") {
    audit({ agentId, name, source, outcome: "REJECT", decidedBy: "auto", why: verdict.why });
    return { ok: false, outcome: "REJECT", why: verdict.why, findings: verdict.findings };
  }
  if (verdict.outcome === "REVIEW" && !force) {
    return { ok: false, outcome: "REVIEW", why: verdict.why, findings: verdict.findings, needsReview: true, name };
  }

  const dest = path.join(liveDir(agentId), name);
  mkdirSync(path.dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(dir, dest, { recursive: true });

  audit({
    agentId,
    name,
    source,
    outcome: verdict.outcome,
    decidedBy: force ? "operator override" : "auto",
    why: force ? reason || "no reason given" : verdict.why,
  });
  return { ok: true, outcome: verdict.outcome, why: verdict.why, findings: verdict.findings, name };
}

function safeName(raw: string): string {
  const name = raw.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return name || "unnamed-skill";
}

export function uninstall(agentId: string, name: string): boolean {
  if (!isSkillName(name)) throw new Error("invalid skill name");
  const root = liveDir(agentId);
  const dest = path.join(root, name);

  // A name that escapes its own directory is the whole reason this check exists.
  if (path.dirname(path.resolve(dest)) !== path.resolve(root)) throw new Error("refusing to delete outside the skills directory");
  if (!existsSync(dest) || !statSync(dest).isDirectory()) return false;

  rmSync(dest, { recursive: true, force: true });
  audit({ agentId, name, source: "local", outcome: "REJECT", decidedBy: "operator uninstall", why: "removed by the operator" });
  return true;
}

interface AuditRecord {
  agentId: string;
  name: string;
  source: string;
  outcome: string;
  decidedBy: string;
  why: string;
}

/** Append-only, because the interesting question later is always "when did that arrive". */
function audit(record: AuditRecord): void {
  try {
    const file = path.join(forgeHome(), "skill-audit.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch {
    /* an audit line must never be the reason an install fails */
  }
}

export interface RegistryHit {
  name: string;
  skillId: string;
  source: string;
  installs?: number;
}

export interface PreviewResult {
  name: string;
  body: string;
  files: string[];
  verdict: Verdict;
}

/**
 * Download a registry skill into quarantine and scan it, but never promote it — the
 * "preview" side of installFromRegistry, kept separate rather than adding a flag to that
 * function because a function that sometimes writes to disk and sometimes does not is
 * harder to audit than two functions that always do one or the other. Reuses the same
 * `skills add` invocation shape so the preview and a real install see identical bytes.
 */
export async function previewFromRegistry(source: string, skillId: string): Promise<PreviewResult> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(source)) throw new Error("source must look like owner/repo");
  if (!isSkillName(skillId)) throw new Error("invalid skill id");

  const pen = quarantine();
  try {
    await run("npx", ["-y", "skills", "add", source, "-s", skillId, "-y", "--copy"], {
      cwd: pen,
      env: spawnEnv(),
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const found = skillDirs(pen);
    if (!found.length) throw new Error("the download contained no SKILL.md, so there was nothing to preview");

    const wanted = found.filter((dir) => path.basename(dir).toLowerCase() === skillId.toLowerCase());
    const target = wanted[0] ?? (found.length === 1 ? found[0] : null);
    if (!target) throw new Error("that download holds several skills — preview is one at a time");

    const mdPath = path.join(target, "SKILL.md");
    const md = existsSync(mdPath) ? readFileSync(mdPath, "utf8").slice(0, 20_000) : "";
    const name = safeName(frontmatter(md, "name") || path.basename(target));

    return { name, body: md, files: listRelative(target), verdict: scanSkill(target) };
  } finally {
    rmSync(pen, { recursive: true, force: true });
  }
}

/** File paths under `dir`, relative to it — for showing a preview reader what a skill
 * actually ships, not just its SKILL.md. */
function listRelative(dir: string, prefix = "", depth = 0): string[] {
  if (depth > 6) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listRelative(path.join(dir, entry.name), rel, depth + 1));
    else out.push(rel);
  }
  return out;
}

export async function searchRegistry(query: string): Promise<RegistryHit[]> {
  const res = await fetch(`https://skills.sh/api/search?q=${encodeURIComponent(query)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`skills.sh answered ${res.status}`);

  const json = (await res.json()) as { skills?: { name?: string; skillId?: string; id?: string; source?: string; installs?: number }[] };
  return (json.skills ?? [])
    .filter((s) => s.source && (s.skillId || s.id))
    .slice(0, 40)
    .map((s) => ({ name: s.name ?? s.skillId ?? "", skillId: s.skillId ?? s.id ?? "", source: s.source ?? "", installs: s.installs }));
}
