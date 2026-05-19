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
  | "waiting_for_approval"
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

  let emittedRef = false;
  for (const name of ["x-hermes-session-id", "hermes-session-id"]) {
    const value = res.headers.get(name);
    if (!value) continue;
    emittedRef = true;
    handlers.onServerSessionRef?.(value);
    break;
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
    const toRunId = (p: Record<string, unknown>): string =>
      typeof p.run_id === "string"
        ? p.run_id
        : typeof p.runId === "string"
          ? p.runId
          : "";
    const toTimestamp = (p: Record<string, unknown>): number =>
      typeof p.timestamp === "number" ? p.timestamp : Date.now();

    for (const f of frames) {
      // ---- Keepalive and stream closed markers ---------
      if ((f.event === "comment" || f.event === "") && f.data === "keepalive") continue;
      if (
        ((f.event === "comment" || f.event === "") &&
          (f.data === "stream closed" || f.data === "[DONE]")) ||
        (f.event === "done" && (f.data === "" || f.data === "[DONE]"))
      ) {
        sawTerminal = true;
        terminalOutcome = { kind: "ok" };
        return;
      }

      let p: Record<string, unknown> = {};
      let hasJson = false;
      try {
        const payload = JSON.parse(f.data) as unknown;
        if (payload && typeof payload === "object") {
          p = payload as Record<string, unknown>;
          hasJson = true;
        }
      } catch {
        // non-json payload; only explicit event name can classify it
      }

      if (hasJson && !emittedRef) {
        const serverSessionRef =
          typeof p.session_id === "string"
            ? p.session_id
            : typeof p.sessionId === "string"
              ? p.sessionId
              : undefined;
        if (serverSessionRef) {
          emittedRef = true;
          handlers.onServerSessionRef?.(serverSessionRef);
        }
      }

      const eventType =
        f.event && f.event !== "message"
          ? f.event
          : hasJson && typeof p.event === "string"
            ? p.event
            : undefined;

      if (!eventType) {
        if (hasJson) {
          handlers.onUnknownEvent?.(
            "(no event field)",
            f.data.length > 100 ? f.data.substring(0, 100) + "..." : f.data,
          );
        }
        continue;
      }

      // ---- run lifecycle status updates ----
      if (
        eventType === "run.started" ||
        eventType === "run.queued" ||
        eventType === "run.running" ||
        eventType === "run.waiting_for_approval" ||
        eventType === "run.stopping"
      ) {
        handlers.onRunStatus?.({
          runId: toRunId(p),
          status: eventType.replace("run.", "") as RunStatus,
        });
        continue;
      }

      if (eventType === "approval.request") {
        handlers.onRunStatus?.({
          runId: toRunId(p),
          status: "waiting_for_approval",
        });
        handlers.onUnknownEvent?.(
          eventType,
          f.data,
        );
        continue;
      }

      if (eventType === "approval.responded") {
        handlers.onRunStatus?.({
          runId: toRunId(p),
          status: "running",
        });
        handlers.onUnknownEvent?.(
          eventType,
          f.data,
        );
        continue;
      }

      // ---- hermes.tool.progress (chat-style progress event carried by runs stream) ----
      if (eventType === "hermes.tool.progress") {
        const status =
          typeof p.status === "string" ? p.status : typeof p.phase === "string" ? p.phase : "";
        const tool = typeof p.tool === "string" ? p.tool : "";
        if (status === "running") {
          handlers.onToolStarted?.({
            runId: toRunId(p),
            timestamp: toTimestamp(p),
            tool,
            preview: typeof p.label === "string" ? p.label : undefined,
          });
          continue;
        }
        if (status === "completed") {
          handlers.onToolCompleted?.({
            runId: toRunId(p),
            timestamp: toTimestamp(p),
            tool,
            duration: typeof p.duration === "number" ? p.duration : 0,
            error: Boolean(p.error),
          });
          continue;
        }
      }

      // ---- tool.started ----
      if (eventType === "tool.started") {
        handlers.onToolStarted?.({
          runId: toRunId(p),
          timestamp: toTimestamp(p),
          tool: typeof p.tool === "string" ? p.tool : "",
          preview:
            typeof p.preview === "string"
              ? p.preview
              : typeof p.label === "string"
                ? p.label
                : undefined,
        });
        continue;
      }

      // ---- tool.completed ----
      if (eventType === "tool.completed") {
        handlers.onToolCompleted?.({
          runId: toRunId(p),
          timestamp: toTimestamp(p),
          tool: typeof p.tool === "string" ? p.tool : "",
          duration: typeof p.duration === "number" ? p.duration : 0,
          error: typeof p.error === "boolean" ? p.error : false,
        });
        continue;
      }

      // ---- reasoning.available ----
      if (eventType === "reasoning.available") {
        handlers.onReasoningAvailable?.({
          runId: toRunId(p),
          timestamp: toTimestamp(p),
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
            runId: toRunId(p),
            timestamp: toTimestamp(p),
            delta,
          });
        }
        continue;
      }

      // ---- run.completed ----
      if (eventType === "run.completed") {
        const usage = p.usage as Record<string, number> | undefined;
        handlers.onRunCompleted?.({
          runId: toRunId(p),
          timestamp: toTimestamp(p),
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
          runId: toRunId(p),
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

      // ---- run.cancelled / run.stopped ----
      if (eventType === "run.cancelled" || eventType === "run.stopped") {
        handlers.onRunStatus?.({
          runId: toRunId(p),
          status: eventType === "run.cancelled" ? "cancelled" : "stopped",
        });
        sawTerminal = true;
        terminalOutcome = { kind: "stopped" };
        return;
      }

      // ---- Unknown event type in JSON / explicit event ----
      handlers.onUnknownEvent?.(
        eventType,
        f.data.length > 100 ? f.data.substring(0, 100) + "..." : f.data,
      );
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
