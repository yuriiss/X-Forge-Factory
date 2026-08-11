import { handle } from "@/lib/server/http";
import { beginAuth, MAGNIFIC_MCP } from "@/lib/server/mcp";

export const dynamic = "force-dynamic";

/**
 * Start the OAuth dance and hand back the URL to open.
 *
 * The redirect must match what was registered, so it is derived from the request's own
 * origin rather than from configuration that can drift out of sync with the port the
 * console is actually served on.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const origin = new URL(req.url).origin;
    const redirectUri = `${origin}/api/mcp/callback`;
    const { url } = await beginAuth(MAGNIFIC_MCP, redirectUri);
    return { url, redirectUri };
  });
}
