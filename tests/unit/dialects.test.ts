import { describe, expect, it } from "vitest";
import { readEvent, type ChatEvent } from "@/lib/chatEvents";

/**
 * The dialects, pinned to what the CLIs actually print.
 *
 * Every line below was copied off a real run rather than written from documentation. That
 * is the point of the file: when a CLI changes its output shape, the failure should be a
 * red test naming the dialect, not a chat that answers with silence.
 */

const texts = (events: ChatEvent[]) => events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text);
const kinds = (events: ChatEvent[]) => events.map((e) => e.kind);

function read(dialect: string, line: string): ChatEvent[] {
  return readEvent(dialect, JSON.parse(line) as Record<string, unknown>);
}

describe("claude", () => {
  it("takes the session id from the init frame", () => {
    const events = read("claude", '{"type":"system","subtype":"init","session_id":"79bb1679","model":"claude-haiku-4-5"}');
    expect(events[0]).toEqual({ kind: "session", id: "79bb1679", model: "claude-haiku-4-5" });
  });

  it("reads a streamed delta", () => {
    const events = read("claude", '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"forge"}}}');
    expect(texts(events)).toEqual(["forge"]);
    expect((events[0] as { final?: boolean }).final).toBeUndefined();
  });

  it("marks the repeated whole message as final so it can be dropped", () => {
    const events = read("claude", '{"type":"assistant","message":{"content":[{"type":"text","text":"forge link ok"}]}}');
    expect((events[0] as { final?: boolean }).final).toBe(true);
  });

  it("reads Qwen Code, which shares the envelope but never streams", () => {
    const events = read("claude", '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"trivial"},{"type":"text","text":"ok"}]}}');
    expect(texts(events)).toEqual(["ok"]);
  });
});

describe("kimi", () => {
  it("reads a bare assistant message", () => {
    expect(texts(read("kimi", '{"role":"assistant","content":"ok"}'))).toEqual(["ok"]);
  });

  it("takes the session id from the resume hint", () => {
    const events = read("kimi", '{"role":"meta","type":"session.resume_hint","session_id":"session_f2692dc0","command":"kimi -r session_f2692dc0"}');
    expect(events[0]).toEqual({ kind: "session", id: "session_f2692dc0" });
  });
});

describe("grok", () => {
  it("reads a delta out of `data`, not `text`", () => {
    expect(texts(read("grok", '{"type":"text","data":"ok"}'))).toEqual(["ok"]);
  });

  it("keeps thinking out of the answer", () => {
    expect(read("grok", '{"type":"thought","data":"The"}')).toHaveLength(0);
  });

  it("takes the session id and the usage from the end frame", () => {
    const events = read("grok", '{"type":"end","stopReason":"end_turn","sessionId":"019ff640","usage":{"input_tokens":81506,"output_tokens":30}}');
    expect(kinds(events)).toEqual(["session", "result"]);
    expect((events[1] as { outputTokens?: number }).outputTokens).toBe(30);
  });
});

describe("codex", () => {
  it("takes the thread id", () => {
    expect(read("codex", '{"type":"thread.started","thread_id":"019ff640"}')[0]).toEqual({ kind: "session", id: "019ff640" });
  });

  it("reads a completed agent message", () => {
    expect(texts(read("codex", '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}'))).toEqual(["ok\n"]);
  });

  it("reads the turn summary", () => {
    const events = read("codex", '{"type":"turn.completed","usage":{"input_tokens":15987,"output_tokens":5}}');
    expect((events[0] as { inputTokens?: number }).inputTokens).toBe(15987);
  });
});

describe("agy", () => {
  it("reads a text delta out of a step update", () => {
    const line = '{"event":"step_update","step_update":{"conversation_id":"faed5b32","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"ok"}}';
    expect(texts(read("agy", line))).toEqual(["ok"]);
  });

  it("takes the conversation id from the accepted input step", () => {
    const line = '{"event":"step_update","step_update":{"conversation_id":"faed5b32","step_index":0,"state":"DONE","step_type":"user_input"}}';
    expect(read("agy", line)[0]).toEqual({ kind: "session", id: "faed5b32" });
  });

  it("reads the result", () => {
    const line = '{"event":"result","result":{"conversation_id":"faed5b32","status":"SUCCESS","duration_seconds":2.45,"usage":{"input_tokens":20906,"output_tokens":22}}}';
    const events = read("agy", line);
    expect((events[0] as { durationMs?: number; failed?: boolean }).durationMs).toBe(2450);
    expect((events[0] as { failed?: boolean }).failed).toBe(false);
  });
});

describe("every dialect", () => {
  it("says nothing about a line it does not understand", () => {
    for (const dialect of ["claude", "kimi", "grok", "codex", "agy"]) {
      expect(read(dialect, '{"type":"available_commands","tools":["write"]}')).toHaveLength(0);
    }
  });

  it("shows a real stderr line and swallows a CLI talking to itself", () => {
    expect(kinds(read("claude", '{"type":"stderr","line":"Error: not signed in"}'))).toEqual(["error"]);
    expect(read("codex", '{"type":"stderr","line":"Reading additional input from stdin..."}')).toHaveLength(0);
  });

  it("does not mistake Grok's text event for the non-JSON fallback", () => {
    expect(texts(read("grok", '{"type":"text","data":"real"}'))).toEqual(["real"]);
    expect(texts(read("grok", '{"type":"text","line":"raw output"}'))).toEqual(["raw output\n"]);
  });
});
