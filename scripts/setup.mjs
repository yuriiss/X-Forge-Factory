#!/usr/bin/env node
/**
 * First-run setup.
 *
 *   npm run setup
 *
 * Writes `.env.local`: a freshly generated master key for credential encryption, and the
 * operator's Magnific API key — which is verified against the live API before it is
 * written, because a console that starts with a bad key fails later and less clearly.
 *
 * Nothing here talks to the console; it only prepares the environment it needs. Run it
 * again at any time to change a value — existing settings are offered as defaults and the
 * previous file is backed up.
 */
import { createInterface } from "readline/promises";
import { randomBytes } from "crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { stdin, stdout } from "process";

const ENV = path.resolve(".env.local");
const rl = createInterface({ input: stdin, output: stdout });

const c = {
  gold: (s) => `\x1b[38;5;179m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/** Read the existing file so a re-run is an edit rather than a reset. */
function readEnv() {
  if (!existsSync(ENV)) return {};
  const out = {};
  for (const line of readFileSync(ENV, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Ask, or take the default.
 *
 * Two input modes, because they behave differently. On a terminal, readline waits for each
 * answer as you would expect. On a pipe — a provisioning script, a CI job — readline drops
 * lines that arrive before their question exists, and then hangs on an unsettled await when
 * the input runs out. So piped input is read once, up front, and answered from a queue:
 * `printf '\\n\\n8080\\n' | npm run setup` then does exactly what it looks like it does.
 */
const piped = !stdin.isTTY ? (await readAll()).split("\n") : null;

async function readAll() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function ask(question, fallback) {
  const suffix = fallback ? c.dim(` [${fallback}]`) : "";
  if (piped) {
    const next = (piped.shift() ?? "").trim();
    stdout.write(`${question}${suffix} ${next || c.dim("(default)")}\n`);
    return next || fallback || "";
  }
  const answer = await rl.question(`${question}${suffix} `);
  return (answer || "").trim() || fallback || "";
}

/**
 * Prove the key works before storing it.
 *
 * The uploads listing is authenticated, free and immediate — a generation would validate
 * the key by charging for it.
 */
async function verifyKey(key) {
  try {
    const res = await fetch("https://api.magnific.com/v1/ai/uploads", {
      headers: { "x-magnific-api-key": key },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, why: "Magnific rejected that key" };
    return { ok: false, why: `Magnific answered HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, why: `could not reach Magnific — ${e.message}` };
  }
}

console.log(`
${c.gold("◆")} ${c.bold("X-FORGE")} ${c.dim("· setup")}

  This writes .env.local. Nothing leaves your machine: the API key is stored locally,
  encrypted at rest, and is never sent anywhere except to api.magnific.com.
`);

const current = readEnv();

/* ── the Magnific key ─────────────────────────────────────────────────────── */

let key = "";
const existingKey = current.MAGNIFIC_API_KEY;
if (existingKey) {
  const keep = await ask(`Keep the existing API key (…${existingKey.slice(-4)})? ${c.dim("y/n")}`, "y");
  if (keep.toLowerCase().startsWith("y")) key = existingKey;
}

while (!key) {
  const entered = await ask(`${c.bold("Magnific API key")} ${c.dim("(magnific.com → user → API keys, or blank to skip)")}\n ›`);
  if (!entered) {
    console.log(c.dim("  Skipped. The console will start, but nothing can run until you add a key in Developers.\n"));
    break;
  }
  stdout.write("  verifying… ");
  const check = await verifyKey(entered);
  if (check.ok) {
    console.log(c.green("ok"));
    key = entered;
  } else {
    console.log(c.red(`✕ ${check.why}`));
  }
}

/* ── the rest ─────────────────────────────────────────────────────────────── */

const webhookSecret = await ask(
  `${c.bold("Webhook signing secret")} ${c.dim("(from the same page; blank if you are not using webhooks)")}\n ›`,
  current.MAGNIFIC_WEBHOOK_SECRET ?? "",
);

const port = await ask(`${c.bold("Port")}`, current.FORGE_PORT ?? "7777");
const home = await ask(`${c.bold("Data directory")} ${c.dim("(database and asset vault)")}`, current.FORGE_HOME ?? "~/.x-forge");
const video = await ask(`${c.bold("Enable video generation?")} ${c.dim("the fastest way to spend credits")} ${c.dim("y/n")}`, current.FORGE_VIDEO_ENABLED === "1" ? "y" : "n");
const threshold = await ask(`${c.bold("Approval threshold")} ${c.dim("credits above which a job waits for a human")}`, current.FORGE_APPROVAL_THRESHOLD ?? "400");

// A new master key is generated only when there is not one already: replacing it would
// orphan every credential sealed under the old one.
const master = current.FORGE_MASTER_KEY || randomBytes(32).toString("hex");
const generatedMaster = !current.FORGE_MASTER_KEY;

const file = `# X-Forge — local configuration. Never commit this file.
# Rewrite it at any time with: npm run setup

# ── Magnific ────────────────────────────────────────────────────────────────
# Server-side only. The browser never sees this key.
MAGNIFIC_API_KEY=${key}
MAGNIFIC_WEBHOOK_SECRET=${webhookSecret}

# ── Engine ──────────────────────────────────────────────────────────────────
FORGE_PORT=${port}
FORGE_PUBLIC_URL=http://127.0.0.1:${port}
FORGE_HOME=${home}

# Master key for credential envelope encryption. Losing it means re-entering the API key;
# changing it without re-wrapping means the same.
FORGE_MASTER_KEY=${master}

# Jobs estimated above this wait for a human on a one-time link.
FORGE_APPROVAL_THRESHOLD=${threshold}
# Jobs that would drop the balance below this are rejected outright.
FORGE_CREDIT_FLOOR=${current.FORGE_CREDIT_FLOOR ?? "0"}
# Video is the expensive family, so it is a deliberate switch.
FORGE_VIDEO_ENABLED=${video.toLowerCase().startsWith("y") ? "1" : "0"}

# Outbound shaping. Magnific allows 50 requests per minute per key.
FORGE_RPM_LIMIT=${current.FORGE_RPM_LIMIT ?? "45"}
FORGE_GLOBAL_RPM=${current.FORGE_GLOBAL_RPM ?? "45"}
FORGE_MAX_CONCURRENT=${current.FORGE_MAX_CONCURRENT ?? "3"}
FORGE_RETENTION_DAYS=${current.FORGE_RETENTION_DAYS ?? "30"}

# ── Optional ────────────────────────────────────────────────────────────────
# Adopt an MCP session another client on this machine already authorised, instead of
# signing in again. Colon-separated paths to their mcp.json. Off unless set.
FORGE_MCP_IMPORT=${current.FORGE_MCP_IMPORT ?? ""}
`;

if (existsSync(ENV)) {
  copyFileSync(ENV, `${ENV}.backup`);
  console.log(c.dim(`\n  previous .env.local saved as .env.local.backup`));
}
writeFileSync(ENV, file, { mode: 0o600 });

console.log(`
${c.green("✓")} .env.local written ${c.dim("(mode 600)")}
${generatedMaster ? `${c.green("✓")} master key generated\n` : ""}
  ${c.bold("Next")}
    npm run dev          ${c.dim(`→ http://127.0.0.1:${port}`)}

  Then open ${c.gold("MCP Console → CONNECT")} and sign in once. Without it you still get
  image and video generation on the REST key, but no balance, no cost estimates,
  no full catalogue, no text-to-speech and no 3D.

  The guidebook covers every screen: ${c.gold("GUIDEBOOK.md")}
`);

rl.close();
