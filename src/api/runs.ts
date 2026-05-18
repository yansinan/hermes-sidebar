// Runs API event consumer (Hermes-specific).
//
// Consumes the SSE event stream from GET /v1/runs/{id}/events and emits
// parsed events. Reuses the SseParser from ./sse and shares the
// StreamOutcome / ToolProgressPayload vocabulary with ./stream so that the
// controller can treat both chat and runs outcomes uniformly.
//
// Recognised SSE event types:
//   default (no event: line) — OpenAI-compatible delta chunks (text/thinking)
//   hermes.tool.progress     — same payload as the chat endpoint
//   run.queued               — run accepted by the server
//   run.running              — run started executing
//   run.completed            — run finished successfully; stream will end
//   run.failed               — run ended with an error
//   run.stopped              — run was stopped (user- or server-initiated)

import { SseParser, type SseFrame } from "./sse";
import type { StreamOutcome, ToolProgressPayload } from "./stream";

export type RunStatus =
  | "started"
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped";

export interface RunLifecyclePayload {
  /** Server-assigned run id. */
  runId: string;
  status: RunStatus;
  /** Present when status is "failed". */
  error?: string;
}

export interface RunEventHandlers {
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolProgress?: (payload: ToolProgressPayload) => void;
  /** Called for each run lifecycle event: queued, running, completed, etc. */
  onRunStatus?: (payload: RunLifecyclePayload) => void;
  /** Called once with the final outcome when the stream ends for any reason. */
  onEnd?: (outcome: StreamOutcome) => void;
  /** Called at most once with the first captured server session id, if any. */
  onServerSessionRef?: (ref: string) => void;
}

const DONE_SENTINEL = "[DONE]";

const TERMINAL_RUN_EVENTS = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.stopped",
]);

/**
 * Read and dispatch events from a run event-stream response.
 * Resolves with the final outcome; also calls `handlers.onEnd`.
 */
export async function consumeRunEvents(
  res: Response,
  handlers: RunEventHandlers,
  signal?: AbortSignal,
): Promise<StreamOutcome> {
  if (!res.ok) {
    let message: string | undefined;
    try {
      const text = await res.clone().text();
      if (text.length <= 2000) message = text;
    } catch {
      // ignore
    }
    const outcome: StreamOutcome = {
      kind: "error",
      status: res.status,
      ...(message ? { message } : {}),
    };
    handlers.onEnd?.(outcome);
    return outcome;
  }

  if (!res.body) {
    const outcome: StreamOutcome = { kind: "interrupted", reason: "empty body" };
    handlers.onEnd?.(outcome);
    return outcome;
  }

  const parser = new SseParser();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sawTerminal = false;
  let terminalOutcome: StreamOutcome | null = null;
  let sawDone = false;
  let emittedRef = false;
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const handleFrames = (frames: SseFrame[]) => {
    for (const f of frames) {
      // ---- [DONE] sentinel (same as chat) --------------------------------
      if ((f.event === "message" || f.event === "") && f.data === DONE_SENTINEL) {
        sawDone = true;
        return;
      }

      // ---- Run lifecycle events -----------------------------------------
      if (TERMINAL_RUN_EVENTS.has(f.event) || f.event === "run.queued" || f.event === "run.running") {
        let payload: unknown;
        try {
          payload = JSON.parse(f.data);
        } catch {
          continue;
        }
        const p = payload as { id?: unknown; run_id?: unknown; status?: unknown; error?: unknown };
        const runId =
          typeof p?.id === "string"
            ? p.id
            : typeof p?.run_id === "string"
              ? p.run_id
              : "";
        const status = (p?.status as RunStatus | undefined) ?? eventNameToStatus(f.event);

        handlers.onRunStatus?.({
          runId,
          status,
          ...(typeof p?.error === "string" ? { error: p.error } : {}),
        });

        if (TERMINAL_RUN_EVENTS.has(f.event)) {
          sawTerminal = true;
          terminalOutcome =
            f.event === "run.completed"
              ? { kind: "ok" }
              : f.event === "run.stopped" || f.event === "run.cancelled"
                ? { kind: "stopped" }
                : { kind: "error", status: 0, message: typeof p?.error === "string" ? p.error : "run failed" };
          return;
        }
        continue;
      }

      // ---- Default delta frames (same as chat) --------------------------
      if (f.event === "message" || f.event === "") {
        let delta: unknown;
        try {
          delta = JSON.parse(f.data);
        } catch {
          continue;
        }
        const chunk = delta as {
          choices?: {
            delta?: {
              content?: unknown;
              reasoning?: unknown;
              reasoning_content?: unknown;
              thinking?: unknown;
            };
          }[];
          session_id?: unknown;
        };
        const contentRaw = chunk?.choices?.[0]?.delta?.content;
        if (typeof contentRaw === "string" && contentRaw.length > 0) {
          handlers.onTextDelta?.(contentRaw);
        }
        const thinkingRaw =
          chunk?.choices?.[0]?.delta?.reasoning_content ??
          chunk?.choices?.[0]?.delta?.reasoning ??
          chunk?.choices?.[0]?.delta?.thinking;
        if (typeof thinkingRaw === "string" && thinkingRaw.length > 0) {
          handlers.onThinkingDelta?.(thinkingRaw);
        }
        if (!emittedRef && typeof chunk?.session_id === "string") {
          emittedRef = true;
          handlers.onServerSessionRef?.(chunk.session_id as string);
        }
        continue;
      }

      // ---- hermes.tool.progress ----------------------------------------
      if (f.event === "hermes.tool.progress") {
        let payload: unknown;
        try {
          payload = JSON.parse(f.data);
        } catch {
          continue;
        }
        const p = payload as { tool?: unknown; status?: unknown; call_id?: unknown };
        if (
          typeof p?.tool === "string" &&
          (p.status === "started" || p.status === "finished")
        ) {
          handlers.onToolProgress?.({
            tool: p.tool,
            status: p.status,
            ...(typeof p.call_id === "string" ? { callId: p.call_id } : {}),
          });
        }
        continue;
      }
      // Other event types are ignored.
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });
      handleFrames(parser.push(chunkText));
      if (sawDone || sawTerminal) break;
    }
    const trailing = decoder.decode();
    if (trailing.length > 0) handleFrames(parser.push(trailing));
    handleFrames(parser.flush());
  } catch (e) {
    if (aborted) {
      const outcome: StreamOutcome = { kind: "stopped" };
      handlers.onEnd?.(outcome);
      return outcome;
    }
    const outcome: StreamOutcome = {
      kind: "interrupted",
      reason: e instanceof Error ? e.message : String(e),
    };
    handlers.onEnd?.(outcome);
    return outcome;
  } finally {
    if (signal) signal.removeEventListener?.("abort", onAbort);
  }

  if (aborted) {
    const outcome: StreamOutcome = { kind: "stopped" };
    handlers.onEnd?.(outcome);
    return outcome;
  }
  if (sawTerminal && terminalOutcome) {
    handlers.onEnd?.(terminalOutcome);
    return terminalOutcome;
  }
  if (sawDone) {
    const outcome: StreamOutcome = { kind: "ok" };
    handlers.onEnd?.(outcome);
    return outcome;
  }
  const outcome: StreamOutcome = { kind: "interrupted", reason: "eof" };
  handlers.onEnd?.(outcome);
  return outcome;
}

function eventNameToStatus(event: string): RunStatus {
  if (event === "run.started") return "started";
  if (event === "run.stopping") return "stopping";
  if (event === "run.completed") return "completed";
  if (event === "run.failed") return "failed";
  if (event === "run.cancelled") return "cancelled";
  if (event === "run.stopped") return "stopped";
  if (event === "run.running") return "running";
  return "queued";
}
