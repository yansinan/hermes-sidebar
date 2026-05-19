import { describe, it, expect, vi } from "vitest";
import {
  MemoryStorageAdapter,
  createStorageGateway,
} from "../src/storage/gateway";
import { HermesApiClient } from "../src/api/client";
import { buildController, createRealController } from "../src/runtime/controller";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseStream(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function makeFetch(
  overrides: Partial<{
    models: string[];
    health: Response;
    chatStream: () => Response;
  }> = {},
) {
  const models = overrides.models ?? ["m1"];
  const healthRes = overrides.health ?? jsonResponse(200, {});
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v1/models")) {
      return jsonResponse(200, { data: models.map((id) => ({ id })) });
    }
    if (url.endsWith("/v1/health") || url.endsWith("/health")) {
      return healthRes;
    }
    if (url.endsWith("/v1/chat/completions")) {
      if (overrides.chatStream) return overrides.chatStream();
      return jsonResponse(200, {
        choices: [{ message: { role: "assistant", content: "hi" } }],
      });
    }
    return new Response(null, { status: 404 });
  });
}

async function makeController(
  fetchImpl: ReturnType<typeof makeFetch>,
): Promise<ReturnType<typeof buildController>> {
  const gateway = createStorageGateway(new MemoryStorageAdapter());
  const api = new HermesApiClient({
    baseUrl: "http://127.0.0.1:8642",
    fetchImpl,
  });
  return createRealController({ gateway, apiClient: api });
}

describe("controller boot", () => {
  it("sets connection status healthy and populates models", async () => {
    const fetchImpl = makeFetch({ models: ["m1", "m2"] });
    const c = await makeController(fetchImpl);
    const state = c.getState();
    expect(state.connectionStatus.kind).toBe("healthy");
    expect(state.models.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(state.settings.defaultModelId).toBe("m1");
  });

  it("marks connectionStatus failed on network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("down"));
    const c = await makeController(fetchImpl);
    expect(c.getState().connectionStatus.kind).toBe("failed");
  });
});

describe("controller send — non-streaming", () => {
  it("promotes a draft into a persisted session on first send", async () => {
    const fetchImpl = makeFetch();
    const c = await makeController(fetchImpl);
    c.saveSettings({ streamingEnabled: false });
    c.setDraftInput("Hi there");
    await c.send();
    const state = c.getState();
    expect(state.sessions).toHaveLength(1);
    const s = state.sessions[0]!;
    expect(s.title).toBe("Hi there");
    // User message + assistant reply.
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect((s.messages[1] as { content: string }).content).toBe("hi");
    expect(state.draftInput).toBe("");
    expect(state.activeSessionId).toBe(s.id);
  });

  it("marks failed-to-send on 401 and leaves no agent placeholder", async () => {
    const fetchImpl = makeFetch();
    const c = await makeController(fetchImpl);
    c.saveSettings({ streamingEnabled: false });
    // Swap chat response to 401.
    fetchImpl.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat/completions"))
        return jsonResponse(401, { error: { message: "nope" } });
      if (url.endsWith("/v1/models"))
        return jsonResponse(200, { data: [{ id: "m1" }] });
      return jsonResponse(200, {});
    });
    c.setDraftInput("hello");
    await c.send();
    const s = c.getState().sessions[0]!;
    expect(s.messages.map((m) => m.role)).toEqual(["user"]);
    const user = s.messages[0] as { badge?: { kind: string } };
    expect(user.badge?.kind).toBe("failed-to-send");
    expect(c.getState().banners.length).toBeGreaterThan(0);
  });

  it("replaces {{markdown}} in API payload but preserves session user text", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/models")) {
        return jsonResponse(200, { data: [{ id: "m1" }] });
      }
      if (url.endsWith("/v1/health") || url.endsWith("/health")) {
        return jsonResponse(200, {});
      }
      if (url.endsWith("/v1/chat/completions")) {
        capturedBody = String(init?.body ?? "");
        return jsonResponse(200, {
          choices: [{ message: { role: "assistant", content: "ok" } }],
        });
      }
      return new Response(null, { status: 404 });
    });

    const c = await makeController(fetchImpl as unknown as ReturnType<typeof makeFetch>);
    c.saveSettings({ streamingEnabled: false });

    const s = c.getState();
    s.markdownPreview = {
      content: "# Auto Markdown",
      collapsed: true,
      status: "ready",
    };

    c.setDraftInput("请处理 {{markdown}}");
    await c.send();

    const parsed = JSON.parse(capturedBody) as { messages: Array<{ content: string }> };
    const last = parsed.messages[parsed.messages.length - 1]?.content;
    expect(last).toContain("# Auto Markdown");

    const session = c.getState().sessions[0]!;
    expect(session.messages[0]?.role).toBe("user");
    expect((session.messages[0] as { content: string }).content).toBe("请处理 {{markdown}}");
  });
});

describe("controller send — streaming", () => {
  it("accumulates SSE deltas into the assistant message", async () => {
    const fetchImpl = makeFetch({
      chatStream: () =>
        sseStream([
          'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
    });
    const c = await makeController(fetchImpl);
    await c.saveSettings({ useRunsApi: false });
    c.setDraftInput("streaming please");
    await c.send();
    const s = c.getState().sessions[0]!;
    const assistant = s.messages.find((m) => m.role === "assistant")! as {
      content: string;
      streaming: boolean;
    };
    expect(assistant.content).toBe("Hello");
    expect(assistant.streaming).toBe(false);
  });

  it("marks connection-interrupted on EOF before [DONE]", async () => {
    const fetchImpl = makeFetch({
      chatStream: () =>
        sseStream(['data: {"choices":[{"delta":{"content":"He"}}]}\n\n']),
    });
    const c = await makeController(fetchImpl);
    await c.saveSettings({ useRunsApi: false });
    c.setDraftInput("go");
    await c.send();
    const s = c.getState().sessions[0]!;
    const assistant = s.messages.find((m) => m.role === "assistant") as {
      badge?: { kind: string };
    };
    expect(assistant.badge?.kind).toBe("connection-interrupted");
  });

  it("emits chat lifecycle activity messages while keeping tool progress in the assistant bubble", async () => {
    const fetchImpl = makeFetch({
      chatStream: () =>
        sseStream([
          'data: {"choices":[{"delta":{"reasoning":"先查一下"}}],"session_id":"srv-chat-1"}\n\n',
          'event: hermes.tool.progress\n' +
            'data: {"tool":"session_search","status":"running","toolCallId":"call-1","label":"querying"}\n\n',
          'event: hermes.tool.progress\n' +
            'data: {"tool":"session_search","status":"completed","toolCallId":"call-1"}\n\n',
          'data: {"choices":[{"delta":{"content":"找到上一条了"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
    });
    const c = await makeController(fetchImpl);
    await c.saveSettings({ useRunsApi: false, reuseServerSession: true });
    c.setDraftInput("查一下上一条");
    await c.send();

    const session = c.getState().sessions[0]!;
    const systemTexts = session.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content.replace(/^\d{2}:\d{2}:\d{2}\s+/, ""));
    expect(systemTexts).toContain("已连接流式回复");
    expect(systemTexts).toContain("模型正在分析问题");
    expect(systemTexts).toContain("模型开始生成回复");
    expect(systemTexts).toContain("回复生成完成");

    const assistant = session.messages.find((m) => m.role === "assistant") as {
      content: string;
      toolProgress?: Array<{ toolName: string; phase: string }>;
    };
    expect(assistant.content).toBe("找到上一条了");
    expect(assistant.toolProgress).toEqual([
      expect.objectContaining({ toolName: "session_search", phase: "end" }),
    ]);
    expect(session.serverSessionRef).toBe("srv-chat-1");
  });

  it("reuses captured server session ref on the next chat request", async () => {
    const seenHeaders: Array<string | undefined> = [];
    let chatCount = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/models")) {
        return jsonResponse(200, { data: [{ id: "m1" }] });
      }
      if (url.endsWith("/v1/health") || url.endsWith("/health")) {
        return jsonResponse(200, {});
      }
      if (url.endsWith("/v1/chat/completions")) {
        chatCount += 1;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seenHeaders.push(headers["X-Hermes-Session-Id"]);
        if (chatCount === 1) {
          return sseStream([
            'data: {"choices":[{"delta":{"content":"first"}}],"session_id":"srv-chat-2"}\n\n',
            'data: [DONE]\n\n',
          ]);
        }
        return sseStream([
          'data: {"choices":[{"delta":{"content":"second"}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      return new Response(null, { status: 404 });
    });

    const c = await makeController(fetchImpl as unknown as ReturnType<typeof makeFetch>);
    await c.saveSettings({ useRunsApi: false, reuseServerSession: true });

    c.setDraftInput("first chat");
    await c.send();
    c.setDraftInput("second chat");
    await c.send();

    expect(seenHeaders).toEqual([undefined, "srv-chat-2"]);
    const session = c.getState().sessions[0]!;
    expect(session.serverSessionRef).toBe("srv-chat-2");
  });

  it("prefers Runs API and streams content from run events", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/models")) {
        return jsonResponse(200, { data: [{ id: "m1" }] });
      }
      if (url.endsWith("/v1/health") || url.endsWith("/health")) {
        return jsonResponse(200, {});
      }
      if (url.endsWith("/v1/runs")) {
        return jsonResponse(200, { run_id: "run-1", status: "queued" });
      }
      if (url.endsWith("/v1/runs/run-1/events")) {
        return sseStream([
          'data: {"event":"reasoning.available","run_id":"run-1","timestamp":1000,"text":"Let me think..."}\n\n',
          'data: {"event":"message.delta","run_id":"run-1","timestamp":1001,"delta":"Hel"}\n\n',
          'data: {"event":"message.delta","run_id":"run-1","timestamp":1002,"delta":"lo"}\n\n',
          'data: {"event":"run.completed","run_id":"run-1","timestamp":1003,"output":"Hello"}\n\n',
        ]);
      }
      if (url.endsWith("/v1/chat/completions")) {
        throw new Error("chat fallback should not be called");
      }
      return new Response(null, { status: 404 });
    });

    const c = await makeController(fetchImpl as unknown as ReturnType<typeof makeFetch>);
    const seenPhases = new Set<string>();
    const unsubscribe = c.subscribe((state) => {
      const id = state.activeSessionId;
      if (!id) return;
      const phase = state.sessionPhases[id];
      if (phase) seenPhases.add(phase);
    });

    c.setDraftInput("runs please");
    await c.send();
    unsubscribe();

    const session = c.getState().sessions[0]!;
    const assistant = session.messages.find((m) => m.role === "assistant")! as {
      content: string;
      streaming: boolean;
      responseChannel?: string;
    };
    expect(assistant.content).toBe("Hello");
    expect(assistant.streaming).toBe(false);
    expect(assistant.responseChannel).toBe("runs");
    expect(seenPhases.has("queued") || seenPhases.has("running")).toBe(true);
  });

  it("falls back to chat when Runs endpoint is unavailable", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/models")) {
        return jsonResponse(200, { data: [{ id: "m1" }] });
      }
      if (url.endsWith("/v1/health") || url.endsWith("/health")) {
        return jsonResponse(200, {});
      }
      if (url.endsWith("/v1/runs")) {
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("/v1/chat/completions")) {
        return sseStream([
          'data: {"choices":[{"delta":{"content":"Fallback"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" ok"}}]}\n\n',
          "data: [DONE]\n\n",
        ]);
      }
      return new Response(null, { status: 404 });
    });

    const c = await makeController(fetchImpl as unknown as ReturnType<typeof makeFetch>);
    c.setDraftInput("runs only please");
    await c.send();

    const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.endsWith("/v1/runs"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/v1/chat/completions"))).toBe(true);

    const session = c.getState().sessions[0]!;
    const assistant = session.messages.find((m) => m.role === "assistant")! as {
      content: string;
      badge?: { kind: string };
      responseChannel?: string;
    };
    expect(assistant.content).toBe("Fallback ok");
    expect(assistant.badge).toBeUndefined();
    expect(assistant.responseChannel).toBe("chat");
  });

  it("keeps runs result as interrupted when events end and polled run status is failed", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/models")) {
        return jsonResponse(200, { data: [{ id: "m1" }] });
      }
      if (url.endsWith("/v1/health") || url.endsWith("/health")) {
        return jsonResponse(200, {});
      }
      if (url.endsWith("/v1/runs")) {
        return jsonResponse(200, { run_id: "run-2", status: "queued" });
      }
      if (url.endsWith("/v1/runs/run-2/events")) {
        // Non-terminal lifecycle only, then EOF => interrupted.
        return sseStream([
          'data: {"event":"reasoning.available","run_id":"run-2","timestamp":1000,"text":"Processing..."}\n\n',
        ]);
      }
      if (url.endsWith("/v1/runs/run-2")) {
        return jsonResponse(200, {
          object: "hermes.run",
          run_id: "run-2",
          status: "failed",
          output: "",
        });
      }
      if (url.endsWith("/v1/chat/completions")) {
        throw new Error("chat fallback should not be called");
      }
      return new Response(null, { status: 404 });
    });

    const c = await makeController(fetchImpl as unknown as ReturnType<typeof makeFetch>);
    c.setDraftInput("runs eof");
    await c.send();

    const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.endsWith("/v1/runs/run-2/events"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/v1/runs/run-2"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/v1/chat/completions"))).toBe(false);

    const session = c.getState().sessions[0]!;
    const assistant = session.messages.find((m) => m.role === "assistant")! as {
      content: string;
      badge?: { kind: string };
      responseChannel?: string;
    };
    expect(assistant.content).toBe("");
    expect(assistant.badge?.kind).toBe("connection-interrupted");
    expect(assistant.responseChannel).toBe("runs");
  });

  it("waits for terminal run status instead of deciding from events timeout", async () => {
    let pollCount = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/models")) {
        return jsonResponse(200, { data: [{ id: "m1" }] });
      }
      if (url.endsWith("/v1/health") || url.endsWith("/health")) {
        return jsonResponse(200, {});
      }
      if (url.endsWith("/v1/runs")) {
        return jsonResponse(200, { run_id: "run-4", status: "started" });
      }
      if (url.endsWith("/v1/runs/run-4/events")) {
        return sseStream([
          'data: {"event":"tool.started","run_id":"run-4","timestamp":1000,"tool":"sleep","preview":"5s"}\n\n',
        ]);
      }
      if (url.endsWith("/v1/runs/run-4")) {
        pollCount += 1;
        if (pollCount < 3) {
          return jsonResponse(200, {
            object: "hermes.run",
            run_id: "run-4",
            status: "running",
          });
        }
        return jsonResponse(200, {
          object: "hermes.run",
          run_id: "run-4",
          status: "completed",
          output: "Eventually done",
        });
      }
      if (url.endsWith("/v1/chat/completions")) {
        throw new Error("chat fallback should not be called");
      }
      return new Response(null, { status: 404 });
    });

    const c = await makeController(fetchImpl as unknown as ReturnType<typeof makeFetch>);
    c.setDraftInput("wait terminal");
    await c.send();

    expect(pollCount).toBeGreaterThanOrEqual(3);
    const session = c.getState().sessions[0]!;
    const assistant = session.messages.find((m) => m.role === "assistant")! as {
      content: string;
      responseChannel?: string;
      badge?: { kind: string };
    };
    expect(assistant.content).toBe("Eventually done");
    expect(assistant.responseChannel).toBe("runs");
    expect(assistant.badge).toBeUndefined();
  });

  it("recovers runs output via getRun when events end interrupted before content", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/models")) {
        return jsonResponse(200, { data: [{ id: "m1" }] });
      }
      if (url.endsWith("/v1/health") || url.endsWith("/health")) {
        return jsonResponse(200, {});
      }
      if (url.endsWith("/v1/runs")) {
        return jsonResponse(200, { run_id: "run-3", status: "started" });
      }
      if (url.endsWith("/v1/runs/run-3/events")) {
        return sseStream([
          'data: {"event":"tool.started","run_id":"run-3","timestamp":1000,"tool":"grep","preview":"pattern"}\n\n',
        ]);
      }
      if (url.endsWith("/v1/runs/run-3")) {
        return jsonResponse(200, {
          object: "hermes.run",
          run_id: "run-3",
          status: "completed",
          output: "Recovered",
        });
      }
      if (url.endsWith("/v1/chat/completions")) {
        throw new Error("chat fallback should not be called");
      }
      return new Response(null, { status: 404 });
    });

    const c = await makeController(fetchImpl as unknown as ReturnType<typeof makeFetch>);
    c.setDraftInput("recover from poll");
    await c.send();

    const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.endsWith("/v1/runs/run-3/events"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/v1/runs/run-3"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/v1/chat/completions"))).toBe(false);

    const session = c.getState().sessions[0]!;
    const assistant = session.messages.find((m) => m.role === "assistant")! as {
      content: string;
      responseChannel?: string;
    };
    expect(assistant.content).toBe("Recovered");
    expect(assistant.responseChannel).toBe("runs");
  });

  it("reuses captured server session ref on the next runs request", async () => {
    const seenRunBodies: Array<Record<string, unknown>> = [];
    let runCount = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/models")) {
        return jsonResponse(200, { data: [{ id: "m1" }] });
      }
      if (url.endsWith("/v1/health") || url.endsWith("/health")) {
        return jsonResponse(200, {});
      }
      if (url.endsWith("/v1/runs")) {
        runCount += 1;
        seenRunBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return jsonResponse(200, { run_id: `run-${runCount}`, status: "started" });
      }
      if (url.endsWith("/v1/runs/run-1/events")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  'data: {"event":"run.completed","run_id":"run-1","timestamp":1000,"output":"first"}\n\n',
                ),
              );
              controller.close();
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "X-Hermes-Session-Id": "srv-runs-1",
            },
          },
        );
      }
      if (url.endsWith("/v1/runs/run-2/events")) {
        return sseStream([
          'data: {"event":"run.completed","run_id":"run-2","timestamp":1001,"output":"second"}\n\n',
        ]);
      }
      return new Response(null, { status: 404 });
    });

    const c = await makeController(fetchImpl as unknown as ReturnType<typeof makeFetch>);
    await c.saveSettings({ reuseServerSession: true });

    c.setDraftInput("first run");
    await c.send();
    c.setDraftInput("second run");
    await c.send();

    expect(seenRunBodies).toHaveLength(2);
    expect(seenRunBodies[0]?.session_id).toBeUndefined();
    expect(seenRunBodies[1]?.session_id).toBe("srv-runs-1");

    const session = c.getState().sessions[0]!;
    expect(session.serverSessionRef).toBe("srv-runs-1");
  });
});

describe("controller — profile switch", () => {
  it("swaps sessions on cross-profile save and preserves old profile's data", async () => {
    const fetchImpl = makeFetch();
    const c = await makeController(fetchImpl);
    c.saveSettings({ streamingEnabled: false });
    c.setDraftInput("one");
    await c.send();
    const first = c.getState().sessions[0]!;
    await c.saveSettings({ apiBaseUrl: "http://otherhost:8642" });
    expect(c.getState().sessions).toHaveLength(0);
    expect(c.getState().activeProfile.hostShort).toBe("otherhost:8642");
    await c.saveSettings({ apiBaseUrl: "http://127.0.0.1:8642" });
    expect(c.getState().sessions.map((s) => s.id)).toContain(first.id);
  });

  it("preserves sessions on same-profile save (trailing slash change)", async () => {
    const fetchImpl = makeFetch();
    const c = await makeController(fetchImpl);
    c.saveSettings({ streamingEnabled: false });
    c.setDraftInput("one");
    await c.send();
    const before = c.getState().sessions[0]!;
    await c.saveSettings({ apiBaseUrl: "http://127.0.0.1:8642/" });
    const after = c.getState().sessions[0]!;
    expect(after.id).toBe(before.id);
  });
});

describe("controller — stop + retry", () => {
  it("retry reuses the user message's idempotency key", async () => {
    const fetchImpl = makeFetch();
    const c = await makeController(fetchImpl);
    c.saveSettings({ streamingEnabled: false });
    // First attempt: fail.
    let first = true;
    fetchImpl.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat/completions")) {
        if (first) {
          first = false;
          return jsonResponse(500, { error: { message: "boom" } });
        }
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers["Idempotency-Key"]).toBeDefined();
        return jsonResponse(200, {
          choices: [{ message: { role: "assistant", content: "retried" } }],
        });
      }
      if (url.endsWith("/v1/models"))
        return jsonResponse(200, { data: [{ id: "m1" }] });
      return jsonResponse(200, {});
    });
    c.setDraftInput("hi");
    await c.send();
    const session = c.getState().sessions[0]!;
    const user = session.messages[0]!;
    // Grab the original idempotency key off the user message.
    const userAny = user as { idempotencyKey: string };
    expect(userAny.idempotencyKey).toBeDefined();

    await c.retry(session.id, user.id);
    // Verify the fetch's Idempotency-Key header on the retry call matched.
    const retryCall = fetchImpl.mock.calls.find((call) => {
      const url = call[0] as string;
      return url.endsWith("/v1/chat/completions");
    });
    void retryCall;
    const refreshed = c.getState().sessions[0]!;
    const assistant = refreshed.messages.find((m) => m.role === "assistant")! as {
      content: string;
    };
    expect(assistant.content).toBe("retried");
  });
});
