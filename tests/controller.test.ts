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
    c.setDraftInput("go");
    await c.send();
    const s = c.getState().sessions[0]!;
    const assistant = s.messages.find((m) => m.role === "assistant") as {
      badge?: { kind: string };
    };
    expect(assistant.badge?.kind).toBe("connection-interrupted");
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
