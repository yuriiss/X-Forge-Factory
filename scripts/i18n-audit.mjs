#!/usr/bin/env node
/**
 * Compare the strings the UI asks for against the strings the dictionary answers.
 *
 *   node scripts/i18n-audit.mjs            # summary + what is missing
 *   node scripts/i18n-audit.mjs --json     # the missing keys alone, for a translator
 *
 * English is the key, so a gap here is a sentence that renders in English rather than a
 * crash — which is the point of the design, and also why nothing would otherwise tell you
 * the gap exists. This is that telling.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const ROOT = path.resolve("src");
const DICT = path.resolve("src/lib/locales/uk.ts");

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".tsx") ? [full] : [];
  });
}

/** `t("…")` with any escapes intact, then unescaped once so it matches a dictionary key. */
const CALL = /(?<![A-Za-z0-9_$.])t\(\s*"((?:[^"\\]|\\.)*)"/g;
const unescape = (s) => s.replace(/\\(.)/g, "$1");

const used = new Map();
const sources = new Map();
for (const file of walk(ROOT)) {
  const text = readFileSync(file, "utf8");
  sources.set(path.relative(process.cwd(), file), text);
  for (const [, raw] of text.matchAll(CALL)) {
    const key = unescape(raw);
    if (!used.has(key)) used.set(key, path.relative(process.cwd(), file));
  }
}

/**
 * Prose held in a data array reaches `t` as a variable — `t(it.name)` — so it is invisible
 * to the scan above even though it is translated at render time. An entry that still
 * appears verbatim somewhere in the source is doing its job; only one that appears nowhere
 * is genuinely dead.
 */
const anywhere = (key) => [...sources.values()].some((text) => text.includes(`"${key.replace(/"/g, '\\"')}"`));

const dict = readFileSync(DICT, "utf8");
const ENTRY = /^ {2}(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*)):/gm;
const have = new Set([...dict.matchAll(ENTRY)].map(([, quoted, bare]) => unescape(quoted ?? bare)));

const missing = [...used.keys()].filter((k) => !have.has(k));
const dynamic = [...have].filter((k) => !used.has(k) && anywhere(k));
const unusedEntries = [...have].filter((k) => !used.has(k) && !anywhere(k));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(missing, null, 1));
} else if (process.argv.includes("--stale")) {
  console.log(unusedEntries.join("\n"));
} else {
  console.log(`call sites   ${used.size} unique strings`);
  console.log(`dictionary   ${have.size} entries`);
  console.log(`dynamic      ${dynamic.length}  (reached as t(variable), translated all the same)`);
  console.log(`missing      ${missing.length}  (render in English)`);
  console.log(`stale        ${unusedEntries.length}  (translated, no longer asked for)`);
  if (missing.length) console.log("\n" + missing.map((k) => `  · ${k}    ${used.get(k)}`).join("\n"));
}
