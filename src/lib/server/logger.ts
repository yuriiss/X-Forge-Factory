/**
 * The logger, with redaction built in rather than promised.
 *
 * Spec §2.2/4 asks for central redaction — "a filter at the logger level matching the key
 * format, not «we are careful not to log it»" — and for a test that logs a key ON PURPOSE
 * and proves the output is redacted. That is why every line goes through `redact()` here
 * instead of every caller being trusted: a single `console.log(body)` at a call site is
 * all it takes to leak a key, and there is no way to review that away forever.
 */

/** Anything that looks like a Magnific key, a bearer token or a signing secret. */
const PATTERNS: RegExp[] = [
  /\bFPSX[A-Za-z0-9]{16,}\b/g, // Magnific/Freepik key format
  /\bmagnific-[A-Za-z0-9_-]{8,}\b/gi,
  /\bwhsec_[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:Bearer|bearer)\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g,
  // JWT. The segment lengths are deliberately generous: a filter that under-matches is
  // worse than one that redacts something harmless, because the failure mode is a token
  // in a log file rather than a slightly noisy message.
  /\bey[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  /"x-magnific-api-key"\s*:\s*"[^"]+"/gi,
];

export function redact(value: unknown): string {
  let text = typeof value === "string" ? value : safeStringify(value);
  for (const re of PATTERNS) text = text.replace(re, "[REDACTED]");
  // Whatever the live key is, it is redacted by value too — formats change, this does not.
  const key = (process.env.MAGNIFIC_API_KEY || "").trim();
  if (key.length >= 8) text = text.split(key).join("[REDACTED]");
  const secret = (process.env.MAGNIFIC_WEBHOOK_SECRET || "").trim();
  if (secret.length >= 8) text = text.split(secret).join("[REDACTED]");
  return text;
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLine {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
}

/** A short ring buffer so the console's Activity panel shows what the server did. */
const RING: LogLine[] = [];
const RING_MAX = 500;

export function log(level: LogLevel, scope: string, ...parts: unknown[]): void {
  const message = parts.map(redact).join(" ");
  const line: LogLine = { at: new Date().toISOString(), level, scope, message };
  RING.push(line);
  if (RING.length > RING_MAX) RING.splice(0, RING.length - RING_MAX);
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(`[x-forge:${scope}] ${message}`);
}

export const logger = {
  debug: (scope: string, ...p: unknown[]) => log("debug", scope, ...p),
  info: (scope: string, ...p: unknown[]) => log("info", scope, ...p),
  warn: (scope: string, ...p: unknown[]) => log("warn", scope, ...p),
  error: (scope: string, ...p: unknown[]) => log("error", scope, ...p),
};

export function recentLogs(limit = 80): LogLine[] {
  return RING.slice(-limit).reverse();
}
