import { clearEnv, listEnv, setEnv } from "@/lib/server/envfile";
import { addProvider, catalogue, providers, removeProvider } from "@/lib/server/providers";

export const dynamic = "force-dynamic";

/**
 * Provider keys, and the file they live in.
 *
 * A key never comes back out of here: the listing is masked to its last four characters,
 * which is enough to tell two keys apart and not enough to spend one. Nothing is verified
 * against the provider before it is written — a wrong key is a failed call a moment later,
 * with the provider's own words, and a verification round-trip on save would only move the
 * same error earlier while costing a request every time somebody fixes a typo.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const models = url.searchParams.get("models");

  if (models) {
    try {
      return Response.json({ models: await catalogue(models) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 502 });
    }
  }

  return Response.json({
    providers: providers(),
    /* Model CLIs read their own keys from the environment, so the file holds more than
       providers do; showing all of it is the point of a keys panel. */
    variables: listEnv(),
    file: process.env.FORGE_ENV_FILE || ".env.local",
  });
}

interface Body {
  action: "set" | "clear" | "add-provider" | "remove-provider";
  name?: string;
  value?: string;
  id?: string;
  label?: string;
  base?: string;
  auth?: "bearer" | "x-api-key";
  key?: string;
}

export async function POST(req: Request) {
  const body = (await req.json()) as Body;

  try {
    switch (body.action) {
      case "set": {
        if (!body.name || !body.value?.trim()) return Response.json({ error: "name and value required" }, { status: 400 });
        setEnv(body.name, body.value);
        return Response.json({ ok: true });
      }
      case "clear": {
        if (!body.name) return Response.json({ error: "name required" }, { status: 400 });
        clearEnv(body.name);
        return Response.json({ ok: true });
      }
      case "add-provider": {
        if (!body.id || !body.base) return Response.json({ error: "id and base required" }, { status: 400 });
        return Response.json({ ok: true, provider: addProvider({ id: body.id, label: body.label, base: body.base, auth: body.auth, key: body.key }) });
      }
      case "remove-provider": {
        if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
        removeProvider(body.id);
        return Response.json({ ok: true });
      }
      default:
        return Response.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
