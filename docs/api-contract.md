# hermes-sidebar — API Contract (Draft, v1)

> **Status: design-first.** No client implementation of this contract exists yet in this repository. This document specifies what the `hermes-sidebar` extension *plans* to send and *plans* to accept when it talks to a Hermes Agent API server. Everything here is subject to revision until the open questions in `product-design.md` §12 are answered and this file is ratified.

## 1. Purpose and scope

This document defines the **wire contract** between the `hermes-sidebar` Chrome extension (the client) and a Hermes Agent API server (the server) for v1. Concretely, it specifies:

- The endpoints v1 depends on.
- The exact request bodies and headers the client will send.
- The exact response shapes the client will accept, including SSE event frames.
- The client's interpretation of failure modes and the error-to-UI mapping seam.
- How the user-facing actions `Retry`, `Continue`, and `Stop` manifest on the wire.

It is deliberately written as a contract the client commits to, not as a re-description of the Hermes server's implementation. If the two diverge, the client will change its request shape to match the server *as long as the server still honours the v1 guarantees listed here*. Divergences that break the v1 guarantees must be lifted to `product-design.md` §12 first.

v1 targets exactly one transport for normal conversation: **`POST /v1/chat/completions`** with optional SSE streaming. The Responses API (`POST /v1/responses`) and the Runs API (`POST /v1/runs` + `/v1/runs/{run_id}/events`) are **not** in this document — they belong to a future contract revision (see `product-design.md` §8.3 and §8.4).

## 2. Non-goals and document boundaries

This document does **not** cover:

- **Internal module breakdown of the client** — which file owns the SSE parser, which layer owns `AbortController`, how a `ChatTransport` abstraction is composed. Those belong in `architecture.md`.
- **Visual presentation** — how a streamed token is rendered, how `Calling tool {name}…` looks, how badges for `Stopped` / `Connection interrupted` are drawn. Those belong in `ui-spec.md`.
- **Runtime and development setup** — how to run a Hermes server locally, load the unpacked extension, configure `API_SERVER_CORS_ORIGINS`, or point the extension at a remote host. Those belong in `dev-setup.md`.
- **Session persistence on the client** — `chrome.storage.local` shape, profile keying, draft-input scoping. Those are owned by `product-design.md` §7 and §9.6, and will be elaborated in `architecture.md`.
- **Server internals** — authentication backend, rate limiting, how the server generates `id` / `created` / `model` fields. The client treats the server as opaque beyond the fields listed here.

If you find yourself about to specify a rendering detail, a file layout, a storage schema, or a deploy step in this document, it belongs in one of the above instead.

## 3. Contract summary

All endpoints below are rooted at the user-configured API base URL (see `product-design.md` §9.1). v1 depends on exactly this set:

| Method | Path | Purpose | Streaming? | Auth header sent if user configured a key |
| --- | --- | --- | --- | --- |
| `POST` | `/v1/chat/completions` | The only transport for normal conversation. Default payload is OpenAI-compatible Chat Completions. | Optional via `stream: true` | Yes |
| `GET` | `/v1/models` | Populate the model dropdown; re-fetched on connection-profile change, key change, or reconnect. | No | Yes |
| `GET` | `/health` | Liveness / connection-dot heartbeat. Exact semantic vs `/v1/health` is unresolved — see §10 open question. | No | See §4.3 |
| `GET` | `/v1/health` | Same role as `/health`, possibly with versioned semantics. Unresolved — see §10. | No | See §4.3 |

No other paths are required by v1. In particular, the client will **not**:

- Call `POST /v1/responses` or anything under `/v1/runs`.
- Call any "create session" or "delete session" endpoint. Local session lifecycle is owned by the client (`product-design.md` §7.6).
- Poll any endpoint other than `/health` / `/v1/health` as a heartbeat.

## 4. Common request rules and headers

### 4.1 Base URL and path composition

The client takes the user's configured base URL, normalizes it (scheme + host + port + optional path prefix; trailing slash canonicalized; see `product-design.md` §9.6), and appends the path exactly as written in §3. No path rewriting, no version stripping. If the user configured `https://hermes.example.com/proxy`, the client issues requests against `https://hermes.example.com/proxy/v1/chat/completions`.

### 4.2 Transport

- HTTP/1.1 or HTTP/2 over TLS is expected for remote endpoints; plaintext HTTP is accepted for loopback. The client does not enforce TLS — that is the user's deployment choice (`product-design.md` §9.5).
- `fetch()` is the only transport primitive. No `XMLHttpRequest`, no WebSocket, no long-poll.
- Requests are issued from the extension page, under the extension's origin `chrome-extension://<id>`. CORS is the server's responsibility (`product-design.md` §9.4).

### 4.3 Standard request headers

The client always sends:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json; charset=utf-8` on every request with a body. Absent on `GET`. |
| `Accept` | `application/json` for non-streaming. `text/event-stream` for streaming chat. |

The client conditionally sends:

| Header | When | Value |
| --- | --- | --- |
| `Authorization` | The user has filled in an API key in settings. | `Bearer <API_SERVER_KEY>`, where the token is the literal value the user stored — the client does **not** transform, wrap, or re-encode it. |
| `Idempotency-Key` | See §5.3 and §6.4 for the exact scoping rules. | A client-generated UUIDv4 string, stable for the lifetime of a single logical send (including retries). |
| `X-Hermes-Session-Id` | The `Reuse Hermes server-side session` advanced toggle is on **and** the client has a recorded `serverSessionRef` for the active session. | The opaque server session id, verbatim. The client never parses or mutates it. |

The client does **not** send:

- `User-Agent` overrides. The browser's default applies.
- Cookies. The side panel is not a browsing surface for the Hermes origin; `credentials: 'omit'` is implied on every `fetch`.
- Any telemetry header. v1 has no telemetry (`product-design.md` §9.5).

#### 4.3.1 `Authorization` scope

- Attached to every request to the configured endpoint when a key is set, including `/health`, `/v1/health`, and `/v1/models`.
- Assumption: health endpoints accept the header and ignore it if they don't care about auth. If a Hermes server rejects a health check for carrying `Authorization`, that is a server-side break of the v1 contract and will be logged as an open question.
- Open question: whether `/v1/models` returns the full model list only when `API_SERVER_KEY` is configured, or always. See §10.

#### 4.3.2 `Idempotency-Key` scope

- Generated once per **logical user send**. A logical send is "what the user intends to deliver to the agent as one turn."
- A `Retry` on a failed **non-streaming** send reuses the same key, so the server has a chance to deduplicate if it cached the first attempt (`product-design.md` §7.5).
- A `Continue` on an interrupted stream is **not** a retry — it is a fresh logical send. It gets a **new** `Idempotency-Key` (`product-design.md` §10, and §6.5 below).
- A new user-typed message is always a new logical send with a new key.

Open question: the client will *attach* `Idempotency-Key` to streaming sends as well (same scope rule), but whether the Hermes server honours it on a streaming endpoint — and whether a replayed key returns a cached full response or opens a new stream — is unresolved (`product-design.md` §12 question 4). The client's behaviour must not depend on the answer: the UI treats "stream completed" as success regardless of whether bytes came from a replay or a new stream. If the resolution is "server ignores `Idempotency-Key` on streaming," the client may drop the header on streaming sends in a later revision; it will not be a breaking change for the client.

#### 4.3.3 `X-Hermes-Session-Id` scope

- **Assumption.** The header's value is an opaque string the client stores per local session as `serverSessionRef`, and echoes back verbatim on subsequent sends in that local session.
- **Open question — source of the value.** The product design leaves it explicit (`product-design.md` §7.3 and §12 question 2) that it is not yet specified *where* the client reads the session id from after a first call: a response header, a field inside a non-streaming JSON body, a field inside a streaming event, or a dedicated create-session call. Until this is resolved, this contract does **not** prescribe a read-side location. The client will capture `serverSessionRef` at whatever point the ratified Hermes API contract says the value becomes available, and from then on echo it on subsequent sends for that local session.
- **Open question — coupling with `API_SERVER_KEY`.** The product design notes (`product-design.md` §12 question 3) that the Hermes docs tie this header to `API_SERVER_KEY` being configured, but do not disambiguate whether that means "the *request* must also carry `Authorization`" or "the server only *enables* session tracking when a key is configured." The client currently sends `Authorization` whenever the user has set a key, so it is safe under either reading; the Advanced toggle copy will be finalized once question 3 is answered.
- The client **does not** invent, mutate, or derive a session id from other fields. If it has no stored `serverSessionRef`, it simply omits the header.

### 4.4 Timeouts, retries, and aborts

- Non-streaming requests use a client-side deadline (default planned: 60s; final value tracked in `architecture.md`). On deadline, the `fetch` is aborted via `AbortController` and the send is reported as `Failed to send` with reason `timeout`.
- Streaming requests have no overall deadline once the response head has been received; an idle-gap deadline between SSE events may be added in a later revision.
- `Retry` is **always user-initiated** in v1. The client does not automatically retry failed sends — not on network errors, not on 5xx, not on timeout. This keeps the contract predictable under `Idempotency-Key` (§4.3.2) and avoids silent double-charges against a paid upstream model.
- `Stop` aborts the in-flight `fetch` via `AbortController`. Partial content already received from a streaming response is preserved and marked `Stopped` (`product-design.md` §7.4, §10).

## 5. `POST /v1/chat/completions` — contract

### 5.1 When the client issues this request

- Every time the user presses `Send` on an enabled session.
- Every time the user presses `Retry` on a message with the `Failed to send` badge.
- Every time the user presses `Continue` on a message with the `Connection interrupted` badge.

That is the only traffic on this endpoint. The client never issues speculative, warm-up, or prefetch calls to `/v1/chat/completions`.

### 5.2 Request body

The body is a strict JSON object. Top-level fields the v1 client will send:

| Field | Type | Required | Value |
| --- | --- | --- | --- |
| `model` | string | yes | The `modelId` currently selected for the active session. Never empty. Never auto-substituted by the client at send time. |
| `messages` | array of `Message` | yes | The full conversation history the client owns for this session, after the client-side truncation policy has been applied (see §5.2.2). Always non-empty; the last entry is the user's new turn. |
| `stream` | boolean | yes | `true` when the client is consuming SSE; `false` otherwise. The client always sets this explicitly. The default is `true` unless the user turned streaming off in settings. |
| `temperature` | number | no | Omitted in v1 unless the UI exposes a control (it does not in v1). Reserved for future expansion. |
| `max_tokens` | integer | no | Omitted in v1. Reserved. |

No other top-level fields are sent by v1. In particular, the client does **not** send `tools`, `tool_choice`, `response_format`, `stop`, `logit_bias`, `n`, `seed`, `user`, or any vendor-prefixed field. If Hermes requires a vendor field to enable a v1-visible behaviour, that is an incompatibility to be raised against §12 before shipping.

#### 5.2.1 `Message` shape

```
Message := { "role": "system" | "user" | "assistant", "content": string }
```

- `role` is one of the three literal strings above. v1 does **not** send `tool` or `function` role messages; tool activity is surfaced to the user via the SSE `hermes.tool.progress` custom event (§6.3), not as transcript turns.
- `content` is a plain string. v1 does **not** send the OpenAI content-parts array form (`[{"type":"text","text":"…"}, …]`). If a future feature (e.g. image input) requires it, this contract will be revised.
- Additional, unknown fields on inbound `Message` objects from the server (if any are ever surfaced in non-streaming responses) are ignored by the client.

#### 5.2.2 Truncation and source of `messages`

- The front end is the **source of truth** for conversation history in v1 (`product-design.md` §7.2, §7.3). `messages` is reconstructed from the local persisted session on every send.
- A leading `system` message, if the session has one, is always kept.
- The remaining entries are truncated to the most recent N user/assistant turns, where N is a client-side policy owned by `architecture.md`. This contract only guarantees: (a) the server sees chronological order, (b) the final entry is the user's new turn, (c) no speculative future turns are included.
- `X-Hermes-Session-Id`, when present (§4.3.3), does **not** change what the client sends in `messages`. The server may or may not use the header to elide redundant history on its side; the client's job is unaffected.

#### 5.2.3 Request example — non-streaming

```http
POST /v1/chat/completions HTTP/1.1
Host: hermes.example.com
Content-Type: application/json; charset=utf-8
Accept: application/json
Authorization: Bearer sk-live-…
Idempotency-Key: 7c2f4a2c-7a0b-4e4f-9f8e-1b2c3d4e5f60

{
  "model": "hermes-default",
  "stream": false,
  "messages": [
    { "role": "system", "content": "You are Hermes." },
    { "role": "user",   "content": "Summarize this paragraph: …" }
  ]
}
```

#### 5.2.4 Request example — streaming

```http
POST /v1/chat/completions HTTP/1.1
Host: hermes.example.com
Content-Type: application/json; charset=utf-8
Accept: text/event-stream
Authorization: Bearer sk-live-…
X-Hermes-Session-Id: srv-sess-9f2e…        (only when the advanced toggle is on and a ref is stored)
Idempotency-Key: 7c2f4a2c-7a0b-4e4f-9f8e-1b2c3d4e5f60

{
  "model": "hermes-default",
  "stream": true,
  "messages": [
    { "role": "system", "content": "You are Hermes." },
    { "role": "user",   "content": "Summarize this paragraph: …" }
  ]
}
```

### 5.3 Non-streaming response (`stream: false`)

On 2xx, the client expects an OpenAI-compatible Chat Completion object. The client consumes a small, stable subset:

| Field | Type | Use by v1 client |
| --- | --- | --- |
| `id` | string | Logged for diagnostics; surfaced in developer tools; **not** persisted as `serverSessionRef`. |
| `created` | integer (unix seconds) | Ignored. The client uses its own `updatedAt`. |
| `model` | string | Recorded on the transcript message as the model that actually answered (relevant for the §9.6 model-fallback rule in `product-design.md`). |
| `choices[0].message.role` | `"assistant"` | Required; rejected if not `"assistant"`. |
| `choices[0].message.content` | string | The assistant message body. Rendered verbatim; Markdown rendering is a UI concern. |
| `choices[0].finish_reason` | string | Passed through to the transcript for diagnostics. No v1 UI branching keys off this value beyond §8. |
| `usage.*` | — | Ignored by v1. |

- The client reads `choices[0]` only. Additional choices are ignored (`n` is never requested).
- Any unknown top-level field is ignored.
- A 2xx with a body that does not parse as JSON, or a JSON body missing `choices[0].message.content`, is treated as a transport failure (§8).

On non-2xx, see §8.

### 5.4 Streaming response (`stream: true`)

On 2xx with `Content-Type: text/event-stream`, the client opens an SSE reader over the response body and processes events as specified in §6. The contract for the HTTP transaction itself:

- The server should send `Content-Type: text/event-stream; charset=utf-8` on the response head. If the header is missing but the body is clearly SSE-framed (`data:` lines), the client still attempts to parse — this tolerance may be tightened later.
- The response may be chunked-transfer-encoded; this is transparent to the client.
- The connection stays open for the duration of the stream. The server signals end-of-stream with the `[DONE]` sentinel (§6.2) and closes the connection.
- A mid-stream TCP-level disconnect or an EOF before `[DONE]` is treated as "stream cut mid-response" and surfaced with the `Connection interrupted` badge (§6.5, `product-design.md` §10).

## 6. SSE streaming contract

### 6.1 Frame format

The client parses frames per the HTML Standard SSE format:

- Frames are separated by a blank line (`\n\n` or `\r\n\r\n`).
- Each frame is a set of lines; lines of interest are `event: <name>` and `data: <payload>`.
- If no `event:` line is present, the frame is treated as an `event: message` frame (the SSE default). OpenAI-compatible Chat Completion chunks arrive as default-event frames.
- A `data:` line's payload is the literal text after `data: `. Multiple consecutive `data:` lines within one frame are concatenated with a single `\n` between them, then parsed once.
- `id:`, `retry:`, and comment lines (starting with `:`) are accepted and ignored.
- The client does **not** reconnect on its own. SSE auto-reconnect (`EventSource` semantics) is explicitly disabled: the client uses `fetch` + a ReadableStream reader, not `EventSource`.

### 6.2 Event types v1 recognizes

| Event name | Source | How the client handles it |
| --- | --- | --- |
| *default* (`event:` line absent) | OpenAI-compatible delta chunks | Parse `data:` as JSON; apply §6.2.1. |
| `hermes.tool.progress` | Hermes-specific custom event | Parse `data:` as JSON; apply §6.3. |
| anything else | — | Logged at debug level, otherwise ignored. No UI effect. v1 will not break if new event types are introduced in a later server revision. |

The `[DONE]` sentinel (`data: [DONE]` on a default-event frame, with no JSON parsing) terminates the stream. After `[DONE]`, any further frames in the same response are ignored.

#### 6.2.1 Default (delta) event payload

The expected shape of the JSON carried by a default-event `data:` line is an OpenAI-compatible chunk:

```
{
  "id": "...",
  "object": "chat.completion.chunk",
  "created": 1700000000,
  "model": "hermes-default",
  "choices": [
    {
      "index": 0,
      "delta": {
        "role":    "assistant" | undefined,
        "content": "…partial text…" | undefined
      },
      "finish_reason": null | "stop" | "length" | "tool_calls" | "content_filter"
    }
  ]
}
```

- The client reads `choices[0].delta.content` and appends it to the in-progress assistant message. A delta with no `content` key is treated as a no-op for text.
- `choices[0].delta.role` is inspected only on the first chunk; if absent, the client assumes `"assistant"`.
- `choices[0].finish_reason`, when non-null, is recorded on the transcript message but does **not** end the stream on its own — the client waits for `[DONE]` or EOF (§5.4).
- Unknown keys in `delta` are ignored. In particular, v1 does **not** implement `delta.tool_calls` handling; tool activity is surfaced via §6.3 only.
- A malformed default-event JSON payload is logged and skipped; the stream continues. One bad chunk does not poison the response.

### 6.3 `hermes.tool.progress` custom event

- **Purpose.** Surface to the user that the agent is calling a tool, and when that tool finishes. v1 uses this for a lightweight `Calling tool {name}… / Tool {name} finished` hint, rendered separately from the assistant message body (`product-design.md` §6.2).
- **Frame.** `event: hermes.tool.progress\ndata: <json>\n\n`.
- **Ordering.** Interleaved with default delta frames. The client must keep both streams advancing on the same reader; a `hermes.tool.progress` frame never closes or replaces the text stream.
- **Payload (assumption, v1).** The client will consume a minimal subset:

```
{
  "tool": "string — human-readable tool name, displayed verbatim",
  "status": "started" | "finished",
  "call_id": "string — stable identifier for this tool invocation within the stream"
}
```

  - `tool` is displayed to the user as-is. The client does not localize or rewrite it.
  - `status` drives the `Calling tool {name}…` → `Tool {name} finished` transition.
  - `call_id` is used by the client to associate a `finished` with its matching `started`. Its opacity is a server-side concern.
  - Additional fields (e.g. `arguments`, `result`, `error`) are accepted and **ignored** by v1. v1 deliberately does not render tool arguments or results, because the side panel is narrow (`product-design.md` §6.2).
- **Open question.** The stability of this payload is tracked in `product-design.md` §12 question 9. The schema above is what the v1 client will implement against; if the ratified payload differs, this contract is updated and the client rewires — without affecting anything in §5 or §8.
- **Text-stream isolation.** `hermes.tool.progress` payloads are **never** appended to the assistant message body. A server that duplicates tool narration into the text stream is not contract-breaking, but the client will render it twice if so.
- **Missing `finished`.** If a `started` is never followed by a `finished` for the same `call_id` before the stream ends (normal `[DONE]`, `Stopped`, or `Connection interrupted`), the in-progress hint is resolved to a neutral terminal state at the UI layer. This is a UI detail (see `ui-spec.md`), not a contract detail.

### 6.4 `Idempotency-Key` on streaming

- **Assumption.** The client will attach `Idempotency-Key` to streaming requests using the same scoping rule as non-streaming (§4.3.2): one key per logical user send, reused on `Retry`, new on `Continue` and on new user turns. This goes beyond `product-design.md` §7.5, which only requires `Idempotency-Key` on non-streaming sends — so attaching on streaming is a contract-level choice, not a derived requirement, and may be revisited per the open question below.
- The server's behaviour when it sees a replayed `Idempotency-Key` on a streaming request is **not assumed** by this contract. See `product-design.md` §12 question 4. The client will work correctly under any of: (a) server ignores the header on streaming, (b) server opens a fresh stream each time, (c) server replays a cached full response as SSE. In all three cases, the client's stream-reader code consumes until `[DONE]` or EOF identically.
- Because `Retry` in v1 is limited to failed **non-streaming** sends (§7.2), the replay edge case on streaming is narrow: it only arises if a user-triggered retry path is added to streaming in a future revision. `Continue` is a fresh key and is not affected.

### 6.5 `Stop` and `Continue` on streaming

- **`Stop`.** The client aborts the underlying `fetch` via `AbortController`. Bytes already delivered to the stream reader are committed to the assistant message body, which is then marked `Stopped` at the UI layer. No further HTTP call is made. The server sees a client-initiated disconnect; the client does **not** send an additional "cancel" request.
- **`Continue`.** A fresh `POST /v1/chat/completions` is issued with the session's current `messages` array — which now includes the partial assistant message as its last assistant turn — and a **new** `Idempotency-Key`. This is explicitly **not** "resume-from-offset"; the client does not send any offset, cursor, or continuation token, and there is no v1 header for it. The server-visible pattern is simply: one stream ended early; another stream is started, with the partial output now part of the history the client is sending (`product-design.md` §7.6, §10).
- **Dropped stream without user action.** Identical wire behaviour to `Stop` on the response-reading side — the reader observes EOF before `[DONE]`. The client marks the agent message `Connection interrupted` and offers `Continue`. No automatic reconnect. No automatic retry.

## 7. `GET /v1/models` — contract

### 7.1 When the client issues this request

- Once, after a successful `/health` or `/v1/health` check on a freshly connected profile.
- Again when the user changes the API base URL to a different connection profile (`product-design.md` §9.6).
- Again when the user changes only the API key on the same profile (`product-design.md` §9.6).
- Again when the user manually triggers a reconnect or a `Test connection`.

The client does **not** poll this endpoint, does not re-fetch it between sends, and does not re-fetch it when the active session's model changes.

### 7.2 Request

- No body. No `Idempotency-Key` (the endpoint is read-only and idempotent by nature).
- The client attaches the Authorization header when an API key is configured.
- No `X-Hermes-Session-Id` (irrelevant for a catalogue fetch).

### 7.3 Response (2xx)

The client expects an OpenAI-compatible listing:

```
{
  "object": "list",
  "data": [
    { "id": "hermes-default", "object": "model", "created": 1700000000, "owned_by": "hermes" },
    { "id": "some-other",     "object": "model", "created": 1700000000, "owned_by": "hermes" }
  ]
}
```

- The client consumes `data[*].id` only. All other fields are accepted and ignored.
- Order is preserved as received. The dropdown's display order is the server's order.
- An empty `data` array is a valid, 2xx response. It is **not** a transport error. The client maps it to the "Model list empty" row in `product-design.md` §10 (sending is disabled, dropdown shows `No models available`).

### 7.4 Response interpretation — what the list represents

**Open question.** `product-design.md` §12 question 6 records that it is unresolved whether `GET /v1/models` returns every model registered with Hermes, or only those available to the caller's key. The v1 client **does not** depend on either reading:

- It treats the returned list as "the authoritative set of models the current client is allowed to use against the current endpoint with the current key."
- On an API-key change, it re-fetches (§7.1), so a narrower/wider list takes effect immediately.
- It makes no claim that `data[*].id` maps to a policy, entitlement, or billing category. Those are server concerns.

If the Hermes server's behaviour is ratified one way or the other, the client behaviour above still holds; only the copy in the settings drawer may change.

### 7.5 Error handling

See §8. In particular, a 401 on `/v1/models` leaves the client in a state where no models are selectable and the user is routed to the "API key is missing or invalid" error copy. It does **not** delete local sessions (`product-design.md` §9.6).

## 8. `GET /health` and `GET /v1/health` — contract

### 8.1 Role

Health checks drive exactly two things in v1:

1. The connection-status dot (green / yellow / red) in the top region.
2. Whether the user is allowed to send.

They are **not** used to gate `/v1/models` or to decide which conversation is active.

### 8.2 Cadence

- A low-frequency background poll every ~30 seconds while the side panel page is open.
- An immediate, one-shot check when the panel comes back into focus (e.g. the user re-opens the side panel, or switches back to the Chrome window).
- An immediate check on "`Test connection`" in settings.
- An immediate check when the connection profile or API key changes (§7.1, `product-design.md` §9.6).

No per-send health pre-check. The client sends directly against `/v1/chat/completions` and lets that request report its own failure.

### 8.3 Which of the two paths does the client call?

**Open question.** `product-design.md` §12 question 5 flags that the semantic difference between `/health` and `/v1/health` is not yet specified. Until that question is answered, the v1 client will:

- **Assumption.** Prefer `/v1/health` when present, because it is version-namespaced and matches the other v1 endpoints.
- **Assumption.** Fall back to `/health` if `/v1/health` returns 404 on the first-ever check of a profile. After a successful response on either path, the client caches which path worked for that profile and uses it for subsequent polls.
- The fallback is a **client** behaviour, not a server contract guarantee. A server that serves only one of the two paths is acceptable as long as at least one of them returns a usable response.

When question 5 resolves to "they are equivalent," the fallback stays but becomes uninteresting. If it resolves to "they mean different things," the client is updated to call the semantically correct one for the connection dot and this section is rewritten.

### 8.4 Request

- No body. No `Idempotency-Key`.
- `Authorization` is attached if the user has configured a key (§4.3.1). Assumption: health endpoints either accept the header and ignore it, or they validate it. Under either behaviour, the client's classification in §8.5 is correct.

### 8.5 Response classification

| Outcome | Status dot | UI behaviour |
| --- | --- | --- |
| 2xx with any body | green | Sending enabled. |
| Network error, DNS failure, TLS failure, CORS rejection, permission not granted | red | Sending disabled. Relevant copy from `product-design.md` §10. |
| 4xx other than 401/403 | red | `Cannot reach {hostShort}: HTTP {status}`. |
| 401 | red | Routes to "API key is missing or invalid." |
| 403 | red | Routes to "API key is not permitted to reach this endpoint." |
| 5xx | red | Routes to "Hermes server is reachable but not healthy." |
| Timeout | yellow → red | Marked "connecting"; escalates to red if two consecutive polls time out. |

The body of a health response is **not** inspected by v1. Any 2xx is "healthy." If a later revision needs richer signals (e.g. "degraded: tool backend down"), the contract is extended then.

### 8.6 What health checks do **not** do

- They do **not** persist any state against a session.
- They do **not** delete local sessions on failure (`product-design.md` §9.6).
- They do **not** send `X-Hermes-Session-Id`.
- They do **not** fall back across connection profiles — each profile checks its own endpoint.

## 9. Error mapping and client behavior

### 9.1 Classification seam

All failures the client surfaces to the UI pass through one classification:

| Wire outcome | Client class | Default UI copy (from `product-design.md` §10) | Retryable from UI? |
| --- | --- | --- | --- |
| 2xx | — | (success) | — |
| 400 | `bad-request` | `Request failed (400): {serverMessageIfShort}` | No — the send is rejected at the client; fixing the request is a client or user change. |
| 401 | `unauthorized` | `Request failed (401): API key is missing or invalid.` | No — user must update settings first. |
| 403 | `forbidden` | `Request failed (403): API key is not permitted.` | No. |
| 404 | `not-found` | `Request failed (404): The configured Hermes endpoint does not expose {path}.` | No. |
| 408, 504 | `timeout` | `Request failed (timeout): {hostShort} did not respond within {seconds}s.` | Yes (via `Retry`). |
| 409 | `conflict` | `Request failed (409): conflicting request.` | No — `Idempotency-Key` replay handling is the server's. |
| 413 | `too-large` | `Request failed (413): the request body is too large. Try shortening the conversation.` | No — truncation policy is client-side. |
| 429 | `rate-limited` | `Request failed (429): too many requests.` | Yes (via `Retry`). |
| Other 4xx | `client-error` | `Request failed ({status}): {serverMessageIfShort}` | No. |
| 5xx | `server-error` | `Request failed ({status}): Hermes server error.` | Yes (via `Retry`). |
| Network error, DNS, TLS, CORS | `network` | `Cannot reach {hostShort}: {shortReason}` | Yes (via `Retry`). |
| Stream cut before `[DONE]` | `stream-interrupted` | `Streaming interrupted: connection closed before the response finished.` | Via `Continue`, not `Retry` (§6.5). |
| User pressed `Stop` | `stopped` | (no error; `Stopped` badge only) | No — not an error. |

- "Retryable from UI" is whether a `Retry` button is surfaced. It is **not** a statement about whether the server would actually succeed on a second attempt.
- For classes marked retryable, the `Retry` reuses the original `Idempotency-Key` for non-streaming (§4.3.2).
- The client extracts `{serverMessageIfShort}` from the response body only when the body is JSON with a top-level `error.message` or a top-level `message` string ≤ 200 characters. Otherwise, the copy falls back to the generic wording. The client **never** pastes raw HTML or multi-kilobyte payloads into the UI.

### 9.2 Effect on session and transcript

- A non-streaming failure leaves the user message marked `Failed to send`. No assistant placeholder is persisted (`product-design.md` §7.6 lifecycle table row).
- A streaming failure **before any bytes** is treated the same as a non-streaming failure.
- A streaming failure **after some bytes** keeps the received portion as the agent message, with a `Connection interrupted` badge and a `Continue` button (`product-design.md` §10).
- `Stop` is not an error; the partial agent message gets a `Stopped` badge (§6.5).

### 9.3 CORS and permission failures

- A CORS rejection at the browser layer surfaces to `fetch` as a generic network error without a status code. The client classifies it as `network` and uses the CORS-specific hint from `product-design.md` §10 row "Health check failed because of CORS" when the origin is plausibly remote and the error signature matches.
- A missing `host_permissions` grant surfaces before `fetch` is even issued. The client shows the permission banner from `product-design.md` §10 row "Permission for remote host not yet granted" and does not attempt the request.

### 9.4 What the client will never do on error

- Never delete a local session, partial message, or draft in response to an HTTP status or network outcome (`product-design.md` §9.6).
- Never rotate or mutate the user's API key.
- Never retry automatically (§4.4). Every retry is user-initiated via `Retry` or `Continue`.
- Never send a partial or synthetic response to the transcript in place of an actual server reply.

## 10. Assumptions and open questions (contract-level)

This section collects the items in the v1 contract that are **not** yet settled. Each entry names the client behaviour that is in effect until the question is resolved, so implementation can proceed without blocking on a full answer.

| # | Topic | Current assumption / client behaviour | Blocking question |
| --- | --- | --- | --- |
| Q1 | Source of `X-Hermes-Session-Id` | Not attached by default. When the advanced toggle is on, the client stores `serverSessionRef` at whatever point the ratified Hermes API contract says the id becomes available, and echoes it verbatim thereafter. | Where does the client read the session id from — response header, non-streaming JSON body field, SSE event, separate create-session call? (`product-design.md` §12 question 2) |
| Q2 | Coupling of `X-Hermes-Session-Id` and `API_SERVER_KEY` | Client sends `Authorization` whenever a key is set, which is safe under either reading of the current docs. | Does the header require the *request* to carry a matching `Authorization`, or does it require the *server* to have been started with `API_SERVER_KEY`? (`product-design.md` §12 question 3) |
| Q3 | `Idempotency-Key` on streaming | Client attaches it with the same scope as non-streaming. Success is judged purely by "stream reached `[DONE]`." | Does the server honour `Idempotency-Key` on streaming requests, and if so does it replay a cached full response or open a fresh stream? (`product-design.md` §12 question 4) |
| Q4 | `/health` vs `/v1/health` | Prefer `/v1/health`; fall back to `/health` on first-ever 404; cache the winner per profile. Both are treated as liveness-only. | What is the semantic difference, and which one should the connection dot actually use? (`product-design.md` §12 question 5) |
| Q5 | Model list scope | `GET /v1/models` is the authoritative set the current client/key is allowed to use against the current endpoint. Re-fetched on profile or key change. | Is the list scoped to the caller's key, or is it the full set of models Hermes has registered? Is `API_SERVER_KEY` required to see it? (`product-design.md` §12 question 6) |
| Q6 | `hermes.tool.progress` payload stability | Client consumes `{ tool, status, call_id }` only. Additional fields are tolerated and ignored. | Is the payload schema stable? Are additional fields needed to power the v1 UI (see `ui-spec.md` once written)? (`product-design.md` §12 question 9) |
| Q7 | `Authorization` on health endpoints | Attached if configured; assumed accepted. | Does any Hermes deployment reject authenticated `/health` requests? If so, the client needs a health-specific auth-suppression rule. |
| Q8 | CORS on `chrome-extension://` origin | Client sends from the extension origin; the user is expected to allowlist it on the server. | Should the documentation universally tell users to allowlist `chrome-extension://<id>` for both local and remote, or is there a local case where it is unnecessary? (`product-design.md` §12 question 1) |
| Q9 | Mixed-content warning for remote `http://` | Out of scope of this contract; flagged for the UI layer. | Should the client refuse or merely warn on non-loopback `http://`? (`product-design.md` §12 question 11) |

Any change to an entry in this table is a contract-level change and requires this document to be updated before client behaviour is changed. The implementation layer (`architecture.md`) and the UI layer (`ui-spec.md`) must both align to whatever state this table is in — not to an earlier or later one.
