import { describe, it, expect, vi } from "vitest";
import { consumeChatStream, type ToolProgressPayload } from "../src/api/stream";

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
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const encoder = new TextEncoder();
  const response = new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
  return {
    response,
    enqueue: (text) => ctrl.enqueue(encoder.encode(text)),
    close: () => ctrl.close(),
  };
}

describe("consumeChatStream", () => {
  it("emits text deltas and resolves ok on [DONE]", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const deltas: string[] = [];
    const outcome = await consumeChatStream(res, {
      onTextDelta: (d) => deltas.push(d),
    });
    expect(outcome).toEqual({ kind: "ok" });
    expect(deltas.join("")).toBe("Hello");
  });

  it("surfaces hermes.tool.progress events", async () => {
    const res = sseResponse([
      'event: hermes.tool.progress\ndata: {"tool":"search","status":"running","toolCallId":"c1","label":"query docs"}\n\n',
      'event: hermes.tool.progress\ndata: {"tool":"search","status":"completed","toolCallId":"c1"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events: ToolProgressPayload[] = [];
    await consumeChatStream(res, {
      onToolProgress: (e) => events.push(e),
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.status).toBe("running");
    expect(events[0]!.label).toBe("query docs");
    expect(events[0]!.callId).toBe("c1");
    expect(events[1]!.status).toBe("completed");
  });

  it("normalizes legacy tool progress fields", async () => {
    const res = sseResponse([
      'event: hermes.tool.progress\ndata: {"tool":"search","status":"started","call_id":"c1"}\n\n',
      'event: hermes.tool.progress\ndata: {"tool":"search","status":"finished","call_id":"c1"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events: ToolProgressPayload[] = [];
    await consumeChatStream(res, {
      onToolProgress: (e) => events.push(e),
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.status).toBe("running");
    expect(events[1]!.status).toBe("completed");
  });

  it("treats EOF before [DONE] as interrupted", async () => {
    const res = sseResponse([
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
    ]);
    const outcome = await consumeChatStream(res, {});
    expect(outcome.kind).toBe("interrupted");
  });

  it("maps user abort to stopped", async () => {
    const { response, enqueue } = pendingSseResponse();
    const encoder = new TextEncoder();
    void encoder; // keep the import stable
    enqueue('data: {"choices":[{"delta":{"content":"He"}}]}\n\n');

    const ctrl = new AbortController();
    const donePromise = consumeChatStream(response, {}, ctrl.signal);
    // Give the reader a tick to pick up the first chunk, then abort.
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    const outcome = await donePromise;
    expect(outcome.kind).toBe("stopped");
  });

  it("returns an error outcome on non-2xx", async () => {
    const res = new Response("boom", { status: 500 });
    const onEnd = vi.fn();
    const outcome = await consumeChatStream(res, { onEnd });
    expect(outcome.kind).toBe("error");
    expect(onEnd).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error", status: 500 }),
    );
  });
});
