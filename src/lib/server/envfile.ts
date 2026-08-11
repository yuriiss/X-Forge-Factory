import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The `.env.local` file, read and written at runtime.
 *
 * The Magnific credential does not live here — it is envelope-encrypted in the database,
 * because the engine spends money with it and a key that can be read off disk by anything
 * running as this user is not a credential worth having. Model and provider keys are a
 * different bargain: the CLIs on this machine already read their own credentials from the
 * environment, an operator expects to be able to open the file and see what is set, and
 * encrypting one of the two stores while the other sits in plaintext next to it buys
 * nothing. So these go where the reader will look for them, at mode 600, and this module
 * never returns a value to the browser unmasked.
 */

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names whose value is configuration rather than a credential, and can be shown in full. */
const NOT_SECRET = /(BASE|URL|MODEL|DIR|HOST|PORT|LABEL|ENABLED)$/;

function projectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

export function envFile(): string {
  return process.env.FORGE_ENV_FILE || path.join(projectRoot(), ".env.local");
}

function readRaw(): string {
  const file = envFile();
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/**
 * Values are quoted only when they would otherwise be ambiguous. An unquoted key is easier
 * to read and to edit by hand, which is the reason for keeping this file human-facing.
 */
function quote(value: string): string {
  return /[\s#"'`$]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function setEnv(name: string, value: string): void {
  if (!VALID_NAME.test(name)) throw new Error(`invalid variable name: ${name}`);
  const trimmed = value.trim();
  const line = `${name}=${quote(trimmed)}`;
  const existing = new RegExp(`^${name}=.*$`, "m");

  let raw = readRaw();
  raw = existing.test(raw) ? raw.replace(existing, line) : `${raw.replace(/\n*$/, raw.trim() ? "\n" : "")}${line}\n`;

  const file = envFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, raw, { mode: 0o600 });
  chmodSync(file, 0o600);

  // The running process has already read the file; without this the key would only take
  // effect after a restart, and an operator who just saved it would see it fail once.
  process.env[name] = trimmed;
}

export function clearEnv(name: string): void {
  if (!VALID_NAME.test(name)) throw new Error(`invalid variable name: ${name}`);
  const raw = readRaw().replace(new RegExp(`^${name}=.*\n?`, "m"), "");
  writeFileSync(envFile(), raw, { mode: 0o600 });
  delete process.env[name];
}

export function getEnv(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

/** `sk-or-v1-…9f79` — enough to tell two keys apart, not enough to use one. */
export function mask(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return "••••";
  return `••••${v.slice(-4)}`;
}

export interface EnvEntry {
  name: string;
  value: string;
  secret: boolean;
}

/** Every variable this file holds, credentials masked. Safe to send to the browser. */
export function listEnv(prefixes: string[] = []): EnvEntry[] {
  const out: EnvEntry[] = [];
  for (const line of readRaw().split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (prefixes.length && !prefixes.some((p) => name.startsWith(p))) continue;
    const value = rawValue.replace(/^"(.*)"$/, "$1").trim();
    const secret = !NOT_SECRET.test(name);
    out.push({ name, value: value ? (secret ? mask(value) : value) : "", secret });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
