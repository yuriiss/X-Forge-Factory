import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import { forgeHome, stateFile } from "./paths";
import { logger } from "./logger";

/**
 * X-Forge's client for Magnific's MCP server.
 *
 * Two protocols meet here.
 *
 *   OAuth 2.1 — discovery → dynamic client registration (RFC 7591) → authorization code
 *   with PKCE S256 → refresh. A public client with no secret, because the console runs on
 *   the operator's own machine and pretending otherwise would just mean a secret sitting
 *   in a file next to the code that reads it. `offline_access` is requested so a session
 *   survives longer than an hour.
 *
 *   MCP over streamable HTTP — `initialize`, then `tools/list` and `tools/call` as plain
 *   JSON-RPC POSTs. The session id arrives in a header and has to ride along afterwards,
 *   and a server may answer either JSON or an SSE frame for the very same request, so the
 *   framing is decided by the CONTENT TYPE and never by sniffing the body: `tools/list`
 *   descriptions themselves mention `data:` URLs, and a body-sniffing client parses the
 *   entire 88-tool catalogue as `{}`.
 */

export const MAGNIFIC_MCP = "https://mcp.magnific.com";

export interface McpAuthState {
  server: string;
  clientId?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  scope?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  pendingVerifier?: string;
  pendingState?: string;
  sessionId?: string;
  connectedAt?: number;
}

const STORE = () => {
  forgeHome();
  return stateFile("mcp.json");
};

function readAll(): Record<string, McpAuthState> {
  try {
    return JSON.parse(readFileSync(STORE(), "utf8")) as Record<string, McpAuthState>;
  } catch {
    return {};
  }
}

export function readAuth(server = MAGNIFIC_MCP): McpAuthState {
  const all = readAll();
  if (all[server]) return all[server];
  const imported = importExistingSession(server);
  if (imported) return imported;
  return { server };
}

export function writeAuth(state: McpAuthState): void {
  const all = readAll();
  all[state.server] = state;
  writeFileSync(STORE(), JSON.stringify(all, null, 2), "utf8");
}

/**
 * Adopt an OAuth session another local tool already completed.
 *
 * Opt-in, via `FORGE_MCP_IMPORT` — a colon-separated list of `mcp.json` files written by
 * another MCP client on this machine. When the operator has already authorised this exact
 * server from this exact machine, reusing that refresh token means the console is connected
 * on first boot instead of opening a browser to ask the same question again.
 *
 * It is off by default and never guesses at paths: silently reading another program's
 * token store because it happened to be in a familiar location is not a thing software
 * should do to someone who just installed it.
 */
function importExistingSession(server: string): McpAuthState | null {
  const configured = (process.env.FORGE_MCP_IMPORT || "").trim();
  if (!configured) return null;

  const candidates = configured
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p));

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, McpAuthState>;
      const s = all[server];
      if (!s?.refreshToken && !s?.accessToken) continue;
      const adopted: McpAuthState = { ...s, server, sessionId: undefined, connectedAt: Date.now() };
      mkdirSync(path.dirname(STORE()), { recursive: true });
      writeAuth(adopted);
      logger.info("mcp", `adopted existing OAuth session for ${server}`);
      return adopted;
    } catch {
      /* unreadable store — fall through to a fresh authorization */
    }
  }
  return null;
}

export function disconnect(server = MAGNIFIC_MCP): void {
  const all = readAll();
  delete all[server];
  writeFileSync(STORE(), JSON.stringify(all, null, 2), "utf8");
  logger.info("mcp", `disconnected ${server}`);
}

/* ----------------------------------------------------------------- OAuth -- */

interface AsMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

/** Ask the server who guards it — the protected-resource document names its issuer. */
export async function discover(server = MAGNIFIC_MCP): Promise<AsMetadata> {
  const direct = await fetch(`${server}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(15_000) })
    .then((r) => (r.ok ? (r.json() as Promise<AsMetadata>) : null))
    .catch(() => null);
  if (direct?.token_endpoint) return direct;

  const res = await fetch(`${server}/.well-known/oauth-protected-resource`, { signal: AbortSignal.timeout(15_000) });
  const meta = (await res.json()) as { authorization_servers?: string[] };
  const as = meta.authorization_servers?.[0];
  if (!as) throw new Error("MCP server did not say which authorization server guards it");
  const r2 = await fetch(`${as}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
  return (await r2.json()) as AsMetadata;
}

async function register(meta: AsMetadata, redirectUri: string): Promise<string> {
  if (!meta.registration_endpoint) throw new Error("this authorization server has no dynamic registration");
  const res = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "X-Forge",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { client_id?: string; error_description?: string };
  if (!json.client_id) throw new Error(`client registration failed: ${json.error_description ?? res.status}`);
  return json.client_id;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function beginAuth(server: string, redirectUri: string): Promise<{ url: string }> {
  const meta = await discover(server);
  const state = readAuth(server);
  const clientId = state.clientId ?? (await register(meta, redirectUri));

  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const csrf = b64url(randomBytes(16));
  const scope = "openid profile email offline_access mcp:custom-audience";

  writeAuth({
    ...state,
    server,
    clientId,
    issuer: meta.issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
    scope,
    pendingVerifier: verifier,
    pendingState: csrf,
  });

  const u = new URL(meta.authorization_endpoint!);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scope);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", csrf);
  return { url: u.toString() };
}

export async function completeAuth(server: string, code: string, csrf: string, redirectUri: string): Promise<void> {
  const state = readAuth(server);
  if (!state.pendingVerifier) throw new Error("no authorization in progress");
  if (state.pendingState && csrf && state.pendingState !== csrf) throw new Error("state mismatch — start again");

  const res = await fetch(state.tokenEndpoint!, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: state.clientId!,
      code,
      redirect_uri: redirectUri,
      code_verifier: state.pendingVerifier,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!json.access_token) throw new Error(`token exchange failed: ${json.error_description ?? json.error ?? res.status}`);

  writeAuth({
    ...state,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 300) * 1000,
    pendingVerifier: undefined,
    pendingState: undefined,
    connectedAt: Date.now(),
  });
  logger.info("mcp", "OAuth session established");
}

async function freshToken(server: string): Promise<string> {
  const state = readAuth(server);
  if (!state.accessToken && !state.refreshToken) throw new Error("MCP not connected — authorize X-Forge with Magnific first");
  if (state.accessToken && state.expiresAt && Date.now() < state.expiresAt - 60_000) return state.accessToken;
  if (!state.refreshToken) return state.accessToken!;

  const res = await fetch(state.tokenEndpoint!, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: state.clientId!,
      refresh_token: state.refreshToken,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("MCP session expired — authorize again");
  writeAuth({
    ...state,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? state.refreshToken,
    expiresAt: Date.now() + (json.expires_in ?? 300) * 1000,
  });
  return json.access_token;
}

/* ------------------------------------------------------------------- MCP -- */

interface RpcResult<T> {
  result?: T;
  error?: { code: number; message: string };
}

async function rpc<T>(server: string, method: string, params: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  const token = await freshToken(server);
  const state = readAuth(server);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (state.sessionId) headers["Mcp-Session-Id"] = state.sessionId;

  const res = await fetch(server, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
  });

  const sid = res.headers.get("mcp-session-id");
  if (sid && sid !== state.sessionId) writeAuth({ ...readAuth(server), sessionId: sid });

  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status} ${text.slice(0, 200)}`);

  const isSse = (res.headers.get("content-type") || "").includes("text/event-stream");
  const raw = isSse
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop() ?? "{}"
    : text || "{}";
  const json = JSON.parse(raw) as RpcResult<T>;
  if (json.error) throw new Error(`MCP ${method}: ${json.error.message}`);
  return json.result as T;
}

async function notify(server: string, method: string, params?: unknown): Promise<void> {
  const token = await freshToken(server);
  const state = readAuth(server);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (state.sessionId) headers["Mcp-Session-Id"] = state.sessionId;
  await fetch(server, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
}

export interface ServerInfo {
  serverInfo?: { name?: string; version?: string };
  protocolVersion?: string;
}

export async function initialize(server = MAGNIFIC_MCP): Promise<ServerInfo> {
  const result = await rpc<ServerInfo>(server, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "X-Forge", version: "1.0" },
  });
  // A notification carries no id. Sent as a request it answers "method not found".
  await notify(server, "notifications/initialized");
  return result;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

export async function listTools(server = MAGNIFIC_MCP): Promise<McpTool[]> {
  const r = await rpc<{ tools?: McpTool[] }>(server, "tools/list", {});
  return r.tools ?? [];
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string };
}

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number; server?: string } = {},
): Promise<McpCallResult> {
  const server = opts.server ?? MAGNIFIC_MCP;
  const started = Date.now();
  try {
    const r = await rpc<McpCallResult>(server, "tools/call", { name, arguments: args }, { timeoutMs: opts.timeoutMs });
    logger.info("mcp", `${name} ok in ${Date.now() - started}ms`);
    return r;
  } catch (e) {
    logger.warn("mcp", `${name} failed: ${(e as Error).message}`);
    throw e;
  }
}

export function isConnected(server = MAGNIFIC_MCP): boolean {
  const s = readAuth(server);
  return !!(s.accessToken || s.refreshToken);
}

/** Text content of a tool result, joined — several tools answer in prose, not JSON. */
export function textOf(r: McpCallResult): string {
  return r.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") ?? "";
}

/**
 * A tool result as data.
 *
 * `structuredContent` when the server sends it; otherwise the text block, which is
 * sometimes JSON and sometimes an outline. Callers get whichever shape exists rather than
 * a guess dressed up as a type.
 */
export function dataOf(r: McpCallResult): unknown {
  if (r.structuredContent !== undefined) return r.structuredContent;
  const t = textOf(r);
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/* ------------------------------------------------------- outline parsing -- */

/**
 * Several list tools answer in an indented outline, not JSON, and send no
 * `structuredContent` — so the outline IS the payload.
 *
 * Records open with `- key: value`; their fields sit one level deeper, and a field may be
 * a counted list (`aspectRatios[10]: "1:1","16:9",…`). Anything nested deeper than a
 * record's own fields is skipped on purpose: modelling it would mean inventing structure
 * this console does not render.
 */
export function parseOutline(text: string, idKey: string): Record<string, string | string[]>[] {
  const out: Record<string, string | string[]>[] = [];
  let cur: Record<string, string | string[]> | null = null;
  let recordIndent = 0;

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    const opener = line.match(/^-\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (opener) {
      if (cur) out.push(cur);
      cur = { [opener[1]]: unquote(opener[2]) };
      recordIndent = indent;
      continue;
    }
    if (!cur) continue;
    if (indent > recordIndent + 4) continue;

    const field = line.match(/^([A-Za-z0-9_]+)(\[\d+\])?:\s*(.*)$/);
    if (!field) continue;
    const [, key, counted, value] = field;
    if (!value) continue;
    cur[key] = counted ? splitList(value) : unquote(value);
  }
  if (cur) out.push(cur);
  return out.filter((r) => typeof r[idKey] === "string" && r[idKey]);
}

function unquote(v: string): string {
  return v.trim().replace(/^"(.*)"$/, "$1").trim();
}

function splitList(v: string): string[] {
  return v.split(",").map((x) => unquote(x)).filter(Boolean);
}

/* ------------------------------------------------------------- helpers -- */

export interface CostEstimate {
  credits: number;
  certainty?: string;
  reason?: string;
  isUnlimited?: boolean;
  range?: { min?: number; max?: number };
}

/**
 * What a call will cost, from the provider rather than from a table we maintain.
 *
 * `simulate_cost` is read-only and never charges, which makes it the honest input to the
 * budget check: the engine reserves what Magnific says the job costs, not what a price
 * list in this repository claimed last month. `certainty: "variable"` is passed through
 * untouched — a range is information, and rounding it to a single number would be the
 * engine pretending to know something it does not.
 */
export async function simulateCost(tool: string, args: Record<string, unknown>): Promise<CostEstimate | null> {
  try {
    const r = await callTool("simulate_cost", { tool, arguments: args }, { timeoutMs: 45_000 });
    const d = dataOf(r) as CostEstimate | string;
    if (typeof d === "object" && d && typeof d.credits === "number") return d;
    return null;
  } catch {
    return null;
  }
}

export interface CreationRef {
  identifier: string;
  url?: string;
  status?: string;
  mimeType?: string;
}

/**
 * Pull creation identifiers out of whatever shape a generation tool answered with.
 *
 * The tools are not consistent — some return `structuredContent.items[]`, some a bare
 * `identifier`, some only prose containing them — and a generation that produced files we
 * cannot name is a generation the operator paid for and cannot see. So every shape is
 * tried, ending with a scan of the text for the 10-character identifier form.
 */
export function extractIdentifiers(r: McpCallResult): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of ["identifier", "creationIdentifier", "id"]) {
        const val = o[k];
        if (typeof val === "string" && /^[A-Za-z0-9_-]{8,24}$/.test(val)) found.add(val);
      }
      return Object.values(o).forEach(walk);
    }
  };
  walk(r.structuredContent);
  if (!found.size) {
    const text = textOf(r);
    for (const m of text.matchAll(/identifier:\s*"?([A-Za-z0-9_-]{8,24})"?/g)) found.add(m[1]);
  }
  return [...found];
}

/** Direct asset URLs, when a tool hands them over without a creation round-trip. */
export function extractUrls(r: McpCallResult): string[] {
  const urls = new Set<string>();
  const walk = (v: unknown): void => {
    if (!v) return;
    if (typeof v === "string") {
      if (/^https?:\/\/\S+\.(png|jpe?g|webp|gif|svg|mp4|webm|mov|mp3|wav|ogg|glb|gltf|usdz)(\?\S*)?$/i.test(v)) urls.add(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      // `webUrl` is a page for a human, not an asset — following it downloads HTML.
      for (const [k, val] of Object.entries(o)) {
        if (k === "webUrl") continue;
        walk(val);
      }
    }
  };
  walk(r.structuredContent);
  const text = textOf(r);
  for (const m of text.matchAll(/https?:\/\/[^\s"']+\.(?:png|jpe?g|webp|gif|svg|mp4|webm|mov|mp3|wav|ogg|glb|gltf|usdz)(?:\?[^\s"']*)?/gi)) {
    urls.add(m[0]);
  }
  return [...urls];
}

/**
 * Wait for creations to finish and return their asset URLs.
 *
 * `creations_wait` takes up to 8 identifiers per call, so bigger batches are chunked. The
 * URL it returns is the file; `webUrl` is the gallery page and is deliberately ignored.
 */
export async function waitForCreations(identifiers: string[], opts: { timeoutMs?: number } = {}): Promise<CreationRef[]> {
  const out: CreationRef[] = [];
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);

  for (let i = 0; i < identifiers.length; i += 8) {
    const batch = identifiers.slice(i, i + 8);
    for (;;) {
      const r = await callTool("creations_wait", { identifiers: batch }, { timeoutMs: 300_000 });
      const urls = extractUrls(r);
      const done = urls.length >= batch.length || Date.now() > deadline;
      if (done) {
        batch.forEach((id, n) => out.push({ identifier: id, url: urls[n] ?? urls[0] }));
        break;
      }
      // Not finished and not timed out: give the render a moment rather than hammering.
      await new Promise((res) => setTimeout(res, 5_000));
      if (Date.now() > deadline) {
        batch.forEach((id) => out.push({ identifier: id, status: "timeout" }));
        break;
      }
    }
  }
  return out;
}

/**
 * Turn local bytes into a creation the MCP tools can act on.
 *
 * The image tools take a `creationIdentifier`, never a file — so an operator's own picture
 * has to become a creation first. Three steps, exactly as the server describes them:
 * ask for a presigned target, PUT the raw bytes to it (no MCP call carries the body, and
 * no API key goes to the storage host), then finalize the returned `path`.
 *
 * A failed PUT is never retried against the same target: re-PUTs of one presigned URL are
 * rate-limited, so a retry has to start from a fresh target or not at all.
 */
export async function importFileAsCreation(bytes: Buffer, mimeType: string, opts: { visible?: boolean } = {}): Promise<string> {
  const req = await callTool("creations_request_upload", { mimeType }, { timeoutMs: 45_000 });
  const d = dataOf(req) as { proxyUploadUrl?: string; path?: string };
  if (!d?.proxyUploadUrl || !d?.path) throw new Error("MCP upload: no presigned target returned");

  const put = await fetch(d.proxyUploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(300_000),
  });
  if (!put.ok) throw new Error(`MCP upload: PUT failed HTTP ${put.status}`);

  const fin = await callTool("creations_finalize_upload", { path: d.path, visible: opts.visible ?? false }, { timeoutMs: 90_000 });
  const id = extractIdentifiers(fin)[0];
  if (!id) throw new Error("MCP upload: finalize returned no creation identifier");
  logger.info("mcp", `imported ${bytes.length}B ${mimeType} as creation ${id}`);
  return id;
}

/** A public URL becomes a creation in one step. */
export async function importUrlAsCreation(url: string): Promise<string> {
  const r = await callTool("creations_upload_image", { url }, { timeoutMs: 90_000 });
  const id = extractIdentifiers(r)[0];
  if (!id) throw new Error("MCP import: no creation identifier returned");
  return id;
}

export async function creationUrl(identifier: string): Promise<string | null> {
  const r = await callTool("creations_get", { identifier }, { timeoutMs: 60_000 });
  return extractUrls(r)[0] ?? null;
}
