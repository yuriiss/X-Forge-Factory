import { handle } from "@/lib/server/http";
import { disconnect } from "@/lib/server/mcp";

export const dynamic = "force-dynamic";

export async function POST() {
  return handle(async () => {
    disconnect();
    return { connected: false };
  });
}
