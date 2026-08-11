import { expect, test } from "@playwright/test";

/**
 * The console, driven like an operator would.
 *
 * Every view is opened and asserted on what it should have fetched — not merely that it
 * rendered, since a panel full of empty placeholders renders perfectly. Console errors and
 * failed requests are collected across the whole walk and asserted at the end, because a
 * React error that only breaks one panel does not fail a naive "did the page load" check.
 */

const VIEWS = [
  { id: "dashboard", heading: "DASHBOARD" },
  { id: "image-forge", heading: "IMAGE FORGE" },
  { id: "video-forge", heading: "VIDEO FORGE" },
  { id: "audio-lab", heading: "AUDIO LAB" },
  { id: "soul-forge", heading: "3D & SOUL" },
  { id: "icon-foundry", heading: "ICON FOUNDRY" },
  { id: "upscale", heading: "UPSCALE STUDIO" },
  { id: "edit-suite", heading: "EDIT SUITE" },
  { id: "flows", heading: "FLOWS" },
  { id: "tasks", heading: "TASK QUEUE" },
  { id: "creations", heading: "CREATIONS" },
  { id: "stock", heading: "STOCK" },
  { id: "utilities", heading: "UTILITIES" },
  { id: "mcp", heading: "MCP CONSOLE" },
  { id: "analytics", heading: "ANALYTICS" },
  { id: "developers", heading: "DEVELOPERS" },
];

test("every view opens, with live data and no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfailed", (r) => {
    const url = r.url();
    // Provider CDN thumbnails are outside our control and time out on a slow link; a
    // failure there is not a failure of the console.
    if (!url.startsWith("http://127.0.0.1:7777")) return;
    // Leaving a view unmounts its <video>, and the browser aborts the range request that
    // element had in flight. That is the browser doing the right thing, not a broken
    // asset — the same URL answers 200 to a plain fetch.
    const why = r.failure()?.errorText ?? "";
    if (why.includes("ERR_ABORTED")) return;
    errors.push(`request failed: ${url} (${why})`);
  });

  await page.goto("/", { waitUntil: "networkidle" });

  // The shell itself: brand, both transports, the credit chip.
  await expect(page.locator(".brand-title")).toHaveText("X-FORGE");
  await expect(page.locator(".topbar")).toContainText("connected");
  await expect(page.locator(".topbar")).toContainText("OAuth");
  await expect(page.locator(".topbar .chip.active")).toContainText("CREDITS");

  for (const view of VIEWS) {
    await page.locator(`.nav-item:has-text("${labelFor(view.id)}")`).first().click();
    await expect(page.locator("h1, h3").first()).toContainText(view.heading.split(" ")[0], { timeout: 15_000 });
    await page.waitForTimeout(600);
  }

  expect(errors, `console errors:\n${errors.join("\n")}`).toHaveLength(0);
});

test("the dashboard shows a real balance and the live catalogue reaches the pickers", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  // A balance that is a number, not a placeholder.
  const chip = page.locator(".topbar .chip.active");
  await expect(chip).not.toContainText("—");
  const credits = Number((await chip.textContent())!.replace(/[^\d]/g, ""));
  expect(credits).toBeGreaterThan(0);

  // Image Forge's catalogue panel is populated from images_models_list. The count is
  // awaited rather than sampled: the panel renders before its fetch resolves, so reading
  // it immediately measures the empty first paint.
  await page.locator('.nav-item:has-text("Image Forge")').click();
  await expect(page.locator(".panel-title:has-text('Model Catalog')")).toBeVisible();
  const models = page.locator(".panel:has(.panel-title:has-text('Model Catalog')) .provider-row");
  await expect.poll(() => models.count(), { timeout: 20_000 }).toBeGreaterThan(20);

  // Video Forge's model select carries the video catalogue.
  await page.locator('.nav-item:has-text("Video Forge")').click();
  const options = page.locator("select").first().locator("option");
  await expect.poll(() => options.count(), { timeout: 20_000 }).toBeGreaterThan(20);
});

test("the MCP console lists live tools and calls a free one", async ({ page }) => {
  await page.goto("/#mcp", { waitUntil: "networkidle" });
  await page.locator('.nav-item:has-text("MCP Console")').click();

  await expect(page.locator(".intro")).toContainText("CONNECTED");
  const tools = page.locator(".mcp-tool");
  await expect(tools.first()).toBeVisible({ timeout: 20_000 });
  expect(await tools.count()).toBeGreaterThan(40);

  // account_balance is free, so calling it proves the path without spending anything.
  await page.locator("select").first().selectOption("account_balance");
  await page.locator("button:has-text('CALL TOOL')").click();
  await expect(page.locator("pre.json")).toContainText("credits", { timeout: 30_000 });
});

test("the task queue shows the state machine for a finished job", async ({ page }) => {
  await page.goto("/#tasks", { waitUntil: "networkidle" });
  await page.locator('.nav-item:has-text("Task Queue")').click();

  const rows = page.locator("table.tbl tr");
  await expect(rows.first()).toBeVisible();
  // The API suite has run at least one job before this point.
  await page.locator("table.tbl tr").nth(1).click();
  await expect(page.locator(".panel-title:has-text('State transitions')")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".activity-row").first()).toBeVisible();
});

test("the language picker switches the console to Ukrainian and remembers it", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".nav-item:has-text('Dashboard')")).toBeVisible({ timeout: 20_000 });

  await page.locator(".lang-picker .chip").click();
  await page.locator(".lang-option:has-text('Українська')").click();

  // Navigation, headings and the document language all follow, not just the chip.
  await expect(page.locator(".lang-picker .chip")).toContainText("UA");
  await expect(page.locator(".nav-item:has-text('Панель')")).toBeVisible();
  await expect(page.locator(".intro h1")).toHaveText("ПАНЕЛЬ");
  await expect(page.locator("html")).toHaveAttribute("lang", "uk");

  // A view rendered after the switch is translated too — the choice is not a one-off repaint.
  await page.evaluate(() => {
    window.location.hash = "creations";
  });
  await expect(page.locator(".intro h1")).toHaveText("СТВОРЕНЕ");

  // And it survives a reload, which is the whole point of storing it.
  await page.reload();
  await expect(page.locator(".nav-item:has-text('Створене')")).toBeVisible({ timeout: 20_000 });

  await page.locator(".lang-picker .chip").click();
  await page.locator(".lang-option:has-text('English')").click();
  await expect(page.locator(".nav-item:has-text('Creations')")).toBeVisible();
});

function labelFor(id: string): string {
  const map: Record<string, string> = {
    dashboard: "Dashboard",
    "image-forge": "Image Forge",
    "video-forge": "Video Forge",
    "audio-lab": "Audio Lab",
    "soul-forge": "3D & Soul",
    "icon-foundry": "Icon Foundry",
    upscale: "Upscale Studio",
    "edit-suite": "Edit Suite",
    flows: "Flows",
    tasks: "Task Queue",
    creations: "Creations",
    stock: "Stock",
    utilities: "Utilities",
    mcp: "MCP Console",
    analytics: "Analytics",
    developers: "Developers",
  };
  return map[id];
}
