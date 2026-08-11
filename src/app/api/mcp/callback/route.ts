import { boot } from "@/lib/server/http";
import { completeAuth, MAGNIFIC_MCP } from "@/lib/server/mcp";
import { logger } from "@/lib/server/logger";

export const dynamic = "force-dynamic";

/**
 * Where the authorization server sends the operator back.
 *
 * The answer is a tiny HTML page rather than JSON: this URL is opened in a browser tab by
 * a human, and a raw JSON body is a confusing end to a login. The page closes itself when
 * it was opened as a popup and otherwise offers a link back to the console.
 */
export async function GET(req: Request) {
  boot();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const error = url.searchParams.get("error");
  const redirectUri = `${url.origin}/api/mcp/callback`;

  if (error) return page(false, `Authorization was refused: ${error}`);
  if (!code) return page(false, "No authorization code came back.");

  try {
    await completeAuth(MAGNIFIC_MCP, code, state, redirectUri);
    return page(true, "MCP session established. You can close this tab.");
  } catch (e) {
    logger.error("mcp", `callback: ${(e as Error).message}`);
    return page(false, (e as Error).message);
  }
}

function page(ok: boolean, message: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>X-FORGE · MCP</title>
<style>
 body{margin:0;background:#0a0e18;color:#e8edf5;font:13px "JetBrains Mono",monospace;display:grid;place-items:center;height:100vh}
 .card{border:1px solid ${ok ? "rgba(74,222,128,.4)" : "rgba(244,113,116,.45)"};border-radius:10px;background:#0f1626;padding:26px 30px;max-width:460px;text-align:center}
 h1{font-size:14px;letter-spacing:2px;margin:0 0 10px}
 p{color:#8fa0bd;line-height:1.7;margin:0 0 16px}
 a{color:#e8b64c;text-decoration:none}
</style>
<div class="card">
  <h1>${ok ? "◆ CONNECTED" : "✕ NOT CONNECTED"}</h1>
  <p>${escapeHtml(message)}</p>
  <a href="/">← back to X-Forge</a>
</div>
<script>if (window.opener) { window.opener.postMessage({ source: "x-forge-mcp", ok: ${ok} }, "*"); setTimeout(() => window.close(), 1200); }</script>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
