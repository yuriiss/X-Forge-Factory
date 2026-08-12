/**
 * Reading what a model CLI prints.
 *
 * Every one of these streams JSON lines, and every one of them streams a different JSON
 * line. Claude wraps Anthropic's own event shape; Kimi emits bare `{role, content}` objects;
 * Grok sends `{type:"text", data}` deltas and calls its reasoning `thought`; Codex emits
 * completed items; agy nests everything under `step_update`. Rather than pretend they agree,
 * each dialect gets a branch here and produces one small set of events the console renders.
 *
 * Every shape below was read off the real CLIs on a machine, not from documentation, which
 * is why the tests pin them: a dialect that changes upstream should fail loudly here rather
 * than turn into a silent, empty answer.
 *
 * Anything unrecognised is dropped rather than guessed at. A console that invents a message
 * from a line it did not understand is worse than one that stays quiet, because the invented
 * text looks exactly like something the model said.
 */

export type ChatEvent =
  | { kind: "session"; id: string; model?: string }
  /** `final` marks text from a completed message rather than from a delta stream. */
  | { kind: "text"; text: string; final?: boolean }
  | { kind: "tool"; id?: string; name: string; input?: string }
  | { kind: "tool-done"; id?: string }
  | { kind: "result"; costUsd?: number; durationMs?: number; inputTokens?: number; outputTokens?: number; failed?: boolean }
  | { kind: "error"; message: string }
  | { kind: "exit"; code: number | null };

/**
 * stderr lines that are a CLI talking to itself.
 *
 * Everything on stderr is shown as an error, which is the right default — a model that
 * failed usually says so there and nowhere else. These are the exceptions: progress notes
 * and startup chatter that would otherwise put a red box under every turn and teach the
 * reader to ignore red boxes.
 */
const NOISE = /^(Reading additional input from stdin|\[dotenv|Warning: |DevTools listening on)/;

type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const obj = (v: unknown): Raw | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : undefined);

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
  if (type === "proc_error") return [{ kind: "error", message: str(raw.message) ?? "the process failed to start" }];
  if (type === "proc_exit") return [{ kind: "exit", code: num(raw.code) ?? null }];
  if (type === "stderr") {
    const line = str(raw.line) ?? "";
    return line.trim() && !NOISE.test(line) ? [{ kind: "error", message: line }] : [];
  }
  // A line the CLI printed that was not JSON at all. Matched on the field rather than on
  // the type alone, because Grok's own text events are also called `text`.
  if (type === "text" && typeof raw.line === "string") return [{ kind: "text", text: `${raw.line}\n` }];
  // A provider turn.
  if (type === "delta") return [{ kind: "text", text: str(raw.text) ?? "" }];

  switch (dialect) {
    case "claude":
      return claude(raw, type);
    case "kimi":
      return kimi(raw);
    case "grok":
      return grok(raw, type);
    case "codex":
      return codex(raw, type);
    case "agy":
      return agy(raw);
    default:
      return [];
  }
}

/**
 * Claude Code, and Qwen Code which uses the same envelope.
 *
 * Claude streams partial deltas and then repeats the finished message; Qwen sends only the
 * finished message. Both are emitted, the second marked `final`, and the console drops a
 * final that merely repeats what it already streamed.
 */
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
      if (str(block?.type) === "tool_use") return [{ kind: "tool", id: str(block?.id), name: str(block?.name) ?? "tool" }];
    }
    return [];
  }

  if (type === "assistant") {
    const message = obj(raw.message);
    const content = Array.isArray(message?.content) ? (message?.content as Raw[]) : [];
    const out: ChatEvent[] = [];
    for (const block of content) {
      const blockType = str(block.type);
      if (blockType === "tool_use") {
        out.push({ kind: "tool", id: str(block.id), name: str(block.name) ?? "tool", input: preview(block.input) });
      } else if (blockType === "text") {
        const text = str(block.text);
        if (text) out.push({ kind: "text", text, final: true });
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

/** Kimi: bare messages, with the session id arriving as a resume hint at the end. */
function kimi(raw: Raw): ChatEvent[] {
  const role = str(raw.role);

  if (role === "assistant") {
    const content = str(raw.content);
    return content ? [{ kind: "text", text: content, final: true }] : [];
  }
  if (role === "meta") {
    const id = str(raw.session_id);
    return id ? [{ kind: "session", id }] : [];
  }
  if (role === "tool" || str(raw.type) === "tool_call") {
    return [{ kind: "tool", id: str(raw.id), name: str(raw.name) ?? "tool", input: preview(raw.arguments ?? raw.input) }];
  }
  return [];
}

/** Grok Build: deltas under `data`, reasoning as `thought`, the session id only at the end. */
function grok(raw: Raw, type: string | undefined): ChatEvent[] {
  if (type === "text") {
    const text = str(raw.data);
    return text ? [{ kind: "text", text }] : [];
  }
  if (type === "tool_use" || type === "tool_call") {
    return [{ kind: "tool", id: str(raw.id), name: str(raw.name) ?? "tool", input: preview(raw.input ?? raw.arguments) }];
  }
  if (type === "tool_result") return [{ kind: "tool-done", id: str(raw.id) }];
  if (type === "end") {
    const usage = obj(raw.usage);
    const id = str(raw.sessionId);
    const events: ChatEvent[] = id ? [{ kind: "session", id }] : [];
    events.push({
      kind: "result",
      inputTokens: num(usage?.input_tokens),
      outputTokens: num(usage?.output_tokens),
      failed: str(raw.stopReason) === "error",
    });
    return events;
  }
  // `thought` is Grok thinking aloud, one word per frame. It is not the answer, and putting
  // it in the bubble would bury the answer under it.
  return [];
}

/** Codex `exec --json`: a thread id, then completed items, then a turn summary. */
function codex(raw: Raw, type: string | undefined): ChatEvent[] {
  if (type === "thread.started") {
    const id = str(raw.thread_id);
    return id ? [{ kind: "session", id }] : [];
  }

  if (type === "item.completed" || type === "item.started") {
    const item = obj(raw.item);
    const itemType = str(item?.type);
    if (itemType === "agent_message") {
      const text = str(item?.text);
      return text && type === "item.completed" ? [{ kind: "text", text: `${text}\n`, final: true }] : [];
    }
    if (itemType === "command_execution" || itemType === "function_call" || itemType === "file_change") {
      return [
        {
          kind: type === "item.completed" ? "tool-done" : "tool",
          id: str(item?.id),
          name: str(item?.name) ?? itemType,
          input: preview(item?.command ?? item?.arguments),
        } as ChatEvent,
      ];
    }
    return [];
  }

  if (type === "turn.completed" || type === "turn.failed") {
    const usage = obj(raw.usage);
    return [
      {
        kind: "result",
        inputTokens: num(usage?.input_tokens),
        outputTokens: num(usage?.output_tokens),
        failed: type === "turn.failed",
      },
    ];
  }
  return [];
}

/** Antigravity's `agy`: everything is a step update, and the answer arrives as text deltas. */
function agy(raw: Raw): ChatEvent[] {
  const event = str(raw.event);

  if (event === "step_update") {
    const step = obj(raw.step_update);
    const stepType = str(step?.step_type);
    const out: ChatEvent[] = [];

    const id = str(step?.conversation_id);
    if (id && str(step?.state) === "DONE" && stepType === "user_input") out.push({ kind: "session", id });

    if (stepType === "agent_response") {
      const delta = str(step?.text_delta);
      if (delta) out.push({ kind: "text", text: delta });
    } else if (stepType === "tool_use" || stepType === "tool_call") {
      out.push({
        kind: str(step?.state) === "DONE" ? "tool-done" : "tool",
        id: str(step?.tool_call_id),
        name: str(step?.tool_name) ?? "tool",
      } as ChatEvent);
    }
    return out;
  }

  if (event === "result") {
    const result = obj(raw.result);
    const usage = obj(result?.usage);
    const seconds = num(result?.duration_seconds);
    return [
      {
        kind: "result",
        durationMs: seconds !== undefined ? Math.round(seconds * 1000) : undefined,
        inputTokens: num(usage?.input_tokens),
        outputTokens: num(usage?.output_tokens),
        failed: str(result?.status) !== "SUCCESS",
      },
    ];
  }
  return [];
}
