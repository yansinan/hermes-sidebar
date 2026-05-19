import { describe, it, expect, vi } from "vitest";
import { consumeRunEvents } from "../src/api/runs";

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
// ---------------------------------------------------------------------------
// Tool lifecycle events
// ---------------------------------------------------------------------------

describe("consumeRunEvents — tool lifecycle", () => {
  it("emits tool.started and tool.completed events", async () => {
    const res = sseResponse([
      'data: {"event":"tool.started","run_id":"r1","timestamp":1000,"tool":"terminal","preview":"ls -la"}\n\n',
      'data: {"event":"tool.completed","run_id":"r1","timestamp":1001,"tool":"terminal","duration":0.5,"error":false}\n\n',
      'data: {"event":"run.completed","run_id":"r1","timestamp":1002,"output":"result","usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30}}\n\n',
    ]);
    const toolStarts: string[] = [];
    const toolCompletes: string[] = [];
    const outputs: string[] = [];
    const outcome = await consumeRunEvents(res, {
      onToolStarted: (p) => toolStarts.push(p.tool),
      onToolCompleted: (p) => toolCompletes.push(p.tool),
      onRunCompleted: (p) => outputs.push(p.output),
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(toolStarts).toEqual(["terminal"]);
    expect(toolCompletes).toEqual(["terminal"]);
    expect(outputs).toEqual(["result"]);
  });

  it("captures tool preview and duration", async () => {
    const res = sseResponse([
      'data: {"event":"tool.started","run_id":"r1","timestamp":1000,"tool":"bash","preview":"echo test"}\n\n',
      'data: {"event":"tool.completed","run_id":"r1","timestamp":1001,"tool":"bash","duration":0.123,"error":false}\n\n',
      'data: {"event":"run.completed","run_id":"r1","timestamp":1002,"output":"done","usage":{"input_tokens":5,"output_tokens":10,"total_tokens":15}}\n\n',
    ]);
    let captured: { preview?: string; duration: number } = { duration: 0 };
    await consumeRunEvents(res, {
      onToolStarted: (p) => { captured.preview = p.preview; },
      onToolCompleted: (p) => { captured.duration = p.duration; },
    });
    expect(captured.preview).toBe("echo test");
    expect(captured.duration).toBe(0.123);
  });
});

// ---------------------------------------------------------------------------
// Reasoning available
// ---------------------------------------------------------------------------

describe("consumeRunEvents — reasoning", () => {
  it("emits reasoning.available events", async () => {
    const res = sseResponse([
      'data: {"event":"reasoning.available","run_id":"r1","timestamp":1000,"text":"Let me think..."}\n\n',
      'data: {"event":"run.completed","run_id":"r1","timestamp":1002,"output":"answer"}\n\n',
    ]);
    const reasonings: string[] = [];
    await consumeRunEvents(res, {
      onReasoningAvailable: (p) => reasonings.push(p.text),
    });
    expect(reasonings).toEqual(["Let me think..."]);
  });
});

// ---------------------------------------------------------------------------
// Message delta
// ---------------------------------------------------------------------------

describe("consumeRunEvents — message delta", () => {
  it("emits message.delta chunks for streaming output", async () => {
    const res = sseResponse([
      'data: {"event":"message.delta","run_id":"r1","timestamp":1000,"delta":"Hel"}\n\n',
      'data: {"event":"message.delta","run_id":"r1","timestamp":1001,"delta":"lo"}\n\n',
      'data: {"event":"run.completed","run_id":"r1","timestamp":1002,"output":"Hello"}\n\n',
    ]);
    const deltas: string[] = [];
    const outcome = await consumeRunEvents(res, {
      onMessageDelta: (p) => deltas.push(p.delta),
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(deltas.join("")).toBe("Hello");
  });

  it("captures server session ref from event-stream headers", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            'data: {"event":"run.completed","run_id":"r1","timestamp":1002,"output":"Hello"}\n\n',
          ),
        );
        controller.close();
      },
    });
    const res = new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Hermes-Session-Id": "srv-runs-1",
      },
    });
    const refs: string[] = [];
    await consumeRunEvents(res, {
      onServerSessionRef: (ref) => refs.push(ref),
    });
    expect(refs).toEqual(["srv-runs-1"]);
  });
});

// ---------------------------------------------------------------------------
// Run completion with output and usage
// ---------------------------------------------------------------------------

describe("consumeRunEvents — run completion", () => {
  it("emits run.completed with output and token usage", async () => {
    const res = sseResponse([
      'data: {"event":"run.completed","run_id":"r1","timestamp":1000,"output":"Final answer","usage":{"input_tokens":150,"output_tokens":320,"total_tokens":470}}\n\n',
    ]);
    let payload: any;
    const outcome = await consumeRunEvents(res, {
      onRunCompleted: (p) => { payload = p; },
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(payload.output).toBe("Final answer");
    expect(payload.usage?.total_tokens).toBe(470);
  });
});

// ---------------------------------------------------------------------------
// Run failure
// ---------------------------------------------------------------------------

describe("consumeRunEvents — run failure", () => {
  it("emits run.failed with error message", async () => {
    const res = sseResponse([
      'data: {"event":"run.failed","run_id":"r1","timestamp":1000,"error":"agent crashed"}\n\n',
    ]);
    let status: any;
    const outcome = await consumeRunEvents(res, {
      onRunStatus: (p) => { status = p; },
    });
    expect(outcome.kind).toBe("error");
    expect(status.status).toBe("failed");
    expect(status.error).toBe("agent crashed");
  });
});

// ---------------------------------------------------------------------------
// Run cancellation
// ---------------------------------------------------------------------------

describe("consumeRunEvents — run cancellation", () => {
  it("emits run.cancelled on stop request", async () => {
    const res = sseResponse([
      'data: {"event":"run.cancelled","run_id":"r1","timestamp":1000}\n\n',
    ]);
    let status: any;
    const outcome = await consumeRunEvents(res, {
      onRunStatus: (p) => { status = p; },
    });
    expect(outcome.kind).toBe("stopped");
    expect(status.status).toBe("cancelled");
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
  it("calls onEnd with ok when stream closes normally", async () => {
    const res = sseResponse([
      'data: {"event":"run.completed","run_id":"r1","timestamp":1000,"output":"done"}\n\n',
      ":\n\n", // stream closed marker
    ]);
    const onEnd = vi.fn();
    const outcome = await consumeRunEvents(res, { onEnd });
    expect(onEnd).toHaveBeenCalledWith({ kind: "ok" });
    expect(outcome).toEqual({ kind: "ok" });
  });
});

// ---------------------------------------------------------------------------
// Unknown event types (capture-all observability)
// ---------------------------------------------------------------------------

describe("consumeRunEvents — unknown event types", () => {
  it("emits unknown event types via onUnknownEvent", async () => {
    const res = sseResponse([
      'data: {"event":"custom.event","run_id":"r1","timestamp":1000,"data":"value"}\n\n',
      'data: {"event":"hermes.custom","run_id":"r1","timestamp":1001,"custom":"payload"}\n\n',
      'data: {"event":"run.completed","run_id":"r1","timestamp":1002,"output":"done"}\n\n',
    ]);
    const unknownEvents: Array<{ name: string; data: string }> = [];
    const outcome = await consumeRunEvents(res, {
      onUnknownEvent: (name, data) => unknownEvents.push({ name, data }),
    });
    expect(outcome.kind).toBe("ok");
    expect(unknownEvents).toEqual([
      { name: "custom.event", data: '{"event":"custom.event","run_id":"r1","timestamp":1000,"data":"value"}' },
      { name: "hermes.custom", data: '{"event":"hermes.custom","run_id":"r1","timestamp":1001,"custom":"payload"}' },
    ]);
  });

  it("does not emit unknown events if onUnknownEvent is not provided", async () => {
    const res = sseResponse([
      'data: {"event":"unknown.thing","run_id":"r1","timestamp":1000,"data":"ignored"}\n\n',
      'data: {"event":"run.completed","run_id":"r1","timestamp":1001,"output":"done"}\n\n',
    ]);
    const outcome = await consumeRunEvents(res, {});
    expect(outcome.kind).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Explicit SSE event names
// ---------------------------------------------------------------------------

describe("consumeRunEvents — explicit SSE event names", () => {
  it("handles explicit run lifecycle events and terminal completion", async () => {
    const res = sseResponse([
      'event: run.queued\n' + 'data: {"run_id":"r1","timestamp":1000}\n\n',
      'event: run.running\n' + 'data: {"run_id":"r1","timestamp":1001}\n\n',
      'event: run.completed\n' +
        'data: {"run_id":"r1","timestamp":1002,"output":"ok"}\n\n',
    ]);

    const statuses: string[] = [];
    const outputs: string[] = [];
    const outcome = await consumeRunEvents(res, {
      onRunStatus: (p) => statuses.push(p.status),
      onRunCompleted: (p) => outputs.push(p.output),
    });

    expect(outcome).toEqual({ kind: "ok" });
    expect(statuses).toEqual(["queued", "running"]);
    expect(outputs).toEqual(["ok"]);
  });

  it("maps explicit hermes.tool.progress to tool started/completed", async () => {
    const res = sseResponse([
      'event: hermes.tool.progress\n' +
        'data: {"run_id":"r1","timestamp":1000,"tool":"session_search","status":"running","label":"querying"}\n\n',
      'event: hermes.tool.progress\n' +
        'data: {"run_id":"r1","timestamp":1001,"tool":"session_search","status":"completed"}\n\n',
      'event: run.completed\n' +
        'data: {"run_id":"r1","timestamp":1002,"output":"done"}\n\n',
    ]);

    const starts: string[] = [];
    const ends: string[] = [];
    const outcome = await consumeRunEvents(res, {
      onToolStarted: (p) => starts.push(`${p.tool}:${p.preview ?? ""}`),
      onToolCompleted: (p) => ends.push(p.tool),
    });

    expect(outcome.kind).toBe("ok");
    expect(starts).toEqual(["session_search:querying"]);
    expect(ends).toEqual(["session_search"]);
  });

  it("treats comment stream closed as a normal terminal marker", async () => {
    const res = sseResponse([
      'data: {"event":"run.completed","run_id":"r1","timestamp":1000,"output":"done"}\n\n',
      ': stream closed\n\n',
    ]);

    const outcome = await consumeRunEvents(res, {});
    expect(outcome).toEqual({ kind: "ok" });
  });

  it("maps approval.request/responded to waiting_for_approval then running", async () => {
    const res = sseResponse([
      'data: {"event":"approval.request","run_id":"r1","timestamp":1000,"prompt":"Allow?","choices":["once","deny"]}\n\n',
      'data: {"event":"approval.responded","run_id":"r1","timestamp":1001,"choice":"once","resolved":1}\n\n',
      'data: {"event":"run.completed","run_id":"r1","timestamp":1002,"output":"done"}\n\n',
    ]);

    const statuses: string[] = [];
    const unknownEvents: string[] = [];
    const outcome = await consumeRunEvents(res, {
      onRunStatus: (p) => statuses.push(p.status),
      onUnknownEvent: (name) => unknownEvents.push(name),
    });

    expect(outcome.kind).toBe("ok");
    expect(statuses).toEqual(["waiting_for_approval", "running"]);
    expect(unknownEvents).toEqual(["approval.request", "approval.responded"]);
  });
});
