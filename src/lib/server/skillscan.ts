import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Static risk scan for "agent skills" — a directory of a SKILL.md plus whatever ships
 * alongside it — before anything in it is installed or read by an agent.
 *
 * A skill is untrusted input with an unusually large blast radius: it is simultaneously
 * (a) instructions an agent will follow (SKILL.md is prompt-injection surface) and
 * (b) code an agent may run with the user's own credentials (scripts are malware surface).
 * This module is the static tier only — pattern matching over file contents, ported from
 * skill_validator.py. The Python original also has a sandbox tier (skill_sandbox.py) that
 * actually executes Python files under an audit hook to observe real behaviour; that tier
 * is deliberately not ported here, because this scanner never runs any code it inspects.
 *
 * The one decision worth naming: this is static-only and fails closed. Detection is a set
 * of known-bad patterns, not a proof of absence — a determined attacker can write code this
 * scanner does not recognise. Because of that, the outcome routing never lets executable
 * content it cannot inspect (a shell/binary script, or a directory too large to finish
 * walking) reach INSTALL on the strength of a clean pattern match alone; those cases are
 * routed to REVIEW or REJECT instead. An INSTALL verdict means "no known-bad pattern was
 * found", not "this skill is safe".
 */

export type Severity = "critical" | "warn" | "info";
export type Outcome = "INSTALL" | "REVIEW" | "REJECT";

export interface Finding {
  severity: Severity;
  rule: string;
  where: string;
  evidence: string;
}

export interface Verdict {
  outcome: Outcome;
  why: string;
  findings: Finding[];
  files: number;
  unprobed: string[];
}

interface Rule {
  severity: Severity;
  rule: string;
  pattern: RegExp;
  /** Only applied to files a shell actually interprets. */
  shellOnly?: boolean;
}

// Extensions whose content is readable text and worth pattern-scanning at all (mirrors
// TEXT_EXT in skill_validator.py). "" covers extensionless files such as shebang scripts.
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".py", ".sh", ".bash", ".zsh", ".js", ".cjs", ".mjs",
  ".ts", ".tsx", ".jsx", ".yaml", ".yml", ".json", ".toml", ".cfg", ".ini",
  ".ps1", ".bat", ".cmd", ".rb", ".pl", ".php", ".lua", ".html", ".xml",
  ".csv", ".env", ".rst", ".mdx", "",
]);

// Extensions whose content is executable and gets CODE_RULES on top of INSTRUCTION_RULES
// (mirrors CODE_EXT).
const CODE_EXTENSIONS = new Set([
  ".py", ".sh", ".bash", ".zsh", ".js", ".cjs", ".mjs", ".ts", ".tsx",
  ".jsx", ".rb", ".pl", ".php", ".lua", ".ps1", ".bat", ".cmd",
]);

// Known-binary formats that are never pattern-scanned and never flagged as unexpected
// (mirrors BINARY_ALLOW).
const BINARY_ALLOWLIST = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".wav", ".mp4", ".zip",
]);

// Scripts in these formats cannot be inspected with any confidence by pattern matching
// alone (a shell interpreter treats far too much syntax as "just text" for a regex to
// reason about) and this scanner has no sandbox tier to fall back on, so their presence
// forces REVIEW regardless of what the patterns did or did not find.
const SHELL_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd"]);

// A single file this large already blows past what a human reviewer will read before
// installing anyway (mirrors MAX_FILE_BYTES = 2_000_000 in skill_validator.py).
const MAX_SINGLE_FILE_BYTES = 2_000_000;

// Caps on the walk itself, independent of any one file's size. Hit either one and the
// scan stops and REJECTs rather than silently scanning a truncated subset of the skill —
// a partial scan that reports INSTALL would be a false clean bill of health.
const MAX_TOTAL_FILES = 2000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Executable-code patterns: exfiltration, download-and-execute, secrets access,
 * persistence. Applied only to files whose extension is in CODE_EXTENSIONS.
 *
 * Every pattern below is ported verbatim from CODE_RULES in skill_validator.py — plain
 * character classes, alternation, bounded quantifiers and one negative lookahead, all of
 * which JavaScript's regex engine supports identically to Python's `re`, so none of them
 * needed to change. `String.raw` is used purely to keep the escaping visually identical to
 * the Python raw strings the patterns were copied from.
 */
const CODE_RULES: Rule[] = [
  {
    severity: "critical",
    rule: "download-and-execute",
    pattern: new RegExp(
      String.raw`(curl|wget)[^\n|;&]{0,200}\|\s*(ba)?sh|curl\s+[^\n]*-o[^\n]*&&[^\n]*(chmod|sh|bash|python)`,
      "i",
    ),
  },
  {
    severity: "critical",
    rule: "eval-of-decoded-payload",
    pattern: new RegExp(
      String.raw`(eval|exec)\s*\(\s*(base64|b64decode|bytes\.fromhex|codecs\.decode|atob)`,
      "i",
    ),
  },
  {
    severity: "critical",
    rule: "reverse-shell",
    pattern: new RegExp(
      String.raw`(/dev/tcp/|nc\s+-e|ncat\s+-e|socket\.socket[^\n]{0,120}subprocess|sh\s+-i\s+2>&1)`,
      "i",
    ),
  },
  {
    severity: "critical",
    rule: "credential-file-access",
    pattern: new RegExp(
      String.raw`(\.ssh/id_|id_rsa|id_ed25519|\.aws/credentials|\.netrc|\.gnupg|/etc/shadow|` +
        String.raw`\.docker/config\.json|\.kube/config|\.config/gcloud|\.pgpass|\.npmrc|\.pypirc|` +
        String.raw`\.git-credentials|\.terraform|keychain|Login Data|Cookies|cookies\.sqlite|` +
        String.raw`key3\.db|key4\.db|logins\.json)`,
      "i",
    ),
  },
  {
    severity: "critical",
    rule: "env-secret-exfil",
    pattern: new RegExp(
      String.raw`(requests\.(post|get)|urllib|curl|wget|fetch|httpx)[^\n]{0,250}` +
        String.raw`(os\.environ|process\.env|\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASS)|printenv|env\b)`,
      "i",
    ),
  },
  {
    severity: "warn",
    rule: "environment-harvest",
    pattern: new RegExp(
      String.raw`(os\.environ(?!\.get\(['"][A-Z_]+['"])\b|printenv|env\s*>\s*|process\.env(?!\.[A-Z_]+\b))`,
      "i",
    ),
  },
  {
    severity: "warn",
    rule: "shell-execution",
    pattern: new RegExp(
      String.raw`(subprocess\.(run|call|Popen|check_output)|os\.system|os\.popen|child_process|shell\s*=\s*True)`,
      "i",
    ),
  },
  {
    severity: "warn",
    rule: "shell-execution",
    // Backticks are command substitution in a shell and punctuation everywhere else. The
    // Python source treated them as suspicious in any code file, which fires on every
    // docstring that quotes a `field name` — and a warning that is usually wrong teaches
    // the reader to click past the one that is not.
    shellOnly: true,
    // Written with a plain string rather than String.raw because the pattern contains a
    // literal backtick, which would end a template literal.
    pattern: new RegExp("`[^`\\n]{4,}`"),
  },
  {
    severity: "warn",
    rule: "dynamic-code",
    pattern: new RegExp(String.raw`\b(eval|exec)\s*\(|importlib\.import_module\s*\(|__import__\s*\(`, "i"),
  },
  {
    severity: "warn",
    rule: "persistence-attempt",
    pattern: new RegExp(
      String.raw`(crontab|systemctl\s+enable|\.bashrc|\.profile|\.zshrc|LaunchAgents|autostart|` +
        String.raw`\.config/systemd|/etc/cron|at\s+now|schtasks|Startup)`,
      "i",
    ),
  },
  {
    severity: "warn",
    rule: "encode-then-send",
    pattern: new RegExp(
      String.raw`(base64|b64encode|hexlify|btoa)[^\n]{0,120}(requests\.|urllib|fetch\(|curl|wget|` +
        String.raw`httpx|socket|axios|nc\s)`,
      "i",
    ),
  },
  {
    severity: "warn",
    rule: "outbound-network",
    pattern: new RegExp(
      String.raw`(requests\.|urllib\.request|httpx\.|fetch\(|axios\.|curl\s+http|wget\s+http|` +
        String.raw`socket\.connect|WebSocket\()`,
      "i",
    ),
  },
];

/**
 * SKILL.md / instruction-injection patterns. Applied to every text file, not just code,
 * because the injection surface is prose (SKILL.md, comments, README) rather than syntax.
 * Ported verbatim from INSTRUCTION_RULES in skill_validator.py.
 */
const INSTRUCTION_RULES: Rule[] = [
  {
    severity: "critical",
    rule: "instruction-exfil",
    pattern: new RegExp(
      String.raw`(send|post|upload|forward|transmit)[^\n.]{0,80}(env|credential|token|secret|` +
        String.raw`api.?key|password|conversation|chat history|user data)`,
      "i",
    ),
  },
  {
    severity: "critical",
    rule: "instruction-concealment",
    pattern: new RegExp(
      String.raw`(do not (tell|inform|mention|reveal|show)[^\n.]{0,60}(user|human)|` +
        String.raw`without (telling|informing|asking)[^\n.]{0,40}(user|human)|hide this from)`,
      "i",
    ),
  },
  {
    severity: "critical",
    rule: "instruction-override",
    pattern: new RegExp(
      String.raw`(ignore (all |any |your )?(previous|prior|above|system) (instructions|rules|prompt)|` +
        String.raw`disregard[^\n.]{0,40}(instructions|guidelines|safety)|jailbreak)`,
      "i",
    ),
  },
  {
    severity: "warn",
    rule: "instruction-privilege",
    pattern: new RegExp(
      String.raw`(run (as|with) (root|sudo|admin)|disable (safety|security|sandbox|verification)|` +
        String.raw`--dangerously|--no-verify|--yolo)`,
      "i",
    ),
  },
  {
    severity: "warn",
    rule: "instruction-autoexec",
    pattern: new RegExp(
      String.raw`(always execute|run (this |the )?(script|command) (first|immediately|before)|` +
        String.raw`on (every|each) (start|message|turn))`,
      "i",
    ),
  },
];

const URL_PATTERN = new RegExp(String.raw`https?://([a-zA-Z0-9.-]+)`, "g");
const HIGH_ENTROPY_PATTERN = new RegExp(String.raw`[A-Za-z0-9+/=]{120,}`, "g");
const HTML_COMMENT_PATTERN = new RegExp(String.raw`<!--(.*?)-->`, "gs");

/** Matched on the registrable tail, so `www.anthropic.com` counts as `anthropic.com`. */
const KNOWN_OK_DOMAINS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "pypi.org",
  "docs.python.org",
  "www.imca-int.com",
  "anthropic.com",
]);

/** Shannon entropy of a string, in bits per character — high entropy is a proxy for "looks
 * like an encoded or compressed payload rather than words". */
function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const character of text) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/** A finding's evidence must be a pointer back into the file, not a copy of it. */
function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? collapsed.slice(0, 120) : collapsed;
}

function scanTextRules(relativePath: string, text: string, rules: readonly Rule[], findings: Finding[]): void {
  const isShell = SHELL_EXTENSIONS.has(path.extname(relativePath).toLowerCase()) || text.startsWith("#!");
  const lines = text.split(/\r\n|\r|\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber];
    for (const rule of rules) {
      if (rule.shellOnly && !isShell) continue;
      if (rule.pattern.test(line)) {
        findings.push({
          severity: rule.severity,
          rule: rule.rule,
          where: `${relativePath}:${lineNumber + 1}`,
          evidence: excerpt(line),
        });
      }
    }
  }
}

/**
 * Checks that do not fit the "rule matches a line" shape: outbound domains, obfuscated
 * blobs, and hidden markdown comments. Ported from scan_extras() in skill_validator.py.
 */
function scanExtras(relativePath: string, text: string, findings: Finding[]): void {
  for (const match of text.matchAll(URL_PATTERN)) {
    const domain = (match[1] ?? "").toLowerCase();
    const known = [...KNOWN_OK_DOMAINS].some((ok) => domain === ok || domain.endsWith(`.${ok}`));
    if (!known) {
      findings.push({ severity: "info", rule: "unknown-domain", where: relativePath, evidence: excerpt(domain) });
    }
  }

  const lines = text.split(/\r\n|\r|\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber];
    const tokens = line.match(HIGH_ENTROPY_PATTERN) ?? [];
    for (const token of tokens) {
      const entropy = shannonEntropy(token);
      if (entropy > 4.5) {
        findings.push({
          severity: "warn",
          rule: "high-entropy-blob",
          where: `${relativePath}:${lineNumber + 1}`,
          evidence: excerpt(`${token.length} chars, entropy ${entropy.toFixed(1)} -- possible encoded payload`),
        });
      }
    }
  }

  // Hidden instructions can ride along in a comment nobody renders. Markdown only, since
  // that is the format an agent reads as prose rather than as code with its own comment
  // conventions already covered by the instruction rules above.
  if (relativePath.toLowerCase().endsWith(".md")) {
    for (const match of text.matchAll(HTML_COMMENT_PATTERN)) {
      const body = (match[1] ?? "").trim();
      if (body.length > 40) {
        findings.push({ severity: "warn", rule: "hidden-md-comment", where: relativePath, evidence: excerpt(body) });
      }
    }
  }
}

class ScanTooLargeError extends Error {}

/**
 * Scan a directory that holds one skill (a SKILL.md plus whatever ships with it).
 *
 * Walks the directory recursively, skipping `.git` and never following symlinks. Returns
 * REJECT immediately, without a partial finding list, if the walk exceeds its size caps —
 * see the module comment for why a truncated scan must not be allowed to report INSTALL.
 */
export function scanSkill(dir: string): Verdict {
  const findings: Finding[] = [];
  const unprobedPaths: string[] = [];
  let filesScanned = 0;
  let totalFiles = 0;
  let totalBytes = 0;

  function processFile(fileAbsolutePath: string, relativePath: string, fileName: string, size: number): void {
    if (fileName.startsWith(".") && fileName !== ".gitignore") {
      findings.push({ severity: "warn", rule: "hidden-file", where: relativePath, evidence: excerpt(fileName) });
    }

    const extension = path.extname(fileName).toLowerCase();

    if (SHELL_EXTENSIONS.has(extension)) {
      unprobedPaths.push(relativePath);
    }

    if (BINARY_ALLOWLIST.has(extension)) {
      return; // known-binary format: nothing text-shaped to inspect
    }

    if (!TEXT_EXTENSIONS.has(extension)) {
      findings.push({
        severity: "warn",
        rule: "unexpected-binary",
        where: relativePath,
        evidence: excerpt(`extension '${extension || "(none)"}' is not on the text or binary allowlist`),
      });
      return;
    }

    if (size > MAX_SINGLE_FILE_BYTES) {
      findings.push({ severity: "warn", rule: "oversize-file", where: relativePath, evidence: `${size} bytes` });
      return;
    }

    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(fileAbsolutePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      findings.push({ severity: "info", rule: "unreadable", where: relativePath, evidence: excerpt(message) });
      return;
    }

    // A file with a text-looking extension whose actual content is binary (a NUL byte
    // in the first 8KB is a reliable-enough tell) is not something to pattern-match --
    // regexes over raw binary produce noise, not signal.
    const looksBinary = buffer.subarray(0, 8192).includes(0);

    // An extensionless file that starts with a shebang is a script by convention even
    // without an extension to say so, so it gets the same "cannot inspect" treatment as
    // a .sh file.
    if (extension === "" && buffer.length >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21) {
      unprobedPaths.push(relativePath);
    }

    if (looksBinary) {
      findings.push({
        severity: "warn",
        rule: "unexpected-binary",
        where: relativePath,
        evidence: "first 8KB contains a NUL byte -- binary content despite a text extension",
      });
      return;
    }

    const text = buffer.toString("utf8");
    filesScanned += 1;

    if (CODE_EXTENSIONS.has(extension)) {
      scanTextRules(relativePath, text, CODE_RULES, findings);
    }
    scanTextRules(relativePath, text, INSTRUCTION_RULES, findings);
    scanExtras(relativePath, text, findings);
  }

  function walk(currentAbsolutePath: string, currentRelativePath: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(currentAbsolutePath);
    } catch {
      return; // a directory that cannot even be listed has nothing to scan
    }

    for (const entryName of entries) {
      const entryAbsolutePath = path.join(currentAbsolutePath, entryName);
      const entryRelativePath = currentRelativePath ? `${currentRelativePath}/${entryName}` : entryName;

      let stats: fs.Stats;
      try {
        // lstat, not stat: a symlink must be recognised as one before it is ever
        // followed, so its target is never touched.
        stats = fs.lstatSync(entryAbsolutePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        findings.push({ severity: "info", rule: "unreadable", where: entryRelativePath, evidence: excerpt(message) });
        continue;
      }

      if (stats.isSymbolicLink()) {
        // A symlink can point anywhere on disk, including outside the directory being
        // scanned, so it is never followed -- only recorded.
        findings.push({
          severity: "warn",
          rule: "symlink",
          where: entryRelativePath,
          evidence: "symlink present -- not followed",
        });
        continue;
      }

      if (stats.isDirectory()) {
        if (entryName === ".git") continue;
        walk(entryAbsolutePath, entryRelativePath);
        continue;
      }

      if (!stats.isFile()) continue; // device, socket, fifo -- not a skill artefact

      totalFiles += 1;
      totalBytes += stats.size;
      if (totalFiles > MAX_TOTAL_FILES || totalBytes > MAX_TOTAL_BYTES) {
        throw new ScanTooLargeError(
          `walk exceeded cap at ${totalFiles} files / ${totalBytes} bytes (limits: ${MAX_TOTAL_FILES} files, ${MAX_TOTAL_BYTES} bytes)`,
        );
      }

      processFile(entryAbsolutePath, entryRelativePath, entryName, stats.size);
    }
  }

  try {
    walk(dir, "");
  } catch (error) {
    if (error instanceof ScanTooLargeError) {
      // Fail closed: a directory too large to finish walking is reported as REJECT with
      // no partial finding list, rather than silently scanning a truncated subset of it
      // and reporting whatever that subset happened to look like.
      return {
        outcome: "REJECT",
        why: "the skill directory exceeds the scan cap, so it was rejected rather than partially scanned.",
        findings: [{ severity: "critical", rule: "too-large", where: ".", evidence: excerpt(error.message) }],
        files: filesScanned,
        unprobed: [],
      };
    }
    throw error;
  }

  const { outcome, why } = route(findings, unprobedPaths);
  return { outcome, why, findings, files: filesScanned, unprobed: unprobedPaths };
}

/**
 * Outcome routing: verdict and blast radius, in that priority order.
 *
 *   REJECT  — hard evidence of exfiltration, injection, or download-and-execute
 *   REVIEW  — either a script this scanner cannot inspect, or a suspicious-but-
 *             explainable pattern; a human decides
 *   INSTALL — no findings at all
 *
 * Detection is not load-bearing here: a clean pattern match is "nothing recognised", not
 * "nothing present", so anything the scanner cannot actually read (an unprobed script)
 * is routed to REVIEW even when every pattern it did check came back clean.
 */
function route(findings: readonly Finding[], unprobedPaths: readonly string[]): { outcome: Outcome; why: string } {
  if (findings.some((finding) => finding.severity === "critical")) {
    return {
      outcome: "REJECT",
      why: "static analysis found hard evidence of exfiltration, injection, or download-and-execute.",
    };
  }
  if (unprobedPaths.length > 0) {
    return {
      outcome: "REVIEW",
      why: "a shell or binary script is present that this static scanner cannot reliably inspect.",
    };
  }
  if (findings.some((finding) => finding.severity === "warn")) {
    return {
      outcome: "REVIEW",
      why: "static analysis found suspicious-but-explainable patterns that need a human decision.",
    };
  }
  return { outcome: "INSTALL", why: "no suspicious pattern was found in a full static scan." };
}
