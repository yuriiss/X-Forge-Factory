#!/usr/bin/env node
/**
 * Join the three translated slices into GUIDEBOOK.uk.md and rebuild the contents list.
 *
 * The table of contents cannot survive translation: GitHub derives an anchor from the
 * heading text, so the moment `## 4. Dashboard` becomes `## 4. Панель` every link written
 * against the English anchor points at nothing. Rather than ask a translator to keep two
 * lists in step, the anchors are regenerated here from the headings that actually exist.
 */
import { readFileSync, writeFileSync, unlinkSync } from "fs";

const parts = ["1", "2", "3"].map((n) => readFileSync(`.tmp-uk-part${n}.md`, "utf8").replace(/\s+$/, ""));
let doc = parts.join("\n\n") + "\n";

/** GitHub's rule: lowercase, drop punctuation, spaces to dashes. Cyrillic survives intact. */
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

const headings = [...doc.matchAll(/^## (\d+)\. (.+)$/gm)].map(([, n, title]) => ({
  n: Number(n),
  title,
  anchor: slug(`${n}. ${title}`),
}));

const toc = headings.map((h) => `${h.n}. [${h.title}](#${h.anchor})`).join("\n");

// The list sits between the bold label and the horizontal rule that closes the front matter.
doc = doc.replace(/(\*\*Зміст\*\*\n\n)(?:.+\n)+?(\n---)/, `$1${toc}\n$2`);

// Cross-references inside the body point at the same anchors.
const byNumber = new Map(headings.map((h) => [h.n, h.anchor]));
doc = doc.replace(/\(#(\d+)-[^)]*\)/g, (whole, n) => (byNumber.has(Number(n)) ? `(#${byNumber.get(Number(n))})` : whole));

// Screenshots of a Ukrainian console live beside the English ones, not on top of them.
doc = doc.replace(/\(docs\/images\/(?!uk\/)([\w-]+\.png)\)/g, "(docs/images/uk/$1)");

writeFileSync("GUIDEBOOK.uk.md", doc, "utf8");
for (const n of ["1", "2", "3"]) unlinkSync(`.tmp-uk-part${n}.md`);

console.log(`GUIDEBOOK.uk.md · ${doc.split("\n").length} lines · ${headings.length} sections linked`);
