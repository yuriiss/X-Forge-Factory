import { handle, q } from "@/lib/server/http";
import { catalog } from "@/lib/server/catalog";
import { CAPABILITIES } from "@/lib/server/magnific";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const cat = await catalog({ refresh: q(req, "refresh") === "1" });
    return { ...cat, capabilities: CAPABILITIES };
  });
}
