import { describe, it, expect, vi } from "vitest";
import {
  consumeRunEvents,
  type RunEventHandlers,
  type RunLifecyclePayload,
} from "../src/api/runs";
import type { ToolProgressPayload } from "../src/api/stream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function pendingSseResponse(): {
  response: Response;
  enqueue: (text: string) => void;
  close: () => void;
} {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
  const encoder = new TextEncoder();
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    enqueue: (text) => ctrl.enqueue(encoder.encode(text)),
    close: () => ctrl.close(),
  };
}

// ---------------------------------------------------------------------------
// Text delta (same wire format as chat completions)
// ---------------------------------------------------------------------------

describe("consumeRunEvents — text deltas", () => {
  it("emits text deltas from standard delta chunks", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const deltas: string[] = [];
    const outcome = await consumeRunEvents(res, { onTextDelta: (d) => deltas.push(d) });
    expect(outcome).toEqual({ kind: "ok" });
    expect(deltas.join("")).toBe("Hello");
  });

  it("emits thinking deltas via reasoning_content", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const thinkings: string[] = [];
    const outcome = await consumeRunEvents(res, { onThinkingDelta: (d) => thinkings.push(d) });
    expect(outcome.kind).toBe("ok");
    expect(thinkings).toEqual(["think"]);
  });

  it("captures server session ref from session_id field", async () => {
    const res = sseResponse([
      'data: {"session_id":"srv-99","choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    let ref: string | undefined;
    await consumeRunEvents(res, { onServerSessionRef: (r) => { ref = r; } });
    expect(ref).toBe("srv-99");
  });
});

// ---------------------------------------------------------------------------
// hermes.tool.progress (same as chat endpoint)
// ---------------------------------------------------------------------------

describe("consumeRunEvents — tool progress", () => {
  it("surfaces started and finished tool progress events", async () => {
    const res = sseResponse([
      'event: hermes.tool.progress\ndata: {"tool":"search","status":"started","call_id":"c1"}\n\n',
      'event: hermes.tool.progress\ndata: {"tool":"search","status":"finished","call_id":"c1"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events: ToolProgressPayload[] = [];
    await consumeRunEvents(res, { onToolProgress: (e) => events.push(e) });
    expect(events).toHaveLength(2);
    expect(events[0]!.status).toBe("started");
    expect(events[0]!.callId).toBe("c1");
    expect(events[1]!.status).toBe("finished");
  });

  it("ignores tool progress with missing required fields", async () => {
    const res = sseResponse([
      'event: hermes.tool.progress\ndata: {"status":"started"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events: ToolProgressPayload[] = [];
    await consumeRunEvents(res, { onToolProgress: (e) => events.push(e) });
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Run lifecycle events
// ---------------------------------------------------------------------------

describe("consumeRunEvents — run lifecycle", () => {
  it("emits run.queued and run.running lifecycle events", async () => {
    const res = sseResponse([
      'event: run.queued\ndata: {"id":"r1","status":"queued"}\n\n',
      'event: run.running\ndata: {"id":"r1","status":"running"}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const statuses: RunLifecyclePayload[] = [];
    const outcome = await consumeRunEvents(res, { onRunStatus: (p) => statuses.push(p) });
    expect(outcome.kind).toBe("ok");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]!.status).toBe("queued");
    expect(statuses[1]!.status).toBe("running");
  });

  it("run.completed ends the stream with ok outcome", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
      'event: run.completed\ndata: {"id":"r1","status":"completed"}\n\n',
    ]);
    const deltas: string[] = [];
    const statuses: RunLifecyclePayload[] = [];
    const outcome = await consumeRunEvents(res, {
      onTextDelta: (d) => deltas.push(d),
      onRunStatus: (p) => statuses.push(p),
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(deltas).toEqual(["done"]);
    expect(statuses[0]!.status).toBe("completed");
  });

  it("run.stopped ends the stream with stopped outcome", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'event: run.stopped\ndata: {"id":"r1","status":"stopped"}\n\n',
    ]);
    const deltas: string[] = [];
    const outcome = await consumeRunEvents(res, {
      onTextDelta: (d) => deltas.push(d),
    });
    expect(outcome).toEqual({ kind: "stopped" });
    expect(deltas).toEqual(["partial"]);
  });

  it("run.cancelled ends the stream with stopped outcome", async () => {
    const res = sseResponse([
      'event: run.cancelled\ndata: {"run_id":"r1","status":"cancelled"}\n\n',
    ]);
    const statuses: RunLifecyclePayload[] = [];
    const outcome = await consumeRunEvents(res, {
      onRunStatus: (p) => statuses.push(p),
    });
    expect(outcome).toEqual({ kind: "stopped" });
    expect(statuses[0]!.runId).toBe("r1");
    expect(statuses[0]!.status).toBe("cancelled");
  });

  it("run.failed ends the stream with error outcome and error message", async () => {
    const res = sseResponse([
      'event: run.failed\ndata: {"id":"r1","status":"failed","error":"tool crashed"}\n\n',
    ]);
    const statuses: RunLifecyclePayload[] = [];
    const outcome = await consumeRunEvents(res, {
      onRunStatus: (p) => statuses.push(p),
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toBe("tool crashed");
    }
    expect(statuses[0]!.error).toBe("tool crashed");
  });

  it("run.failed without error message uses generic message", async () => {
    const res = sseResponse([
      'event: run.failed\ndata: {"id":"r1","status":"failed"}\n\n',
    ]);
    const outcome = await consumeRunEvents(res, {});
    expect(outcome.kind).toBe("error");
  });

  it("run.completed takes precedence over later [DONE] — resolves once with ok", async () => {
    const res = sseResponse([
      'event: run.completed\ndata: {"id":"r1"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const onEnd = vi.fn();
    await consumeRunEvents(res, { onEnd });
    // onEnd must be called exactly once
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith({ kind: "ok" });
  });
});

// ---------------------------------------------------------------------------
// [DONE] sentinel (legacy / chat-compatible streams)
// ---------------------------------------------------------------------------

describe("consumeRunEvents — [DONE] sentinel", () => {
  it("resolves ok on [DONE] when no terminal run event precedes it", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const outcome = await consumeRunEvents(res, {});
    expect(outcome).toEqual({ kind: "ok" });
  });
});

// ---------------------------------------------------------------------------
// Stream interruptions and error paths
// ---------------------------------------------------------------------------

describe("consumeRunEvents — interruptions", () => {
  it("treats EOF before [DONE] and no terminal event as interrupted", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    ]);
    const outcome = await consumeRunEvents(res, {});
    expect(outcome.kind).toBe("interrupted");
  });

  it("maps user abort to stopped outcome", async () => {
    const { response, enqueue } = pendingSseResponse();
    enqueue('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');

    const ctrl = new AbortController();
    const done = consumeRunEvents(response, {}, ctrl.signal);
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    const outcome = await done;
    expect(outcome.kind).toBe("stopped");
  });

  it("returns error outcome on non-2xx HTTP status", async () => {
    const res = new Response("server exploded", { status: 500 });
    const onEnd = vi.fn();
    const outcome = await consumeRunEvents(res, { onEnd });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.status).toBe(500);
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", status: 500 }));
  });

  it("returns interrupted outcome when body is null", async () => {
    const res = new Response(null, { status: 200 });
    const outcome = await consumeRunEvents(res, {});
    expect(outcome.kind).toBe("interrupted");
  });
});

// ---------------------------------------------------------------------------
// onEnd callback wiring
// ---------------------------------------------------------------------------

describe("consumeRunEvents — onEnd callback", () => {
  it("calls onEnd with ok when resolved via [DONE]", async () => {
    const res = sseResponse(["data: [DONE]\n\n"]);
    const onEnd = vi.fn();
    const outcome = await consumeRunEvents(res, { onEnd });
    expect(onEnd).toHaveBeenCalledWith({ kind: "ok" });
    expect(outcome).toEqual({ kind: "ok" });
  });

  it("calls onEnd with stopped for run.stopped", async () => {
    const res = sseResponse([
      'event: run.stopped\ndata: {"id":"r1"}\n\n',
    ]);
    const onEnd = vi.fn();
    await consumeRunEvents(res, { onEnd });
    expect(onEnd).toHaveBeenCalledWith({ kind: "stopped" });
  });

  it("tolerates malformed JSON in delta frames without throwing", async () => {
    const res = sseResponse([
      "data: {not json}\n\n",
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const deltas: string[] = [];
    const outcome = await consumeRunEvents(res, { onTextDelta: (d) => deltas.push(d) });
    expect(outcome.kind).toBe("ok");
    expect(deltas).toEqual(["ok"]);
  });
});
