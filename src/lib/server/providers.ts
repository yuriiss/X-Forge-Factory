import { getEnv, listEnv, setEnv, clearEnv } from "./envfile";

/**
 * Providers — endpoints that speak the OpenAI chat shape, reached with one key each.
 *
 * Three are known by name because their base URLs and auth headers are facts worth
 * shipping rather than making an operator look up. Anything else is added by hand: an id, a
 * base URL and a key, written to `.env.local` under a predictable prefix. That prefix is
 * what makes a custom provider survive a restart without a database — the file is the
 * registry.
 */

export type Auth = "bearer" | "x-api-key";

export interface Provider {
  id: string;
  label: string;
  base: string;
  keyEnv: string;
  auth: Auth;
  builtin: boolean;
  configured: boolean;
}

const BUILTIN: Omit<Provider, "configured">[] = [
  { id: "openrouter", label: "OpenRouter", base: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", auth: "bearer", builtin: true },
  { id: "tokenrouter", label: "TokenRouter", base: "https://api.tokenrouter.com/v1", keyEnv: "TOKENROUTER_API_KEY", auth: "bearer", builtin: true },
  { id: "freeinference", label: "FreeInference", base: "https://freeinference.org/v1", keyEnv: "FREEINFERENCE_API_KEY", auth: "x-api-key", builtin: true },
];

const PREFIX = "FORGE_PROVIDER_";

function envId(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function providers(): Provider[] {
  const list: Provider[] = BUILTIN.map((p) => ({
    ...p,
    base: getEnv(`${PREFIX}${envId(p.id)}_URL`) ?? p.base,
    configured: !!getEnv(p.keyEnv),
  }));

  // A custom provider exists because its URL variable exists; the key may still be missing,
  // and it is more useful to list it as unconfigured than to hide it.
  for (const entry of listEnv([PREFIX])) {
    const match = entry.name.match(new RegExp(`^${PREFIX}([A-Z0-9_]+)_URL$`));
    if (!match) continue;
    const slug = match[1];
    const id = slug.toLowerCase().replace(/_/g, "-");
    if (list.some((p) => envId(p.id) === slug)) continue;
    list.push({
      id,
      label: getEnv(`${PREFIX}${slug}_LABEL`) ?? id,
      base: entry.value,
      keyEnv: `${PREFIX}${slug}_KEY`,
      auth: (getEnv(`${PREFIX}${slug}_AUTH`) as Auth) ?? "bearer",
      builtin: false,
      configured: !!getEnv(`${PREFIX}${slug}_KEY`),
    });
  }
  return list;
}

export function provider(id: string): Provider | undefined {
  return providers().find((p) => p.id === id);
}

export function addProvider(input: { id: string; label?: string; base: string; auth?: Auth; key?: string }): Provider {
  const slug = envId(input.id);
  if (!slug || !/^[A-Z0-9_]+$/.test(slug)) throw new Error("id must be letters, digits or dashes");
  if (!/^https?:\/\//.test(input.base)) throw new Error("base URL must start with http:// or https://");

  setEnv(`${PREFIX}${slug}_URL`, input.base.replace(/\/+$/, ""));
  if (input.label) setEnv(`${PREFIX}${slug}_LABEL`, input.label);
  if (input.auth) setEnv(`${PREFIX}${slug}_AUTH`, input.auth);
  if (input.key) setEnv(`${PREFIX}${slug}_KEY`, input.key);

  const made = provider(input.id.toLowerCase().replace(/_/g, "-"));
  if (!made) throw new Error("provider did not register");
  return made;
}

export function removeProvider(id: string): void {
  const found = provider(id);
  if (!found) return;
  if (found.builtin) {
    clearEnv(found.keyEnv);
    return;
  }
  const slug = envId(id);
  for (const suffix of ["URL", "LABEL", "AUTH", "KEY"]) clearEnv(`${PREFIX}${slug}_${suffix}`);
}

function headers(p: Provider, key: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(p.auth === "bearer" ? { Authorization: `Bearer ${key}` } : { "X-API-Key": key }),
  };
}

export interface ProviderModel {
  id: string;
  label: string;
}

export async function catalogue(id: string): Promise<ProviderModel[]> {
  const p = provider(id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  const key = getEnv(p.keyEnv);
  if (!key) throw new Error(`${p.label} has no key — add one in Developers`);

  const res = await fetch(`${p.base}/models`, { headers: headers(p, key), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${p.label} answered ${res.status}`);

  const json = (await res.json()) as { data?: { id?: string; name?: string }[] };
  return (json.data ?? [])
    .filter((m): m is { id: string; name?: string } => typeof m.id === "string")
    .map((m) => ({ id: m.id, label: m.name ?? m.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The multipart form a chat message takes once it carries an image as well as text. */
export type ChatContent = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

/**
 * One provider turn, as a stream of text deltas.
 *
 * The provider's own SSE frames are parsed here rather than passed through, because unlike
 * the CLIs — where each dialect is genuinely different — every one of these speaks the same
 * shape, and a caller should not have to know which aggregator answered.
 */
export async function* providerChat(id: string, model: string, messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
  const p = provider(id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  const key = getEnv(p.keyEnv);
  if (!key) throw new Error(`${p.label} has no key — add one in Developers`);

  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    headers: headers(p, key),
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${p.label} answered ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return;
        try {
          const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          const text = parsed.choices?.[0]?.delta?.content;
          if (text) yield text;
        } catch {
          /* a partial frame is not an error, only an incomplete one */
        }
      }
    }
  }
}
