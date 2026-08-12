import { getChoice, setChoice, type ChatChoice } from "@/lib/server/chatSettings";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ choice: getChoice() });
}

export async function POST(req: Request) {
  const body = (await req.json()) as ChatChoice;
  try {
    return Response.json({ choice: setChoice({ id: body.id, provider: !!body.provider, model: body.model }) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
