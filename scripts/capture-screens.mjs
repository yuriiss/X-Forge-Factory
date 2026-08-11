#!/usr/bin/env node
/**
 * Capture one screenshot per view for the guidebook.
 *
 * The guidebook shows the console as it actually looks with this operator's account
 * behind it — a documentation screenshot of an empty mock would be the one thing this
 * project set out not to produce. Run it with the console up on 7777.
 *
 *   node scripts/capture-screens.mjs
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "fs";
import path from "path";

const BASE = process.env.XFORGE_BASE ?? "http://127.0.0.1:7777";
const OUT = path.resolve("docs/images");

const VIEWS = [
  ["Dashboard", "dashboard"],
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
    // Topbar: KEY · …abcd
    for (const chip of document.querySelectorAll(".topbar .chip")) {
      if (chip.textContent?.startsWith("KEY")) mask(chip, "KEY · ••••");
    }
    // Developers: last four, fingerprint, and the vault paths beside them.
    for (const kv of document.querySelectorAll(".kv")) {
      const label = kv.querySelector("span")?.textContent?.trim();
      if (label === "key" || label === "fingerprint" || label === "session") {
        mask(kv.querySelector("b"), "••••••••");
      }
    }
    // Services row on the dashboard shows the same four characters.
    for (const row of document.querySelectorAll(".provider-row")) {
      if (row.textContent?.includes("Credential")) mask(row.querySelector(".muted"), "••••");
    }
  });
}

await page.goto(BASE, { waitUntil: "networkidle" });
// The catalogue and balance land a moment after first paint; documenting the empty frame
// would be documenting a loading state.
await page.waitForTimeout(3000);

for (const [label, id] of VIEWS) {
  await page.locator(`.nav-item:has-text("${label}")`).first().click();
  await page.waitForTimeout(2200);
  await redact();
  await page.screenshot({ path: path.join(OUT, `${id}.png`) });
  process.stdout.write(`  ✓ ${id}${REDACT ? "" : "  (verbatim)"}\n`);
}

await browser.close();
console.log(`\n${VIEWS.length} screenshots in ${OUT}`);
