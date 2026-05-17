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
