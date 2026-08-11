import { spawn } from "node:child_process";
import os from "node:os";
import { spawnEnv } from "./agents";

/**
 * One CLI turn, streamed to the browser as server-sent events.
 *
 * The frames are the process's own stdout lines, re-wrapped and not translated: each CLI
 * prints its own event dialect, and a common shape invented here would have to be invented
 * again the moment one of them adds a field. Three frames are this module's own, and are
 * the only ones the client can rely on being present regardless of which CLI ran:
 *
 *   {"type":"stderr","line":…}      a line the process wrote to stderr
 *   {"type":"proc_error","message":…,"code":…}   the process could not be started
 *   {"type":"proc_exit","code":…}   it finished, for better or worse
 *
 * Killing on disconnect is deliberate. A turn that keeps running after the reader has gone
 * spends money on output nobody will read, and unlike a generation job there is nothing to
 * reconcile afterwards — so closing the tab stops the process.
 */

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Hard ceiling, after which the process is asked to stop and then made to. */
  timeoutMs?: number;
}

const encoder = new TextEncoder();

export function sseSpawn(command: string, args: string[], opts: SpawnOptions = {}): Response {
  let running: ReturnType<typeof spawn> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* the reader is already gone */
        }
      };

      const child = spawn(command, args, {
        cwd: opts.cwd || os.homedir(),
        env: opts.env ?? spawnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      running = child;

      const timer = setTimeout(
        () => {
          send({ type: "stderr", line: `x-forge: no output for ${Math.round((opts.timeoutMs ?? 600_000) / 1000)}s, stopping` });
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 4000);
        },
        opts.timeoutMs ?? 600_000,
      );

      // Lines, not chunks: a CLI writing JSON per line will still have a line split across
      // two reads, and half a JSON object parses as nothing at all.
      const lines = (source: NodeJS.ReadableStream, onLine: (line: string) => void) => {
        let buffer = "";
        source.setEncoding("utf8");
        source.on("data", (chunk: string) => {
          buffer += chunk;
          const parts = buffer.split("\n");
          buffer = parts.pop() ?? "";
          for (const line of parts) if (line.trim()) onLine(line);
        });
        source.on("end", () => {
          if (buffer.trim()) onLine(buffer);
        });
      };

      if (child.stdout) {
        lines(child.stdout, (line) => {
          try {
            send(JSON.parse(line));
          } catch {
            // Not every CLI speaks JSON on every line; plain output is still output.
            send({ type: "text", line });
          }
        });
      }
      if (child.stderr) lines(child.stderr, (line) => send({ type: "stderr", line }));

      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        send({ type: "proc_error", message: err.message, code: err.code ?? "SPAWN_FAILED" });
        finish();
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        running = null;
        send({ type: "proc_exit", code });
        finish();
      });
    },

    // The reader went away: stop the turn rather than let it bill for output nobody reads.
    // SIGTERM first so the CLI can write its own transcript, SIGKILL if it will not go.
    cancel() {
      if (!running) return;
      const child = running;
      running = null;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 4000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
