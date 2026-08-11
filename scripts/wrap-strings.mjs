#!/usr/bin/env node
/**
 * Wrap user-visible strings in `t(...)` so they can be translated.
 *
 *   node scripts/wrap-strings.mjs src/components/views/Dashboard.tsx        # one file
 *   node scripts/wrap-strings.mjs --check src/components/views/*.tsx        # report only
 *
 * The English string stays the key, so wrapping something that should never be translated
 * is harmless: with no entry in the dictionary it renders exactly as before. That asymmetry
 * is what makes a mechanical pass safe here — over-wrapping costs nothing, under-wrapping
 * leaves a sentence stuck in one language.
 *
 * Deliberately left alone: anything containing an expression, endpoint paths, and the code
 * blocks that show request bodies. Those are not prose.
 */
import { readFileSync, writeFileSync } from "fs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const files = args.filter((a) => !a.startsWith("--"));

/** JSX renders entities; the key has to hold what the reader sees. */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Reject anything that is code rather than prose.
 *
 * The multi-line rule is the dangerous one: a text node that begins after `>` and ends at
 * the next `<` can, in a ternary, span the branches themselves — `) : cond ? (` is not a
 * sentence, and wrapping it produces a file that no longer parses.
 */
function looksLikeCode(s) {
  return /["'`();{}]|=>|===|&&|\?\?|\bnull\b|\breturn\b/.test(s) || /[?:]\s*$/.test(s);
}

/** Text that is a value, not a sentence. */
function isTechnical(s) {
  const t = s.trim();
  if (t.length < 2) return true;
  if (!/[A-Za-z]/.test(t)) return true;
  if (/^[/.]/.test(t)) return true; // /v1/ai/mystic
  if (/^(GET|POST|PUT|DELETE|PATCH)\b/.test(t)) return true;
  if (/^https?:/.test(t)) return true;
  if (/^[a-z0-9_.]+$/.test(t) && !t.includes(" ")) return true; // identifiers, model slugs
  if (/^[{}[\]()<>|&=+\-*/%!?:;,.'"`~^]+$/.test(t)) return true;
  return false;
}

const escape = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

for (const file of files) {
  const before = readFileSync(file, "utf8");
  let s = before;
  const wrapped = [];

  // 1 — single-line text nodes: >Credits<
  // The lookbehind keeps arrow return types out: `() => Promise<T>` looks exactly like a
  // text node between two angle brackets, and wrapping it breaks the file.
  s = s.replace(/(?<!=)>([^<>{}\n]+)</g, (whole, text) => {
    if (isTechnical(text) || !text.trim() || looksLikeCode(text)) return whole;
    const inner = decodeEntities(text.trim());
    const [lead] = text.match(/^\s*/);
    const [tail] = text.match(/\s*$/);
    wrapped.push(inner);
    return `>${lead}{t("${escape(inner)}")}${tail}<`;
  });

  // 2 — text nodes spread over several lines; JSX collapses the whitespace, so join.
  s = s.replace(/>\n((?:\s*[^<>{}\n]*\n)+?)(\s*)</g, (whole, block, indent) => {
    const inner = decodeEntities(block.split("\n").map((l) => l.trim()).filter(Boolean).join(" "));
    if (!inner || isTechnical(inner) || looksLikeCode(inner)) return whole;
    wrapped.push(inner);
    return `>\n${indent}  {t("${escape(inner)}")}\n${indent}<`;
  });

  // 3 — attributes that carry prose
  s = s.replace(/\b(placeholder|title|label|hint|aria-label)="([^"]+)"/g, (whole, attr, text) => {
    if (isTechnical(text)) return whole;
    text = decodeEntities(text);
    wrapped.push(text);
    return `${attr}={t("${escape(text)}")}`;
  });

  if (check) {
    console.log(`${file}: ${wrapped.length} string(s)`);
    continue;
  }
  if (s !== before) writeFileSync(file, s, "utf8");
  console.log(`${file}: wrapped ${wrapped.length}`);
}
