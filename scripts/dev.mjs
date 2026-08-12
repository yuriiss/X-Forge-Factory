#!/usr/bin/env node
/**
 * Launch Next on the port `.env.local` asks for.
 *
 * The setup script asks the operator which port to use, so the start command has to honour
 * that answer. Next reads `.env.local` for the application but not for its own CLI flags,
 * and shell interpolation in an npm script is not portable — so the port is read here and
 * passed as an argument.
 *
 *   node scripts/dev.mjs          → next dev    (hot reload; for working on X-Forge)
 *   node scripts/dev.mjs start    → next start  (what an operator runs; needs a build)
 *
 * `start` refuses to guess when there is no build. Next would otherwise print its own
 * error, which tells you a manifest is missing rather than that you skipped a step.
 */
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";

const mode = process.argv[2] === "start" ? "start" : "dev";

function envPort() {
  const file = path.resolve(".env.local");
  if (!existsSync(file)) return null;
  const m = readFileSync(file, "utf8").match(/^FORGE_PORT=(\d+)\s*$/m);
  return m ? m[1] : null;
}

const port = process.env.PORT || envPort() || "7777";
const host = process.env.FORGE_HOST || "127.0.0.1";

if (mode === "start" && !existsSync(path.resolve(".next", "BUILD_ID"))) {
  console.error("There is no build to serve. Run `npm run build` first, or `npm run dev` to work on the source.");
  process.exit(1);
}

// npm installs a shell script on POSIX and a `.cmd` shim on Windows; the extensionless
// file simply does not exist there, and spawning it fails with ENOENT.
const binary = path.resolve("node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");

const child = spawn(binary, [mode, "-H", host, "-p", port], {
  stdio: "inherit",
  env: process.env,
  // A `.cmd` is not an executable image: Windows needs a shell to run it.
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));
