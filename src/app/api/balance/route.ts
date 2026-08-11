import { handle } from "@/lib/server/http";
import { lastBalance, openReservationTotal } from "@/lib/server/repo";
import { refreshBalance } from "@/lib/server/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async (ctx) => {
    const b = lastBalance(ctx);
    return { balance: b, reserved: openReservationTotal(ctx) };
  });
}

/** An explicit refresh — the button, as opposed to the dashboard's own cadence. */
export async function POST() {
  return handle(async (ctx) => {
    const b = await refreshBalance(ctx);
    if (!b) throw new Error("balance is only available over MCP — connect the MCP session first");
    return { balance: b, reserved: openReservationTotal(ctx) };
  });
}
