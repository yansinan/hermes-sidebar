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
import type { StreamOutcome } from "./stream";

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

export interface ToolStartedPayload {
  runId: string;
  timestamp: number;
  tool: string;
  preview?: string;
}

export interface ToolCompletedPayload {
  runId: string;
  timestamp: number;
  tool: string;
  duration: number;
  error: boolean;
}

export interface ReasoningAvailablePayload {
  runId: string;
  timestamp: number;
  text: string;
}

export interface MessageDeltaPayload {
  runId: string;
  timestamp: number;
  delta: string;
}

export interface RunCompletedPayload {
  runId: string;
  timestamp: number;
  output: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface RunEventHandlers {
  /** Called for streaming message chunks. */
  onMessageDelta?: (payload: MessageDeltaPayload) => void;
  /** Called when tool invocation starts. */
  onToolStarted?: (payload: ToolStartedPayload) => void;
  /** Called when tool execution completes. */
  onToolCompleted?: (payload: ToolCompletedPayload) => void;
  /** Called when intermediate reasoning text is available. */
  onReasoningAvailable?: (payload: ReasoningAvailablePayload) => void;
  /** Called when run completes successfully with final output and usage. */
  onRunCompleted?: (payload: RunCompletedPayload) => void;
  /** Called for run lifecycle changes (failed, cancelled). */
  onRunStatus?: (payload: RunLifecyclePayload) => void;
  /** Called once with the final outcome when the stream ends for any reason. */
  onEnd?: (outcome: StreamOutcome) => void;
  /** Called at most once with the first captured server session id, if any. */
  onServerSessionRef?: (ref: string) => void;
  /** Called for any unrecognized event type from the server, ensuring all events are captured. */
  onUnknownEvent?: (eventName: string, data: string) => void;
}

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
      // ---- Keepalive and stream closed markers ---------
      if (f.event === "" && f.data === "keepalive") continue;
      if (f.event === "" && f.data === "stream closed") {
        sawTerminal = true;
        terminalOutcome = { kind: "ok" };
        return;
      }

      // ---- All events are in data: JSON format, extract event type from payload
      if (f.event === "" || f.event === "message") {
        let payload: unknown;
        try {
          payload = JSON.parse(f.data);
        } catch {
          // Unparseable data line—skip
          continue;
        }

        const p = payload as Record<string, unknown>;
        const eventType = p.event as string | undefined;

        if (!eventType) {
          // JSON without event field—skip or treat as unknown
          handlers.onUnknownEvent?.(
            "(no event field)",
            f.data.length > 100 ? f.data.substring(0, 100) + "..." : f.data,
          );
          continue;
        }

        // ---- tool.started ----
        if (eventType === "tool.started") {
          handlers.onToolStarted?.({
            runId: typeof p.run_id === "string" ? p.run_id : "",
            timestamp: typeof p.timestamp === "number" ? p.timestamp : 0,
            tool: typeof p.tool === "string" ? p.tool : "",
            preview: typeof p.preview === "string" ? p.preview : undefined,
          });
          continue;
        }

        // ---- tool.completed ----
        if (eventType === "tool.completed") {
          handlers.onToolCompleted?.({
            runId: typeof p.run_id === "string" ? p.run_id : "",
            timestamp: typeof p.timestamp === "number" ? p.timestamp : 0,
            tool: typeof p.tool === "string" ? p.tool : "",
            duration: typeof p.duration === "number" ? p.duration : 0,
            error: typeof p.error === "boolean" ? p.error : false,
          });
          continue;
        }

        // ---- reasoning.available ----
        if (eventType === "reasoning.available") {
          handlers.onReasoningAvailable?.({
            runId: typeof p.run_id === "string" ? p.run_id : "",
            timestamp: typeof p.timestamp === "number" ? p.timestamp : 0,
            text: typeof p.text === "string" ? p.text : "",
          });
          continue;
        }

        // ---- message.delta ----
        if (eventType === "message.delta") {
          const delta =
            typeof p.delta === "string"
              ? p.delta
              : typeof p.content === "string"
                ? p.content
                : "";
          if (delta.length > 0) {
            handlers.onMessageDelta?.({
              runId: typeof p.run_id === "string" ? p.run_id : "",
              timestamp: typeof p.timestamp === "number" ? p.timestamp : 0,
              delta,
            });
          }
          continue;
        }

        // ---- run.completed ----
        if (eventType === "run.completed") {
          const usage = p.usage as Record<string, number> | undefined;
          handlers.onRunCompleted?.({
            runId: typeof p.run_id === "string" ? p.run_id : "",
            timestamp: typeof p.timestamp === "number" ? p.timestamp : 0,
            output: typeof p.output === "string" ? p.output : "",
            usage: usage
              ? {
                  input_tokens:
                    typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
                  output_tokens:
                    typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
                  total_tokens:
                    typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
                }
              : undefined,
          });
          sawTerminal = true;
          terminalOutcome = { kind: "ok" };
          return;
        }

        // ---- run.failed ----
        if (eventType === "run.failed") {
          handlers.onRunStatus?.({
            runId: typeof p.run_id === "string" ? p.run_id : "",
            status: "failed",
            error: typeof p.error === "string" ? p.error : undefined,
          });
          sawTerminal = true;
          terminalOutcome = {
            kind: "error",
            status: 0,
            message: typeof p.error === "string" ? p.error : "run failed",
          };
          return;
        }

        // ---- run.cancelled ----
        if (eventType === "run.cancelled") {
          handlers.onRunStatus?.({
            runId: typeof p.run_id === "string" ? p.run_id : "",
            status: "cancelled",
          });
          sawTerminal = true;
          terminalOutcome = { kind: "stopped" };
          return;
        }

        // ---- Unknown event type in JSON ---
        handlers.onUnknownEvent?.(
          eventType,
          f.data.length > 100 ? f.data.substring(0, 100) + "..." : f.data,
        );
      }
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });
      handleFrames(parser.push(chunkText));
      if (sawTerminal) break;
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
  const outcome: StreamOutcome = { kind: "interrupted", reason: "eof" };
  handlers.onEnd?.(outcome);
  return outcome;
}
