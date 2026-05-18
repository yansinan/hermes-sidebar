import { describe, it, expect, vi } from "vitest";
import { HermesApiClient, joinUrl } from "../src/api/client";
import { classifyHttpStatus } from "../src/api/errors";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("joinUrl", () => {
  it("joins base with a leading-slash path", () => {
    expect(joinUrl("https://h/", "/v1/models")).toBe("https://h/v1/models");
    expect(joinUrl("https://h", "v1/models")).toBe("https://h/v1/models");
  });
});

describe("HermesApiClient.listModels", () => {
  it("returns ids on 2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { object: "list", data: [{ id: "m1" }, { id: "m2" }] }),
    );
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await expect(c.listModels()).resolves.toEqual(["m1", "m2"]);
  });

  it("attaches Authorization when an api key is set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: [] }),
    );
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await c.listModels("sk-test");
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
  });

  it("throws an ApiError on 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: { message: "nope" } }),
    );
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await expect(c.listModels()).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
      message: "nope",
    });
  });
});

describe("HermesApiClient.checkHealth", () => {
  it("prefers /v1/health and caches the path", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    const r1 = await c.checkHealth();
    expect(r1.ok).toBe(true);
    expect(r1.path).toBe("/v1/health");
    await c.checkHealth();
    expect(fetchImpl.mock.calls[1]![0]).toMatch(/\/v1\/health$/);
  });

  it("falls back to /health on first 404", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    const r = await c.checkHealth();
    expect(r.ok).toBe(true);
    expect(r.path).toBe("/health");
  });

  it("reports a network error when fetch rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fail"));
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    const r = await c.checkHealth();
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("network");
  });
});

describe("HermesApiClient.completeOnce", () => {
  it("posts to /v1/chat/completions with idempotency key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: "m1",
        choices: [{ message: { role: "assistant", content: "hi" } }],
      }),
    );
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    const out = await c.completeOnce({
      model: "m1",
      messages: [{ role: "user", content: "hey" }],
      stream: false,
      apiKey: "sk",
      idempotencyKey: "ik-1",
    });
    expect(out.content).toBe("hi");
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk");
    expect(headers["Idempotency-Key"]).toBe("ik-1");
    expect(headers["Accept"]).toBe("application/json");
  });

  it("attaches X-Hermes-Session-Id when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ message: { role: "assistant", content: "hi" } }],
      }),
    );
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await c.completeOnce({
      model: "m1",
      messages: [{ role: "user", content: "hey" }],
      stream: false,
      serverSessionRef: "srv-1",
    });
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers["X-Hermes-Session-Id"]).toBe("srv-1");
  });
});

describe("classifyHttpStatus", () => {
  it("maps canonical statuses", () => {
    expect(classifyHttpStatus(400)).toBe("bad-request");
    expect(classifyHttpStatus(401)).toBe("unauthorized");
    expect(classifyHttpStatus(403)).toBe("forbidden");
    expect(classifyHttpStatus(404)).toBe("not-found");
    expect(classifyHttpStatus(408)).toBe("timeout");
    expect(classifyHttpStatus(429)).toBe("rate-limited");
    expect(classifyHttpStatus(500)).toBe("server-error");
  });
});

// ---------------------------------------------------------------------------
// Runs API
// ---------------------------------------------------------------------------

describe("HermesApiClient.createRun", () => {
  it("posts to /v1/runs and returns run_id + status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { run_id: "run-1", status: "started" }),
    );
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    const result = await c.createRun({
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.runId).toBe("run-1");
    expect(result.id).toBe("run-1");
    expect(result.status).toBe("started");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://h/v1/runs");
    expect((init.headers as Record<string, string>)["Content-Type"]).toContain(
      "application/json",
    );
  });

  it("attaches Authorization and Idempotency-Key when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { run_id: "run-2", status: "started" }),
    );
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await c.createRun({
      model: "m1",
      messages: [],
      apiKey: "sk-test",
      idempotencyKey: "ik-abc",
    });
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
    expect(headers["Idempotency-Key"]).toBe("ik-abc");
  });

  it("attaches session_id field when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { run_id: "run-3", status: "started" }),
    );
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await c.createRun({
      model: "m1",
      messages: [],
      sessionId: "my-session",
    });
    const body = JSON.parse(
      (fetchImpl.mock.calls[0]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body["session_id"]).toBe("my-session");
  });

  it("accepts legacy id in response for backward compatibility", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { id: "run-legacy", status: "queued" }),
    );
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    const result = await c.createRun({ model: "m1", messages: [] });
    expect(result.runId).toBe("run-legacy");
    expect(result.id).toBe("run-legacy");
  });

  it("throws ApiError on 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: { message: "bad key" } }),
    );
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await expect(
      c.createRun({ model: "m1", messages: [] }),
    ).rejects.toMatchObject({ kind: "unauthorized", status: 401 });
  });

  it("throws server-error when response body has no run id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await expect(
      c.createRun({ model: "m1", messages: [] }),
    ).rejects.toMatchObject({ kind: "server-error" });
  });
});

describe("HermesApiClient.openRunEvents", () => {
  it("issues GET /v1/runs/{id}/events with Accept: text/event-stream", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    const res = await c.openRunEvents("run-abc");
    expect(res.status).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://h/v1/runs/run-abc/events");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "text/event-stream",
    );
  });

  it("URL-encodes the run id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await c.openRunEvents("run/with spaces");
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("http://h/v1/runs/run%2Fwith%20spaces/events");
  });

  it("attaches Authorization when apiKey provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await c.openRunEvents("r1", { apiKey: "sk-x" });
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-x");
  });

  it("does not apply a timeout signal (callers own the signal)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    // No signal provided — the init should have no signal property.
    await c.openRunEvents("r1");
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeUndefined();
  });
});

describe("HermesApiClient.stopRun", () => {
  it("posts to /v1/runs/{id}/stop", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await expect(c.stopRun("run-1")).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://h/v1/runs/run-1/stop");
    expect(init.method).toBe("POST");
  });

  it("treats 404 as success (run already ended)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await expect(c.stopRun("run-gone")).resolves.toBeUndefined();
  });

  it("throws ApiError on 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: { message: "nope" } }),
    );
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await expect(c.stopRun("run-1")).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
    });
  });

  it("attaches Authorization when apiKey provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const c = new HermesApiClient({ baseUrl: "http://h", fetchImpl });
    await c.stopRun("run-1", { apiKey: "sk-y" });
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-y");
  });
});
