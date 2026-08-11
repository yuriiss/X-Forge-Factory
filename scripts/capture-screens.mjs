#!/usr/bin/env node
/**
 * Capture one screenshot per view for the guidebook.
 *
 * The guidebook shows the console as it actually looks with this operator's account
 * behind it — a documentation screenshot of an empty mock would be the one thing this
 * project set out not to produce. Run it with the console up on 7777.
 *
 *   node scripts/capture-screens.mjs                 # English → docs/images
 *   node scripts/capture-screens.mjs --lang uk       # Ukrainian → docs/images/uk
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "fs";
import path from "path";

const BASE = process.env.XFORGE_BASE ?? "http://127.0.0.1:7777";

const langArg = process.argv.indexOf("--lang");
const LANG = langArg === -1 ? "en" : process.argv[langArg + 1];
const OUT = path.resolve(LANG === "en" ? "docs/images" : `docs/images/${LANG}`);

const VIEWS = [
  ["Dashboard", "dashboard"],
  ["Chat", "chat"],
  ["Image Forge", "image-forge"],
  ["Video Forge", "video-forge"],
  ["Audio Lab", "audio-lab"],
  ["3D & Soul", "soul-forge"],
  ["Icon Foundry", "icon-foundry"],
  ["Upscale Studio", "upscale"],
  ["Edit Suite", "edit-suite"],
  ["Flows", "flows"],
  ["Task Queue", "tasks"],
  ["Creations", "creations"],
  ["Stock", "stock"],
  ["Utilities", "utilities"],
  ["MCP Console", "mcp"],
  ["Analytics", "analytics"],
  ["Developers", "developers"],
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium" });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });

/**
 * Mask the values that identify this particular account.
 *
 * The screenshots ship in a public repository, so anything that points at the operator's
 * credential is replaced before the shutter: the key's last four characters, its
 * fingerprint, and the MCP session id. Balances and job history stay — they are what makes
 * the documentation show a working console rather than an empty one, and neither is a
 * secret. Pass `--no-redact` to capture verbatim.
 */
const REDACT = !process.argv.includes("--no-redact");

async function redact() {
  if (!REDACT) return;
  await page.evaluate(() => {
    const mask = (el, text) => {
      if (el) el.textContent = text;
    };
    // Topbar: KEY · …abcd. The chip is translated, so it is matched on the separator and
    // the four characters rather than on the word in front of them.
    for (const chip of document.querySelectorAll(".topbar .chip")) {
      const text = chip.textContent ?? "";
      if (/·\s*…\w{4}$/.test(text)) mask(chip, `${text.split("·")[0]}· ••••`);
    }
    // Developers: last four, fingerprint, and the session id beside them.
    const SECRET_LABELS = new Set(["key", "fingerprint", "session", "ключ", "відбиток", "сесія"]);
    for (const kv of document.querySelectorAll(".kv")) {
      const label = kv.querySelector("span")?.textContent?.trim().toLowerCase();
      if (label && SECRET_LABELS.has(label)) mask(kv.querySelector("b"), "••••••••");
    }
    // Services row on the dashboard shows the same four characters.
    for (const row of document.querySelectorAll(".provider-row")) {
      const first = row.querySelector("span")?.textContent?.trim().toLowerCase();
      if (first === "credential" || first === "обліковий ключ") mask(row.querySelector(".muted"), "••••");
    }
  });
}

// The language is a stored preference, so it has to be in place before the console's first
// render — an origin has to exist before localStorage can be written to, which is why this
// loads the page once, sets the key, and reloads.
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.evaluate((lang) => window.localStorage.setItem("x-forge.lang", lang), LANG);

await page.goto(BASE, { waitUntil: "networkidle" });
// The catalogue and balance land a moment after first paint; documenting the empty frame
// would be documenting a loading state.
await page.waitForTimeout(3000);

for (const [, id] of VIEWS) {
  // Navigated by hash rather than by clicking a label: the labels are translated, the
  // route ids are not.
  await page.evaluate((view) => {
    window.location.hash = view;
  }, id);
  await page.waitForTimeout(2200);
  await redact();
  await page.screenshot({ path: path.join(OUT, `${id}.png`) });
  process.stdout.write(`  ✓ ${id}${REDACT ? "" : "  (verbatim)"}\n`);
}

await browser.close();
console.log(`\n${VIEWS.length} screenshots (${LANG}) in ${OUT}`);
