#!/usr/bin/env node
/**
 * Render a markdown document to PDF.
 *
 *   node scripts/make-pdf.mjs GUIDEBOOK.md docs/X-Forge-Guidebook.pdf
 *
 * Chromium does the typesetting, which is why there is no LaTeX toolchain here: the
 * document is already HTML-shaped, the screenshots are already PNGs, and a browser lays
 * both out correctly on paper without a second markup language in between.
 *
 * The page style is print-first — dark screenshots on a light page — because a guidebook
 * that is printed or read in a PDF viewer should not be a wall of black ink. The accent
 * colour is the console's, so the two still look related.
 */
import { chromium } from "playwright-core";
import { marked } from "marked";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

const [, , inputArg, outputArg] = process.argv;
const input = path.resolve(inputArg ?? "GUIDEBOOK.md");
const output = path.resolve(outputArg ?? "docs/X-Forge-Guidebook.pdf");

if (!existsSync(input)) {
  console.error(`no such file: ${input}`);
  process.exit(1);
}

/**
 * The cover, the running head and the footer are the script's own words rather than the
 * document's, so they need translating too — a Ukrainian guidebook with an English cover
 * is worse than either language alone. The document decides which set to use by its
 * filename, which keeps the two builds a single command apart.
 */
const lang = /\.uk\.md$/.test(input) ? "uk" : "en";
const CHROME = {
  en: {
    sub: "Operator Guidebook",
    blurb:
      "Every screen and every control of the Magnific operator console: what it does, what it costs, what it needs first, and what to do when it refuses.",
    console: "Console",
    surfaces: "Surfaces",
    generated: "Generated",
    running: "X-FORGE · Operator Guidebook",
  },
  uk: {
    sub: "Керівництво оператора",
    blurb:
      "Кожен екран і кожен елемент керування консолі Magnific: що він робить, скільки коштує, що йому потрібно спочатку і що робити, коли він відмовляється.",
    console: "Консоль",
    surfaces: "Поверхні",
    generated: "Складено",
    running: "X-FORGE · Керівництво оператора",
  },
}[lang];

const markdown = readFileSync(input, "utf8");
const title = (markdown.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(input)).replace(/\s*·\s*/g, " · ");

// Images are inlined as data URIs so the intermediate HTML is portable and the PDF cannot
// end up with missing figures because a relative path resolved differently.
const renderer = new marked.Renderer();
const baseDir = path.dirname(input);
renderer.image = ({ href, title: t, text }) => {
  const file = path.resolve(baseDir, href ?? "");
  if (!existsSync(file)) return `<p class="missing">[missing image: ${href}]</p>`;
  const b64 = readFileSync(file).toString("base64");
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  return `<figure><img src="data:${mime};base64,${b64}" alt="${text ?? ""}"><figcaption>${t ?? text ?? ""}</figcaption></figure>`;
};

// The cover states the title, so the body starts after it — otherwise page two opens with
// the same words in a smaller font.
const withoutTitle = markdown.replace(/^#\s+.+\n+/, "");
const body = marked.parse(withoutTitle, { renderer, gfm: true, breaks: false });

const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>
<style>
  :root {
    --ink:#12161f; --ink-2:#3d4757; --muted:#6b7789; --rule:#dfe4ec; --rule-2:#eef1f6;
    --accent:#b5822a; --accent-bg:#fdf6e6; --code-bg:#f5f7fa; --panel:#0d1322;
  }
  @page { size: A4; margin: 16mm 14mm 18mm; }
  * { box-sizing: border-box; }
  body {
    margin:0; color:var(--ink); background:#fff;
    font: 10.5pt/1.62 "Source Sans 3","DejaVu Sans","Liberation Sans",system-ui,sans-serif;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }

  /* ── cover ── */
  .cover { height: 246mm; display:flex; flex-direction:column; justify-content:center; page-break-after: always; }
  .cover .mark {
    width:52px; height:52px; border-radius:10px; background:var(--panel); color:#e8b64c;
    display:grid; place-items:center; font-size:24px; margin-bottom:22px;
  }
  .cover h1 { font-size:34pt; line-height:1.05; letter-spacing:1px; margin:0 0 8px; border:0; padding:0; }
  .cover .sub { font-size:13pt; color:var(--muted); margin-bottom:26px; }
  .cover .meta { font-size:9.5pt; color:var(--muted); border-top:1px solid var(--rule); padding-top:14px; max-width:120mm; }
  .cover .meta b { color:var(--ink-2); font-weight:600; }

  h1, h2, h3, h4 { line-height:1.25; margin:1.6em 0 .5em; page-break-after: avoid; }
  h1 { font-size:19pt; letter-spacing:.5px; border-bottom:2px solid var(--accent); padding-bottom:.25em; page-break-before: always; }
  h1:first-of-type { page-break-before: avoid; }
  h2 { font-size:14pt; color:var(--ink); border-bottom:1px solid var(--rule); padding-bottom:.2em; }
  h3 { font-size:11.5pt; color:var(--ink-2); }
  p, li { orphans:3; widows:3; }
  a { color:var(--accent); text-decoration:none; }
  strong { color:var(--ink); }
  hr { border:0; border-top:1px solid var(--rule-2); margin:1.8em 0; }

  code {
    font-family:"DejaVu Sans Mono","Liberation Mono",monospace; font-size:9pt;
    background:var(--code-bg); border:1px solid var(--rule); border-radius:3px; padding:.5px 4px;
  }
  pre {
    background:var(--code-bg); border:1px solid var(--rule); border-left:3px solid var(--accent);
    border-radius:4px; padding:10px 12px; overflow:hidden; page-break-inside: avoid;
  }
  pre code { background:none; border:0; padding:0; font-size:8.5pt; line-height:1.55; white-space:pre-wrap; }

  table { width:100%; border-collapse:collapse; font-size:9pt; margin:1em 0; page-break-inside:avoid; }
  th { text-align:left; background:var(--accent-bg); border-bottom:1.5px solid var(--accent);
       padding:6px 8px; font-size:8.5pt; letter-spacing:.4px; text-transform:uppercase; color:#7a5a1c; }
  td { padding:6px 8px; border-bottom:1px solid var(--rule-2); vertical-align:top; }
  tr:nth-child(even) td { background:#fafbfd; }

  blockquote {
    margin:1.2em 0; padding:10px 14px; background:var(--accent-bg);
    border-left:3px solid var(--accent); border-radius:0 4px 4px 0; color:var(--ink-2);
  }
  blockquote p { margin:0; }

  figure { margin:1.2em 0; page-break-inside: avoid; }
  figure img { width:100%; border:1px solid var(--rule); border-radius:5px; display:block; }
  figcaption { font-size:8pt; color:var(--muted); margin-top:5px; text-align:center; }

  ol > li, ul > li { margin:.3em 0; }
  ol { padding-left:2.1em; }
  ul { padding-left:1.4em; }
</style></head>
<body>
  <section class="cover">
    <div class="mark">◆</div>
    <h1>X-FORGE</h1>
    <div class="sub">${CHROME.sub}</div>
    <div class="meta">
      ${CHROME.blurb}
      <br><br>
      <b>${CHROME.console}</b> http://127.0.0.1:7777 &nbsp;·&nbsp;
      <b>${CHROME.surfaces}</b> api.magnific.com (REST) + mcp.magnific.com (MCP over OAuth)
      <br>
      <b>${CHROME.generated}</b> ${new Date().toISOString().slice(0, 10)}
    </div>
  </section>
  ${body}
</body></html>`;

const htmlPath = output.replace(/\.pdf$/, ".html");
writeFileSync(htmlPath, html, "utf8");

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium" });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
await page.pdf({
  path: output,
  format: "A4",
  printBackground: true,
  margin: { top: "16mm", bottom: "18mm", left: "14mm", right: "14mm" },
  displayHeaderFooter: true,
  headerTemplate: `<div style="font-size:7pt;color:#98a2b3;width:100%;padding:0 14mm;font-family:sans-serif;">${CHROME.running}</div>`,
  footerTemplate: `<div style="font-size:7pt;color:#98a2b3;width:100%;padding:0 14mm;font-family:sans-serif;display:flex;justify-content:space-between;">
      <span>api.magnific.com + MCP</span><span class="pageNumber"></span></div>`,
});
await browser.close();

console.log(`${path.relative(process.cwd(), output)} written`);
console.log(`${path.relative(process.cwd(), htmlPath)} written (intermediate, previewable in a browser)`);
