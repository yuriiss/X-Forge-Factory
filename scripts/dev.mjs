#!/usr/bin/env node
/**
 * Launch Next on the port `.env.local` asks for.
 *
 * The setup script asks the operator which port to use, so the start command has to
 * honour that answer. Next reads `.env.local` for the application but not for its own CLI
 * flags, and shell interpolation in an npm script is not portable — so the port is read
 * here and passed as an argument.
 *
 *   node scripts/dev.mjs          → next dev
 *   node scripts/dev.mjs start    → next start
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
const next = path.resolve("node_modules", ".bin", "next");

const child = spawn(next, [mode, "-H", "127.0.0.1", "-p", port], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
