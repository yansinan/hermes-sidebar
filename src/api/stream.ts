// Stream handler (docs/api-contract.md §5.4 + §6; docs/architecture.md §3.9).
//
// Consumes the `Response` from `openChatStream` and emits parsed events. The
// handler owns no state beyond the read loop; the session manager is the thing
// that appends deltas to a message and finalizes it.

import { SseParser, type SseFrame } from "./sse";

export type StreamOutcome =
  | { kind: "ok" }
  | { kind: "stopped" }
  | { kind: "interrupted"; reason?: string }
  | { kind: "error"; status: number; message?: string };

export interface ToolProgressPayload {
  /** Human-readable tool name. */
  tool: string;
  status: "running" | "completed";
  /** Stable id used to match a `completed` to its `running`. */
  callId?: string;
  /** Optional preview fields from Hermes progress payload. */
  label?: string;
  emoji?: string;
}

export interface StreamHandlers {
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolProgress?: (payload: ToolProgressPayload) => void;
  /** Called once with the outcome when the stream ends for any reason. */
  onEnd?: (outcome: StreamOutcome) => void;
  /** Called at most once with the first captured server session id, if any. */
  onServerSessionRef?: (ref: string) => void;
}

const DONE_SENTINEL = "[DONE]";

/**
 * Read and dispatch events from a streaming chat-completions response. The
 * caller provides an `AbortSignal` to support `Stop`.
 *
 * Resolves with the final outcome. It also calls `handlers.onEnd` so callers
 * that prefer event-style plumbing can ignore the return value.
 */
export async function consumeChatStream(
  res: Response,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<StreamOutcome> {
  // Non-2xx: try to read a short JSON error once and surface it as `error`.
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
    const outcome: StreamOutcome = {
      kind: "interrupted",
      reason: "empty body",
    };
    handlers.onEnd?.(outcome);
    return outcome;
  }

  const parser = new SseParser();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
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
      if (f.event === "message" || f.event === "") {
        if (f.data === DONE_SENTINEL) {
          sawDone = true;
          return;
        }
        // JSON delta chunk. Tolerate parse failures.
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
            finish_reason?: unknown;
          }[];
          id?: unknown;
          // Some servers may expose the session id on each chunk; harmless to
          // capture when present.
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
      } else if (f.event === "hermes.tool.progress") {
        let payload: unknown;
        try {
          payload = JSON.parse(f.data);
        } catch {
          continue;
        }
        const p = payload as {
          tool?: unknown;
          status?: unknown;
          toolCallId?: unknown;
          call_id?: unknown;
          label?: unknown;
          emoji?: unknown;
        };
        const normalizedStatus =
          p.status === "running" || p.status === "started"
            ? "running"
            : p.status === "completed" || p.status === "finished"
              ? "completed"
              : null;
        if (
          typeof p?.tool === "string" &&
          normalizedStatus
        ) {
          const progress: ToolProgressPayload = {
            tool: p.tool,
            status: normalizedStatus,
            ...(typeof p.toolCallId === "string"
              ? { callId: p.toolCallId }
              : typeof p.call_id === "string"
                ? { callId: p.call_id }
                : {}),
            ...(typeof p.label === "string" ? { label: p.label } : {}),
            ...(typeof p.emoji === "string" ? { emoji: p.emoji } : {}),
          };
          handlers.onToolProgress?.(progress);
        }
      }
      // Other event types are logged at debug level elsewhere; ignored here.
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });
      handleFrames(parser.push(chunkText));
      if (sawDone) break;
    }
    // Flush any trailing frame.
    const chunkText = decoder.decode();
    if (chunkText.length > 0) handleFrames(parser.push(chunkText));
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
  if (sawDone) {
    const outcome: StreamOutcome = { kind: "ok" };
    handlers.onEnd?.(outcome);
    return outcome;
  }
  const outcome: StreamOutcome = { kind: "interrupted", reason: "eof" };
  handlers.onEnd?.(outcome);
  return outcome;
}
