#!/usr/bin/env node
/**
 * Keep X-Forge running, and bring it back after a reboot.
 *
 *   node scripts/service.mjs install            # production: serves the build
 *   node scripts/service.mjs install --dev      # development: hot reload, for working on it
 *   node scripts/service.mjs status
 *   node scripts/service.mjs remove
 *
 * The unit runs as *you*, not as root, and that is not a detail: the console spawns the
 * coding CLIs on this machine, and those hold their sign-ins in your home directory. A
 * system-wide service would run as another user, find none of them, and be unable to read
 * the vault either.
 *
 * Linux gets a systemd user unit, macOS a launchd agent. Windows has no equivalent that can
 * be written safely from a script without elevation, so it is told what to do instead of
 * being half-configured.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const action = process.argv[2] ?? "status";
const dev = process.argv.includes("--dev");

const root = path.resolve(process.cwd());
const node = process.execPath;
const label = "x-forge";

/** The PATH a login shell would have, so the CLIs the console spawns are findable. */
function servicePath() {
  const home = os.homedir();
  return [
    path.dirname(node),
    path.join(home, ".local/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".cargo/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".kimi-code/bin"),
    path.join(home, ".grok/bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
    .filter((dir) => existsSync(dir))
    .join(":");
}

function run(command, args, { check = true } = {}) {
  const r = spawnSync(command, args, { stdio: "inherit" });
  if (check && r.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${r.status}`);
  return r.status;
}

/* ------------------------------------------------------------------- linux -- */

const systemdDir = path.join(os.homedir(), ".config", "systemd", "user");
const systemdUnit = path.join(systemdDir, `${label}.service`);

function linuxInstall() {
  mkdirSync(systemdDir, { recursive: true });
  writeFileSync(
    systemdUnit,
    `[Unit]
Description=X-Forge — operator console for Magnific${dev ? " (development)" : ""}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${node} ${path.join(root, "scripts", "dev.mjs")}${dev ? "" : " start"}
Environment="PATH=${servicePath()}"
Environment="NODE_ENV=${dev ? "development" : "production"}"
Restart=always
RestartSec=5
KillMode=mixed
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`,
    "utf8",
  );

  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", `${label}.service`]);

  // Without lingering a user unit starts at login rather than at boot, which is not what
  // "comes back after a restart" means on a machine that reboots unattended.
  const linger = spawnSync("loginctl", ["show-user", os.userInfo().username, "-p", "Linger"], { encoding: "utf8" });
  if (!/Linger=yes/.test(linger.stdout ?? "")) {
    console.log("\nAsking for lingering so the service starts at boot rather than at login:");
    run("loginctl", ["enable-linger", os.userInfo().username], { check: false });
  }

  console.log(`\n${label} installed as a systemd user unit, ${dev ? "development" : "production"} mode.`);
  console.log(`  journalctl --user -u ${label} -f      # follow the log`);
  console.log(`  systemctl --user restart ${label}     # after changing .env.local`);
}

function linuxRemove() {
  run("systemctl", ["--user", "disable", "--now", `${label}.service`], { check: false });
  if (existsSync(systemdUnit)) rmSync(systemdUnit);
  run("systemctl", ["--user", "daemon-reload"], { check: false });
  console.log(`${label} removed.`);
}

function linuxStatus() {
  if (!existsSync(systemdUnit)) return console.log("not installed");
  run("systemctl", ["--user", "status", `${label}.service`, "--no-pager"], { check: false });
}

/* ------------------------------------------------------------------ macos -- */

const launchLabel = `com.maritime.${label}`;
const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${launchLabel}.plist`);

function macInstall() {
  mkdirSync(path.dirname(plist), { recursive: true });
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${path.join(root, "scripts", "dev.mjs")}</string>${dev ? "" : "\n    <string>start</string>"}
  </array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${servicePath()}</string>
    <key>NODE_ENV</key><string>${dev ? "development" : "production"}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(os.homedir(), "Library", "Logs", `${label}.log`)}</string>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), "Library", "Logs", `${label}.log`)}</string>
</dict>
</plist>
`,
    "utf8",
  );

  run("launchctl", ["unload", plist], { check: false });
  run("launchctl", ["load", plist]);
  console.log(`\n${label} installed as a launchd agent, ${dev ? "development" : "production"} mode.`);
  console.log(`  tail -f ~/Library/Logs/${label}.log`);
}

function macRemove() {
  run("launchctl", ["unload", plist], { check: false });
  if (existsSync(plist)) rmSync(plist);
  console.log(`${label} removed.`);
}

function macStatus() {
  if (!existsSync(plist)) return console.log("not installed");
  try {
    console.log(execFileSync("launchctl", ["list", launchLabel], { encoding: "utf8" }));
  } catch {
    console.log("installed, not running");
  }
}

/* ---------------------------------------------------------------- windows -- */

function windowsSays() {
  const command = `${node} ${path.join(root, "scripts", "dev.mjs")}${dev ? "" : " start"}`;
  console.log(`X-Forge does not install a Windows service from here: doing it properly needs elevation,
and a half-registered service is worse than none.

Two ways to get the same result, both as your own user:

  1. Task Scheduler — create a task, trigger "At log on", action:
       Program:   ${node}
       Arguments: ${path.join(root, "scripts", "dev.mjs")}${dev ? "" : " start"}
       Start in:  ${root}

  2. Startup folder — put a shortcut to that command in
       shell:startup   (Win+R, then that word)

The command itself:
  ${command}`);
}

/* -------------------------------------------------------------------------- */

const platform = process.platform;
const handlers = {
  linux: { install: linuxInstall, remove: linuxRemove, status: linuxStatus },
  darwin: { install: macInstall, remove: macRemove, status: macStatus },
  win32: { install: windowsSays, remove: windowsSays, status: windowsSays },
};

const handler = handlers[platform];
if (!handler) {
  console.error(`no service recipe for ${platform}; run \`npm start\` yourself`);
  process.exit(1);
}
if (!handler[action]) {
  console.error(`usage: node scripts/service.mjs <install|remove|status> [--dev]`);
  process.exit(1);
}

if (action === "install" && !dev && !existsSync(path.join(root, ".next", "BUILD_ID"))) {
  console.error("There is no build to serve. Run `npm run build` first, or install with --dev.");
  process.exit(1);
}

handler[action]();
