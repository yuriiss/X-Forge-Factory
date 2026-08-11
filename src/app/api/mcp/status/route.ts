import { handle } from "@/lib/server/http";
import { initialize, isConnected, readAuth } from "@/lib/server/mcp";

export const dynamic = "force-dynamic";

/**
 * Whether the MCP session is real.
 *
 * "Connected" is proven by handshaking, not by the presence of a token in a file — an
 * expired refresh token looks exactly like a working one until something is called.
 */
export async function GET() {
  return handle(async () => {
    const state = readAuth();
    if (!isConnected()) {
      return { connected: false, server: state.server, reason: "no session — authorize X-Forge with Magnific" };
    }
    try {
      const info = await initialize();
      return {
        connected: true,
        server: state.server,
        serverInfo: info.serverInfo ?? null,
        protocol: "2025-06-18 · streamable HTTP",
        issuer: state.issuer ?? null,
        scope: state.scope ?? null,
        expiresAt: state.expiresAt ?? null,
        sessionId: state.sessionId ? `${state.sessionId.slice(0, 8)}…` : null,
      };
    } catch (e) {
      return { connected: false, server: state.server, reason: (e as Error).message };
    }
  });
}
