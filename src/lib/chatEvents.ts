/**
 * Reading what a model CLI prints.
 *
 * Every CLI streams JSON lines and every one of them streams a different JSON line. Rather
 * than pretend they agree, each dialect gets its own branch here and produces one small set
 * of events the console can render. Anything unrecognised is dropped rather than guessed
 * at: a console that invents a message from a line it did not understand is worse than one
 * that stays quiet, because the invented text looks exactly like something the model said.
 */

export type ChatEvent =
  | { kind: "session"; id: string; model?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id?: string; name: string; input?: string }
  | { kind: "tool-done"; id?: string }
  | { kind: "result"; costUsd?: number; durationMs?: number; inputTokens?: number; outputTokens?: number; failed?: boolean }
  | { kind: "error"; message: string }
  | { kind: "exit"; code: number | null };

type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const obj = (v: unknown): Raw | undefined => (v && typeof v === "object" ? (v as Raw) : undefined);

/** JSON of a tool's arguments, short enough to sit on one line in a chip. */
function preview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  } catch {
    return undefined;
  }
}

export function readEvent(dialect: string, raw: Raw): ChatEvent[] {
  const type = str(raw.type);

  // The three frames the server adds itself, identical whichever CLI ran.
  if (type === "proc_error") return [{ kind: "error", message: `${str(raw.message) ?? "the process failed to start"}` }];
  if (type === "proc_exit") return [{ kind: "exit", code: num(raw.code) ?? null }];
  if (type === "stderr") {
    const line = str(raw.line) ?? "";
    return line.trim() ? [{ kind: "error", message: line }] : [];
  }
  // A provider turn, and any CLI line that was not JSON at all.
  if (type === "delta") return [{ kind: "text", text: str(raw.text) ?? "" }];
  if (type === "text") return [{ kind: "text", text: `${str(raw.line) ?? ""}\n` }];

  switch (dialect) {
    case "claude":
      return claude(raw, type);
    case "grok":
      return grok(raw, type);
    case "codex":
      return codex(raw, type);
    case "qwen":
      return claude(raw, type);
    default:
      return [];
  }
}

/** Claude Code and Kimi: `stream-json`, an envelope around the Anthropic event shape. */
function claude(raw: Raw, type: string | undefined): ChatEvent[] {
  if (type === "system" && str(raw.subtype) === "init") {
    const id = str(raw.session_id);
    return id ? [{ kind: "session", id, model: str(raw.model) }] : [];
  }

  if (type === "stream_event") {
    const event = obj(raw.event);
    const inner = str(event?.type);
    if (inner === "content_block_delta") {
      const delta = obj(event?.delta);
      if (str(delta?.type) === "text_delta") return [{ kind: "text", text: str(delta?.text) ?? "" }];
      return [];
    }
    if (inner === "content_block_start") {
      const block = obj(event?.content_block);
      if (str(block?.type) === "tool_use") {
        return [{ kind: "tool", id: str(block?.id), name: str(block?.name) ?? "tool" }];
      }
    }
    return [];
  }

  // The complete message arrives after the deltas and carries the tool arguments, which the
  // deltas do not: the chip is created empty and filled in here.
  if (type === "assistant") {
    const message = obj(raw.message);
    const content = Array.isArray(message?.content) ? (message?.content as Raw[]) : [];
    const out: ChatEvent[] = [];
    for (const block of content) {
      if (str(block.type) === "tool_use") {
        out.push({ kind: "tool", id: str(block.id), name: str(block.name) ?? "tool", input: preview(block.input) });
      }
    }
    return out;
  }

  if (type === "user") return [{ kind: "tool-done" }];

  if (type === "result") {
    const usage = obj(raw.usage);
    return [
      {
        kind: "result",
        costUsd: num(raw.total_cost_usd) ?? num(raw.cost_usd),
        durationMs: num(raw.duration_ms),
        inputTokens: num(usage?.input_tokens),
        outputTokens: num(usage?.output_tokens),
        failed: raw.is_error === true,
      },
    ];
  }
  return [];
}

/** Grok Build: `streaming-json` — thought and text deltas, then an end frame. */
function grok(raw: Raw, type: string | undefined): ChatEvent[] {
  if (type === "session" || str(raw.session_id)) {
    const id = str(raw.session_id);
    if (id && type !== "text") return [{ kind: "session", id }];
  }
  if (type === "text" || type === "assistant_text") {
    const text = str(raw.text) ?? str(raw.content);
    return text ? [{ kind: "text", text }] : [];
  }
  if (type === "tool_use" || type === "tool_call") {
    return [{ kind: "tool", id: str(raw.id), name: str(raw.name) ?? "tool", input: preview(raw.input ?? raw.arguments) }];
  }
  if (type === "tool_result") return [{ kind: "tool-done", id: str(raw.id) }];
  if (type === "end" || type === "result") {
    return [{ kind: "result", durationMs: num(raw.duration_ms), failed: raw.is_error === true }];
  }
  return [];
}

/** Codex `exec --json`: JSONL of items, where the message is one completed item. */
function codex(raw: Raw, type: string | undefined): ChatEvent[] {
  const item = obj(raw.item) ?? raw;
  const itemType = str(item.type) ?? type;

  if (itemType === "agent_message" || itemType === "message") {
    const text = str(item.text) ?? str(item.content);
    return text ? [{ kind: "text", text: `${text}\n` }] : [];
  }
  if (itemType === "command_execution" || itemType === "function_call") {
    return [{ kind: "tool", id: str(item.id), name: str(item.name) ?? "command", input: preview(item.command ?? item.arguments) }];
  }
  if (type === "turn.completed" || itemType === "turn.completed") {
    const usage = obj(raw.usage) ?? obj(item.usage);
    return [{ kind: "result", inputTokens: num(usage?.input_tokens), outputTokens: num(usage?.output_tokens) }];
  }
  return [];
}
