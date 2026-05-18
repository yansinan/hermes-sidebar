// Hermes API client (docs/api-contract.md §3–§8; docs/architecture.md §3.8).
//
// One module that speaks the wire contract:
//  - POST /v1/chat/completions (streaming + non-streaming)
//  - GET  /v1/models
//  - GET  /v1/health (with fallback to GET /health on first-ever 404)
//
// The client never deletes local state on error and never retries
// automatically. Retries are always user-initiated (§4.4).

import type { Message } from "../shared/types/message";
import {
  classifyHttpStatus,
  extractShortMessage,
  type ApiError,
} from "./errors";

export interface ChatWireMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatWireMessage[];
  stream: boolean;
  /** Optional bearer token. Undefined or empty string → no Authorization header. */
  apiKey?: string;
  /** Optional idempotency key, attached as `Idempotency-Key`. */
  idempotencyKey?: string;
  /** Optional server-session id, attached as `X-Hermes-Session-Id`. */
  serverSessionRef?: string;
  signal?: AbortSignal;
}

export interface ModelListResponse {
  data: { id: string }[];
}

export type HealthPath = "/v1/health" | "/health";

export interface HealthResult {
  ok: boolean;
  status?: number;
  /** Which path actually produced the response, for caching in the caller. */
  path: HealthPath;
  error?: ApiError;
}

/** Convert `UserMessage`/`AssistantMessage`/`SystemMessage` into wire shape. */
export function toWireMessages(messages: Message[]): ChatWireMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/** Join a base URL and a path, preserving any base URL path prefix. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

type FetchFn = typeof fetch;

export interface HermesApiClientOptions {
  baseUrl: string;
  fetchImpl?: FetchFn;
  /** Per-request non-streaming timeout in ms. Default 60s (§4.4). */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Runs API types (Hermes-specific: POST /v1/runs, GET /v1/runs/{id}/events,
// POST /v1/runs/{id}/stop).
// ---------------------------------------------------------------------------

export type RunStatus =
  | "started"
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped";

export interface CreateRunRequest {
  model?: string;
  messages?: ChatWireMessage[];
  /** Preferred by current Hermes docs. */
  input?: string;
  /** Optional Bearer token. */
  apiKey?: string;
  /** AbortSignal to cancel the HTTP call (not the run itself). */
  signal?: AbortSignal;
  /** Legacy alias used by earlier migration notes. */
  conversation?: string;
  /** Canonical docs field for server-side session correlation. */
  sessionId?: string;
  instructions?: string;
  previousResponseId?: string;
  conversationHistory?: ChatWireMessage[];
  /** Echo back a previously captured server session id. */
  serverSessionRef?: string;
  /** Idempotency key forwarded as Idempotency-Key header. */
  idempotencyKey?: string;
}

export interface RunCreatedResponse {
  /** Opaque run identifier used to subscribe to events and stop the run. */
  runId: string;
  /** Backward-compatible alias for existing call sites. */
  id: string;
  status: RunStatus;
}

export interface OpenRunEventsOptions {
  apiKey?: string;
  /** Caller-supplied AbortSignal. No server-level timeout is applied. */
  signal?: AbortSignal;
}

export interface StopRunOptions {
  apiKey?: string;
}

export class HermesApiClient {
  private baseUrl: string;
  private readonly fetchImpl: FetchFn;
  private readonly timeoutMs: number;
  private healthPath: HealthPath | null = null;

  constructor(opts: HermesApiClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** Swap the endpoint. Resets the cached health path. */
  setBaseUrl(baseUrl: string): void {
    if (baseUrl !== this.baseUrl) {
      this.baseUrl = baseUrl;
      this.healthPath = null;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * GET /v1/models. Returns the raw list on success; on error throws an
   * `ApiError`-shaped object.
   */
  async listModels(apiKey?: string, signal?: AbortSignal): Promise<string[]> {
    const res = await this.request("/v1/models", {
      method: "GET",
      apiKey,
      signal,
      accept: "application/json",
    });
    if (!res.ok) throw await this.toApiError(res);
    const body = (await res.json()) as ModelListResponse;
    if (!body || !Array.isArray(body.data)) return [];
    return body.data.map((d) => d.id).filter((id) => typeof id === "string");
  }

  /**
   * Liveness check. Prefers `/v1/health`; falls back to `/health` on 404 once
   * per endpoint, caching the winning path.
   */
  async checkHealth(apiKey?: string, signal?: AbortSignal): Promise<HealthResult> {
    const order: HealthPath[] = this.healthPath
      ? [this.healthPath]
      : ["/v1/health", "/health"];
    let lastErr: ApiError | undefined;
    for (const path of order) {
      try {
        const res = await this.request(path, {
          method: "GET",
          apiKey,
          signal,
          accept: "application/json",
        });
        if (res.ok) {
          this.healthPath = path;
          return { ok: true, status: res.status, path };
        }
        // Only fall through on the very first 404 on /v1/health.
        if (
          res.status === 404 &&
          path === "/v1/health" &&
          this.healthPath === null
        ) {
          lastErr = await this.toApiError(res);
          continue;
        }
        const err = await this.toApiError(res);
        this.healthPath = path;
        return { ok: false, status: res.status, path, error: err };
      } catch (e) {
        lastErr = toNetworkError(e);
      }
    }
    return {
      ok: false,
      path: order[order.length - 1]!,
      ...(lastErr ? { error: lastErr } : {}),
    };
  }

  /**
   * Non-streaming POST /v1/chat/completions. Returns the assistant message
   * content plus the recorded model id.
   */
  async completeOnce(
    req: ChatCompletionsRequest,
  ): Promise<{ content: string; model: string; serverSessionRef?: string }> {
    const res = await this.postChatCompletions(req);
    if (!res.ok) throw await this.toApiError(res);
    const body = (await res.json()) as {
      model?: string;
      choices?: { message?: { role?: string; content?: string } }[];
    };
    const choice = body?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      const err: ApiError = { kind: "server-error", message: "malformed response" };
      throw err;
    }
    const serverSessionRef = this.extractServerSessionRef(res);
    return {
      content,
      model: body.model ?? req.model,
      ...(serverSessionRef ? { serverSessionRef } : {}),
    };
  }

  /**
   * Streaming POST /v1/chat/completions. Returns the raw `Response`; the caller
   * (stream handler) reads and parses the body. On a non-2xx status the
   * response is returned unread so callers can still extract an error body.
   */
  async openChatStream(req: ChatCompletionsRequest): Promise<Response> {
    return this.postChatCompletions(req);
  }

  // ---- Runs API -----------------------------------------------------------

  /**
   * POST /v1/runs — create an agent run and return the run id + initial status.
   * On non-2xx throws an `ApiError`-shaped object.
   */
  async createRun(req: CreateRunRequest): Promise<RunCreatedResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
    };
    if (req.apiKey && req.apiKey.length > 0) {
      headers["Authorization"] = `Bearer ${req.apiKey}`;
    }
    if (req.idempotencyKey) {
      headers["Idempotency-Key"] = req.idempotencyKey;
    }
    if (req.serverSessionRef) {
      headers["X-Hermes-Session-Id"] = req.serverSessionRef;
    }
    const bodyObj: Record<string, unknown> = {};
    if (req.input && req.input.length > 0) {
      bodyObj["input"] = req.input;
    } else if (Array.isArray(req.messages)) {
      const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
      bodyObj["input"] = lastUser?.content ?? "";
    }
    if (req.model) bodyObj["model"] = req.model;
    if (Array.isArray(req.messages)) bodyObj["messages"] = req.messages;
    if (req.sessionId) bodyObj["session_id"] = req.sessionId;
    if (req.instructions) bodyObj["instructions"] = req.instructions;
    if (req.previousResponseId) {
      bodyObj["previous_response_id"] = req.previousResponseId;
    }
    if (Array.isArray(req.conversationHistory)) {
      bodyObj["conversation_history"] = req.conversationHistory;
    }
    if (req.conversation) bodyObj["conversation"] = req.conversation;
    const signal = req.signal ?? this.makeTimeoutSignal();
    const res = await this.fetchImpl(joinUrl(this.baseUrl, "/v1/runs"), {
      method: "POST",
      headers,
      body: JSON.stringify(bodyObj),
      credentials: "omit",
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw await this.toApiError(res);
    const body = (await res.json()) as {
      id?: unknown;
      run_id?: unknown;
      status?: unknown;
    };
    const runId =
      typeof body?.run_id === "string"
        ? body.run_id
        : typeof body?.id === "string"
          ? body.id
          : undefined;
    if (typeof runId !== "string") {
      throw { kind: "server-error", message: "runs response missing run_id" } as const;
    }
    return {
      runId,
      id: runId,
      status: (body.status as RunStatus) ?? "started",
    };
  }

  /**
   * GET /v1/runs/{runId}/events — open the SSE event stream for a run.
   * Returns the raw `Response`; the caller (runs event consumer) reads it.
   * No server-level timeout is applied; the caller provides an AbortSignal.
   */
  async openRunEvents(
    runId: string,
    opts: OpenRunEventsOptions = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
    };
    if (opts.apiKey && opts.apiKey.length > 0) {
      headers["Authorization"] = `Bearer ${opts.apiKey}`;
    }
    return this.fetchImpl(
      joinUrl(this.baseUrl, `/v1/runs/${encodeURIComponent(runId)}/events`),
      {
        method: "GET",
        headers,
        credentials: "omit",
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
  }

  /**
   * POST /v1/runs/{runId}/stop — request the server to stop an in-progress run.
   * Best-effort: throws on network failure but does not throw on 404 (run may
   * have already finished).
   */
  async stopRun(runId: string, opts: StopRunOptions = {}): Promise<void> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (opts.apiKey && opts.apiKey.length > 0) {
      headers["Authorization"] = `Bearer ${opts.apiKey}`;
    }
    const res = await this.fetchImpl(
      joinUrl(this.baseUrl, `/v1/runs/${encodeURIComponent(runId)}/stop`),
      {
        method: "POST",
        headers,
        credentials: "omit",
        signal: this.makeTimeoutSignal(),
      },
    );
    // 404 means the run already ended — treat as success.
    if (!res.ok && res.status !== 404) throw await this.toApiError(res);
  }

  /**
   * Capture a server session id off a response if one is present. v1 only
   * opportunistically reads headers — `architecture.md` §3.8 says not to
   * invent a source, and `api-contract.md` §4.3.3 marks the exact location as
   * unresolved (Q1). This helper checks a small set of plausible headers.
   */
  extractServerSessionRef(res: Response): string | undefined {
    const candidates = ["x-hermes-session-id", "hermes-session-id"];
    for (const name of candidates) {
      const value = res.headers.get(name);
      if (value) return value;
    }
    return undefined;
  }

  private async postChatCompletions(
    req: ChatCompletionsRequest,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      Accept: req.stream ? "text/event-stream" : "application/json",
    };
    if (req.apiKey && req.apiKey.length > 0) {
      headers["Authorization"] = `Bearer ${req.apiKey}`;
    }
    if (req.idempotencyKey) {
      headers["Idempotency-Key"] = req.idempotencyKey;
    }
    if (req.serverSessionRef) {
      headers["X-Hermes-Session-Id"] = req.serverSessionRef;
    }
    const body = JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: req.stream,
    });
    const signal = req.signal ?? (req.stream ? undefined : this.makeTimeoutSignal());
    const res = await this.fetchImpl(joinUrl(this.baseUrl, "/v1/chat/completions"), {
      method: "POST",
      headers,
      body,
      credentials: "omit",
      ...(signal ? { signal } : {}),
    });
    return res;
  }

  private async request(
    path: string,
    opts: {
      method: "GET" | "POST";
      apiKey?: string;
      signal?: AbortSignal;
      accept: string;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: opts.accept,
    };
    if (opts.apiKey && opts.apiKey.length > 0) {
      headers["Authorization"] = `Bearer ${opts.apiKey}`;
    }
    const signal = opts.signal ?? this.makeTimeoutSignal();
    return this.fetchImpl(joinUrl(this.baseUrl, path), {
      method: opts.method,
      headers,
      credentials: "omit",
      ...(signal ? { signal } : {}),
    });
  }

  private makeTimeoutSignal(): AbortSignal | undefined {
    const AC =
      typeof AbortController !== "undefined" ? AbortController : undefined;
    if (!AC) return undefined;
    const ctrl = new AC();
    setTimeout(() => ctrl.abort(), this.timeoutMs).unref?.();
    return ctrl.signal;
  }

  private async toApiError(res: Response): Promise<ApiError> {
    const msg = await extractShortMessage(res);
    return {
      kind: classifyHttpStatus(res.status),
      status: res.status,
      ...(msg ? { message: msg } : {}),
    };
  }
}

export function toNetworkError(e: unknown): ApiError {
  if (e && typeof e === "object") {
    const err = e as { name?: string; message?: string };
    if (err.name === "AbortError") {
      return { kind: "stopped", message: "aborted" };
    }
    if (err.name === "TimeoutError") {
      return { kind: "timeout", message: err.message ?? "timeout" };
    }
    const message = err.message ?? String(e);
    return { kind: "network", message };
  }
  return { kind: "network", message: String(e) };
}
