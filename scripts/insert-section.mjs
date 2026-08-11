#!/usr/bin/env node
/**
 * Insert a numbered section into a guidebook and renumber everything after it.
 *
 *   node scripts/insert-section.mjs GUIDEBOOK.md 5 /tmp/chat-en.md
 *
 * A guidebook numbers its sections, links them from a contents list, and cross-references
 * them by number in the prose. Adding one in the middle by hand means editing all three in
 * step across two languages, which is exactly the kind of edit that looks done and is not.
 * The anchors are regenerated from the headings that end up in the file rather than
 * predicted, for the same reason the Ukrainian build does it: a heading is the only thing
 * that decides what an anchor is.
 */
import { readFileSync, writeFileSync } from "fs";

const [, , file, atArg, bodyFile] = process.argv;
const at = Number(atArg);
if (!file || !at || !bodyFile) {
  console.error("usage: insert-section.mjs <guidebook.md> <number> <section-body.md>");
  process.exit(1);
}

let doc = readFileSync(file, "utf8");
const body = readFileSync(bodyFile, "utf8").trim();

// Renumber downwards so a section never briefly collides with the one it is becoming.
const headings = [...doc.matchAll(/^## (\d+)\. (.+)$/gm)].map(([, n, title]) => ({ n: Number(n), title }));
for (const heading of [...headings].reverse()) {
  if (heading.n < at) continue;
  doc = doc.replace(new RegExp(`^## ${heading.n}\\. `, "m"), `## ${heading.n + 1}. `);
}

// The new section goes in front of what now carries the next number.
const anchorHeading = new RegExp(`^## ${at + 1}\\. `, "m");
const where = doc.search(anchorHeading);
if (where === -1) throw new Error(`no section ${at + 1} to insert before`);
doc = `${doc.slice(0, where)}${body}\n\n---\n\n${doc.slice(where)}`;

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

const final = [...doc.matchAll(/^## (\d+)\. (.+)$/gm)].map(([, n, title]) => ({
  n: Number(n),
  title,
  anchor: slug(`${n}. ${title}`),
}));

// Cross-references first, while the old numbers are still in the prose.
const byNumber = new Map(final.map((h) => [h.n, h]));
doc = doc.replace(/\(#(\d+)-[^)]*\)/g, (whole, n) => {
  const shifted = Number(n) >= at ? Number(n) + 1 : Number(n);
  const heading = byNumber.get(shifted);
  return heading ? `(#${heading.anchor})` : whole;
});
doc = doc.replace(/§(\d+)/g, (whole, n) => (Number(n) >= at ? `§${Number(n) + 1}` : whole));

const list = final.map((h) => `${h.n}. [${h.title}](#${h.anchor})`).join("\n");
doc = doc.replace(/(\*\*(?:Contents|Зміст)\*\*\n\n)(?:.+\n)+?(\n---)/, `$1${list}\n$2`);

writeFileSync(file, doc, "utf8");
console.log(`${file}: ${final.length} sections, contents rebuilt`);
