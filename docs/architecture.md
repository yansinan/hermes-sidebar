# hermes-sidebar — Architecture (Draft)

## 1. Purpose and scope

This document describes the planned internal architecture of `hermes-sidebar`: the modules the extension will be built from, their responsibility boundaries, the key data flows between them, and where state lives at runtime. It is the implementation-layer companion to `product-design.md`.

Status: design-first. No extension code exists yet. Read this as the structure implementers should build to, not as a description of an existing system. Where this document is normative for v1, it says so; everywhere else it is a recommendation that may be refined as the open questions in `product-design.md` section 12 are resolved.

### Scope and document boundaries

To keep each design document focused, this one stops at well-defined edges:

- **This document (`architecture.md`)** owns system structure, module breakdown, responsibility boundaries, runtime topology, state ownership (memory vs `chrome.storage.local`), and the lifecycle wiring that turns the rules in `product-design.md` sections 7.6 and 9.6 into a set of cooperating modules.
- **`api-contract.md`** owns the exact request and response shapes against the Hermes API server: header names and values, JSON field names, SSE event payload schemas, error code mappings. This document refers to those interfaces by role ("Chat Completions request", "tool-progress event") and does not redefine their fields.
- **`ui-spec.md`** owns the visual design, component inventory, layout rules, copy, and accessibility behavior. This document refers to UI surfaces by role ("conversation area", "session list drawer") and does not specify how they are rendered.
- **`dev-setup.md`** owns developer environment instructions: how to load the unpacked extension, how to point it at a local or remote Hermes, how to iterate. This document does not include build, packaging, or local-run steps.

### Inputs to this design

The architecture below is shaped primarily by:

- The connection model in `product-design.md` section 9 — one configurable Hermes endpoint, local or remote, treated as opaque by the extension.
- The local session lifecycle in `product-design.md` section 7.6 — the front end is the source of truth and owns every session-state transition.
- The connection-profile scoping rules in `product-design.md` section 9.6 — local sessions are scoped to a normalized API base URL, never silently replayed across endpoints, and never deleted by connection-level events.
- The least-privilege permission shape in `product-design.md` section 9.3 — `sidePanel` and `storage` at install time, remote hosts granted at runtime via `optional_host_permissions`.
- The reservation of a transport seam for the Responses API in `product-design.md` section 8.3.

---

## 2. Runtime topology

The extension runs across two Chrome surfaces: the **side panel page** and the **background service worker**. v1 deliberately keeps the work concentrated in the side panel page; the service worker has the smallest responsibility set Chrome forces on it.

```
            ┌────────────────────────────────────────────┐
            │              Side panel page               │
            │  (long-lived while the panel is open;      │
            │   dies when the panel is closed)           │
            │                                            │
            │   UI shell   ── view model ── controllers  │
            │       │             │             │        │
            │       └──── session manager ──────┘        │
            │                     │                      │
            │              profile manager               │
            │                     │                      │
            │     ┌───── settings store ─────┐           │
            │     │                          │           │
            │     ▼                          ▼           │
            │  storage gateway       permission broker   │
            │     │                          │           │
            │     │              ┌───────────┘           │
            │     │              │                       │
            │     │              ▼                       │
            │     │        API client                    │
            │     │      (ChatTransport)                 │
            │     │              │                       │
            │     │              ▼                       │
            │     │       stream handler                 │
            │     │              │                       │
            │     ▼              ▼                       │
            │  chrome.storage   fetch() ── Hermes API ──►│
            │      .local                                │
            └────────────────────────────────────────────┘
                              ▲
                              │  chrome.runtime messaging (minimal)
                              ▼
            ┌────────────────────────────────────────────┐
            │           Background service worker        │
            │     (event-driven; may be terminated by    │
            │      Chrome between events)                │
            │                                            │
            │   action click → open side panel           │
            │   install/update → seed defaults           │
            │   chrome.permissions events → notify panel │
            └────────────────────────────────────────────┘
```

Key consequences of this split:

- **In-flight requests are owned by the side panel page.** Closing the panel ends the page, which aborts any in-flight `fetch` via the page's `AbortController`s. This is the v1 stance described in the `Panel is closed` row of `product-design.md` 7.6. Migrating long-running requests into the service worker is on the evolution list, not in v1.
- **The service worker is not a bus for chat traffic.** v1 does not proxy SSE through the worker. Doing so would require keeping the worker alive across an entire stream, which Manifest V3 does not guarantee.
- **`chrome.storage.local` is the only cross-context shared surface.** Both contexts can read it; only the side panel page writes session data. The service worker writes nothing chat-related in v1.

---

## 3. Module breakdown

Modules below are responsibility units, not a prescription of file layout. A module may be one file or several; what matters is that the responsibilities listed for it do not leak elsewhere.

### 3.1 UI shell

Owns the rendered DOM of the side panel: the top connection/session region, the conversation area, the input area, and the settings drawer (described in `product-design.md` section 6 and finalized in `ui-spec.md`). The shell is intentionally thin — it reads from the view model and dispatches user intents (send, stop, switch session, save settings, retry, continue, grant permission) into controllers.

The shell does not directly call the API client, the storage gateway, or `chrome.*` APIs. That isolation is what lets the event-driven rules in 7.6 and 9.6 be expressed once, in the controllers, rather than scattered across event handlers.

### 3.2 View model

A single in-memory projection of what the panel is currently showing. The view model is derived from:

- The active connection profile (from the profile manager).
- The currently selected session (from the session manager) and its messages.
- The current draft input for that profile (from the profile manager — drafts are profile-scoped per 9.6).
- The current model selection and model list (from the settings store and the API client's last `GET /v1/models` result).
- Transient UI-only flags: streaming, last error badge per message, banner state.

The view model is recomputed when its inputs change and is the only thing the UI shell reads from. It is **never** persisted; it is rebuilt on every panel open from `chrome.storage.local` and from the modules that own each piece.

### 3.3 Controllers

Controllers translate user intents from the UI shell into operations on the session manager, the profile manager, the API client, and the settings store, and then update the view model. Each user-visible action in `product-design.md` section 7.6 maps to a controller path:

- `Send` → session manager promotes draft (if needed), appends the user message and a placeholder agent message, opens an `AbortController`, asks the API client for a stream, and feeds the stream handler.
- `Stop` → the session's `AbortController.abort()` is called; the partial agent message is finalized with the `Stopped` badge.
- `Retry` on a `Failed to send` message → reuses the stored client `Idempotency-Key` for that user message and re-issues the send in place; it is **not** a new user message (per 7.6).
- `Continue` on a `Connection interrupted` message → issues a fresh send with the existing conversation and a **new** `Idempotency-Key` (per 7.6 and section 10 of `product-design.md`).
- `New session` → creates an empty draft in memory only. It is not added to the session list and not written to `chrome.storage.local` (per 7.6).
- `Switch session` → just changes which session id the view model reads from; in-flight streams keep writing into their originating sessions (per the cross-session row in 7.6).
- `Rename` / `Delete` → session manager only; no backend call (per 7.6).
- `Save settings (URL/key)` → settings store writes, profile manager re-resolves the active profile, the connection-change behavior in 9.6 runs.
- `Grant access to {origin}` → permission broker.

Controllers are the only place where 7.6 and 9.6 transitions are encoded. Other modules expose primitives; controllers compose them in the order those sections require.

### 3.4 Session manager

Owns the set of local sessions for the currently active profile, plus the active session id. Its responsibilities:

- Hold the list of persisted sessions for the active profile, and the messages for each.
- Expose primitives: `createDraft()`, `promoteDraft(firstUserMessage)`, `appendUserMessage(sessionId, ...)`, `appendAgentPlaceholder(sessionId)`, `appendStreamDelta(sessionId, ...)`, `finalizeAgentMessage(sessionId, outcome)`, `markUserMessageFailed(sessionId, messageId)`, `rename(sessionId, title)`, `delete(sessionId)`, `switchTo(sessionId)`.
- Know the rule that an empty draft is in-memory only and is reused — the panel never accumulates multiple unsent drafts (per 7.6).
- Persist transitions through the storage gateway. Writes that 7.6 requires to be durable (the user message and the placeholder agent message at send time, streamed deltas as they arrive, the final agent message, rename/delete, `updatedAt` bumps) go through the gateway immediately so a panel reload mid-stream does not lose them.
- Hold one `AbortController` and one client `Idempotency-Key` per in-flight send. v1 does not impose a global single-flight limit; concurrent sends across sessions are allowed (per 7.6).
- On panel open, ask the storage gateway for the persisted sessions for the active profile and resolve the active session id using the rules in the `Panel is reopened` row of 7.6 (most recently updated session as fallback; empty-state card if none).

The session manager **never** calls the Hermes API directly. It only emits intents that controllers route through the API client. This keeps the lifecycle rules separable from transport concerns.

### 3.5 Profile manager

Owns the concept of a **connection profile** as defined in `product-design.md` 9.6 and the rules for transitioning between profiles. Its responsibilities:

- Normalize a raw `API base URL` string into a profile key. Normalization v1: scheme + host + port + optional path prefix; trailing slash canonicalized. v1 does **not** perform DNS canonicalization, so `127.0.0.1` and `localhost` are different profiles (per 9.6).
- Hold the per-profile in-memory draft input. Drafts are profile-scoped, never persisted, and survive only as long as the panel page is alive (per 9.6).
- Decide, on a settings save, whether the new URL resolves to the same profile or a different profile, and route the controller accordingly.
- For a same-profile save (e.g. only whitespace or trailing slash changed), preserve the active session, draft input, streaming state, and model selection.
- For a same-profile save where only the API key changed, preserve the visible session list, the active session, draft input, and streaming state. The next send uses the new key. Re-fetch `GET /v1/models` because the available model set may differ (per 9.6).
- For a cross-profile save, abort any in-flight request in the previous profile (per 9.6), swap the visible session list to the new profile (without deleting the previous profile's sessions from `chrome.storage.local`), trigger the runtime permission flow and a fresh `/health` check before any send is allowed, re-fetch `GET /v1/models`, and rehydrate the new profile's last active session (or surface the empty-state card for a never-used profile).
- Coordinate the model-fallback rule on reconnect: keep the active session's `modelId` if still present in the new model list; otherwise keep historical message `modelId`s as-is and fall back the dropdown to the first model in the new list with a non-blocking banner (per 9.6).

The profile manager treats the API key as a **credential**, not as part of the profile's identity (per 9.6).

### 3.6 Settings store

Holds the user's settings as defined in `product-design.md` sections 6.4 and 9.1: API base URL, API key, default model, Enter behavior, streaming on/off, `Reuse Hermes server-side session`, `Idempotency-Key` behavior. Its responsibilities:

- Read settings from `chrome.storage.local` on panel open.
- Persist edits back to `chrome.storage.local`.
- Notify the profile manager and controllers when the URL or key changes so that 9.6's transition rules can run.
- Treat the API key as sensitive: it is never logged, never attached to error reports (v1 has no error reporting), and is only ever read into memory to be passed to the API client as an Authorization header using the Bearer scheme.

Where the API key is stored (`chrome.storage.local` vs `chrome.storage.session`) is `product-design.md` open question 7. The settings store is the single point that will change when that question is resolved.

### 3.7 Storage gateway

The single module that talks to `chrome.storage.local`. Its responsibilities:

- Provide read/write primitives for the persisted records: settings, the per-profile session list, the per-profile last active session id, the per-profile last selected model id, and the per-session message history including any captured `serverSessionRef`.
- Namespace records by profile key so that profile-scoped data (sessions, last active session, last selected model) cannot leak across profiles (per 9.6).
- Be the only writer for chat data. Other modules call it through a typed interface; they do not touch `chrome.storage` directly. This keeps the storage schema in one place and makes it possible to migrate the schema later without grepping the codebase.
- Expose a small change-notification surface so that — should two side panel pages ever be open in the same browser profile (e.g. two windows) — a delete or rename in one is reflected in the other on its next read. v1 does not promise live cross-window sync for streaming output.

The exact storage key naming, schema versioning, and migration rules will be specified alongside the persisted record shapes in a future revision of this document; they are not part of the public API contract and therefore do not belong in `api-contract.md`.

### 3.8 API client (ChatTransport)

The single module that calls the Hermes API server. It hides the transport choice behind a `ChatTransport` interface so that the v1 default (Chat Completions) and a future Responses implementation (per `product-design.md` 8.3) can coexist without the controllers, session manager, or stream handler changing.

Responsibilities:

- Take a "send a message in this conversation" request from a controller — model id, the message history the front end currently considers authoritative, an `AbortSignal`, an `Idempotency-Key` (per 7.5), and an optional `serverSessionRef` (per 7.3) — and translate it into the appropriate HTTP call.
- Attach an Authorization header using the Bearer scheme only when an API key is set; attach `X-Hermes-Session-Id` only when `Reuse Hermes server-side session` is on **and** a `serverSessionRef` is available (per 7.3 and 8.1).
- Issue the `fetch` against the active profile's base URL.
- Hand the response to the stream handler (for streaming) or return the parsed body (for non-streaming).
- Provide auxiliary calls for the connection lifecycle: `GET /v1/models` (per 8.2), `GET /health` and/or `GET /v1/health` (per 8.2; the semantic difference between the two is `product-design.md` open question 5).
- Map HTTP and network outcomes into the small error vocabulary the controllers consume (failed-to-send, stream-interrupted, model-list-empty, permission-not-granted, CORS-rejected, timeout). The exact mapping from HTTP status and SSE error events to those outcomes belongs in `api-contract.md`.

The `ChatTransport` interface is the seam. v1 ships exactly one implementation, `ChatCompletionsTransport`. A future `ResponsesTransport` will be a sibling implementation that the controllers can swap to without changes (see section 6).

### 3.9 Stream handler

Consumes a streaming HTTP response from the API client and emits parsed events to the session manager. Responsibilities:

- Decode `text/event-stream` framing.
- Distinguish standard OpenAI-compatible delta chunks from `hermes.tool.progress` events. Delta chunks become `appendStreamDelta` calls into the session manager; tool-progress events update an in-memory tool-progress projection on the agent message (their content is **not** appended to the message text, per `product-design.md` 7.4).
- Detect a clean end-of-stream and route it to `finalizeAgentMessage(..., { outcome: "ok" })`.
- Detect an aborted stream caused by the user pressing `Stop` (the abort came through the session's `AbortController`) and route it to `finalizeAgentMessage(..., { outcome: "stopped" })`.
- Detect a stream that cut without user action and route it to `finalizeAgentMessage(..., { outcome: "interrupted" })`, which the UI surfaces as the `Connection interrupted` badge with `Continue` (per 7.6 and section 10).
- Detect a send that fails before any bytes arrive and route it to `markUserMessageFailed`, leaving no agent placeholder behind (per 7.6).

The exact JSON field names of the delta and tool-progress events belong in `api-contract.md`. The stream handler depends on those shapes through a parser surface, not by inlining field names throughout the module.

### 3.10 Permission broker

The single module that calls `chrome.permissions`. Responsibilities:

- On a cross-profile save in the profile manager, check whether the new origin is already covered by static or previously-granted host permissions, and trigger `chrome.permissions.request({ origins: [...] })` if not (per 9.3).
- Surface the result back to the controller so the UI can show either the granted state or the `Permission denied` banner from `product-design.md` section 10.
- Subscribe to `chrome.permissions.onAdded` / `onRemoved` so that a permission granted or revoked from elsewhere (extension settings page, another window) updates the panel's view model.

Loopback (the default `http://127.0.0.1:8642/*`) is shipped in static `host_permissions` and does not require this flow.

### 3.11 Background service worker

Minimal in v1. Responsibilities:

- Configure `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` so the toolbar icon opens the panel directly (per `product-design.md` section 3).
- Handle install/update lifecycle hooks if defaults need seeding (e.g. populating an initial `API base URL` suggestion the first time the user opens the panel).
- Optionally relay `chrome.permissions` events that may fire while the panel is closed, so they are observable on next open. v1 does not require this if the permission broker re-reads permission state on panel open.

The service worker is **not** part of the chat data path in v1. It does not hold conversation state, does not call the Hermes API, does not own `AbortController`s, and does not buffer streams.

---

## 4. State ownership

This section is normative for v1. It enumerates every piece of runtime state, says which module owns it, and says where it lives.

### 4.1 In-memory only (lost on panel close)

These pieces are never written to `chrome.storage.local`. Closing the panel ends the page and drops them.

- **Empty drafts** (per 7.6). Owned by the session manager. A draft has a tentative `id` and the currently selected `modelId` and lives only until either the user sends the first message (promoting it to a persisted session) or the panel closes.
- **Per-profile draft input text** (per 9.6). Owned by the profile manager. Profile-scoped, in-memory only, swapped when the active profile changes, dropped on panel close. Connection failures do not clear it.
- **`AbortController` per in-flight send.** Owned by the session manager. There can be more than one at a time (one per streaming session).
- **Client `Idempotency-Key` per in-flight user message** (per 7.5). Owned by the session manager. Reused on `Retry`; replaced on `Continue`.
- **The view model.** Owned by the view model module. Recomputed on every input change.
- **Cached `GET /v1/models` result for the current profile.** Owned by the API client. Re-fetched on connection or key change (per 8.2 and 9.6).
- **Last `/health` outcome and the connection status it implies.** Owned by the API client / controllers. Drives the status dot.
- **In-progress tool-progress projection for an agent message that is currently streaming.** Owned by the session manager via the stream handler. Whether any final tool-progress summary is persisted with the message is left to a later revision; v1 should at minimum persist the final agent message text and badge.

### 4.2 Persisted in `chrome.storage.local` (survives panel close, browser close, restart)

These pieces are durable across panel lifetimes. They are namespaced by **profile key** wherever 9.6 requires per-profile scoping.

- **Settings** (global, not per profile): API base URL (the field whose value resolves into a profile key), API key, default model, Enter behavior, streaming on/off, `Reuse Hermes server-side session`, `Idempotency-Key` behavior. The current API base URL also implies the active profile.
- **Per-profile session list**: each session's `id`, `title`, `createdAt`, `updatedAt`, `modelId`, and `messages[]` including the per-message badge state (`Failed to send`, `Stopped`, `Connection interrupted`) and the user-message client `Idempotency-Key` needed for `Retry` (per 7.6).
- **Per-profile last active session id** (per 9.6). Used to rehydrate the panel on reopen and after a cross-profile switch.
- **Per-profile last selected model id** (per 9.6). Used to drive the dropdown on rehydrate.
- **Per-session optional `serverSessionRef`** (per 7.3). Captured when the user has `Reuse Hermes server-side session` on and the Hermes API contract surfaces a reference. Dropped only when the local session itself is deleted.
- **Granted host permissions.** Owned by Chrome (`chrome.permissions`), not by `chrome.storage.local`, but listed here because the permission broker depends on durable state.

### 4.3 Things explicitly **not** persisted

To make the boundary unambiguous, the following are **not** written to `chrome.storage.local` in v1:

- Empty drafts and per-profile draft input text (per 7.6 and 9.6).
- In-flight `AbortController`s.
- The view model itself.
- The `GET /v1/models` cache and the latest `/health` result.
- Telemetry of any kind (v1 ships no telemetry, per 9.5).

### 4.4 Things owned by the Hermes server, not by the extension

These are listed to make the source-of-truth split explicit:

- The conversation context the model actually consumed for any given turn — v1's transport sends the full local history each time (per 7.2), so the server does not retain it across requests by default.
- Server-side session state behind `serverSessionRef` (per 7.3 and 9.6). The extension treats this reference as a continuation hint, not as the authoritative record of the conversation. Local lifecycle events never call the Hermes server to mutate server-side session state (per 7.6).
- Tool execution and any side effects of tool calls.

---

## 5. Key data flows

This section walks through the flows that exercise the lifecycle rules in 7.6 and 9.6. Each flow is a normative description of the module sequence; it is not a prescription of function names.

### 5.1 Cold panel open

1. UI shell mounts.
2. Storage gateway reads settings.
3. Profile manager normalizes the saved API base URL into a profile key. This is the active profile.
4. Storage gateway reads the per-profile session list, last active session id, and last selected model id for that profile.
5. Session manager rehydrates: if the last active session id still exists, it becomes active; otherwise the most recently updated session for that profile becomes active; otherwise the empty-state card is shown and no session is created (per 7.6).
6. API client fires `/health` (status dot) and `GET /v1/models` (model dropdown). If the active session's `modelId` is missing from the result, the model fallback rule from 9.6 runs.
7. View model is computed; the UI shell renders.

### 5.2 Send a message in an empty draft (first send promotes the draft)

1. Controller asks the session manager to promote the empty draft. Session manager creates `createdAt`, `updatedAt`, derives a default `title` from the first user message (truncated; user can rename later, per 7.6), writes the new session row through the storage gateway, and adds it to the session list.
2. Controller asks the session manager to append the user message and an agent placeholder; both are persisted immediately (per 7.6, so a panel reload mid-stream does not lose the prompt).
3. Controller opens an `AbortController` and a client `Idempotency-Key` for this send.
4. Controller asks the API client to issue a streaming Chat Completions request with the current model id, the full local history (per 7.2), the optional `serverSessionRef` (per 7.3), and the controller's `AbortSignal` and `Idempotency-Key`.
5. Stream handler decodes the response and feeds deltas into the session manager, which writes them through the storage gateway as they arrive. `hermes.tool.progress` events update the in-memory tool-progress projection.
6. On clean end-of-stream the agent message is finalized, `updatedAt` is bumped, the session returns to **Idle**, and the `AbortController` and `Idempotency-Key` are discarded.

### 5.3 Stop, Retry, Continue

- **Stop**: controller calls `AbortController.abort()` for the active session; the stream handler emits `outcome: "stopped"`; session manager finalizes the partial agent message with the `Stopped` badge. No retry is implied (per 7.6).
- **Retry on a failed user message**: controller looks up the same client `Idempotency-Key` stored on that user message (per 7.5 and 7.6) and re-issues the send in place. It is **not** a new user message.
- **Continue on an interrupted agent message**: controller issues a fresh send with the existing conversation and a **new** `Idempotency-Key` (per 7.6 and section 10 of `product-design.md`). v1 does not implement resume-from-offset.

### 5.4 Switch session while a stream is running

1. Controller asks the session manager to change the active session id; the originating session keeps its in-flight `fetch`.
2. The originating session's stream handler keeps writing deltas through the storage gateway against the originating session id, regardless of which session the view model is showing (per 7.6).
3. The originating session shows a small "Streaming…" indicator in the session list (per 7.6 — UI shape finalized in `ui-spec.md`).
4. Switching back rebuilds the view model from the originating session's persisted state, which already includes the freshly-written deltas. The user sees the live stream from its current position.

### 5.5 Cross-profile save (different normalized base URL)

1. Settings store persists the new URL.
2. Profile manager normalizes it and detects a different profile key from the previous one.
3. For every in-flight send in the previous profile's sessions, the session manager calls `AbortController.abort()`. v1 does not retry or replay these sends against the new endpoint (per 9.6).
4. Profile manager swaps the visible session list to the list scoped to the new profile. The previous profile's session rows remain in `chrome.storage.local` under the old profile key and reappear unchanged if the user points back at that URL (per 9.6).
5. Permission broker checks whether the new origin needs a runtime permission grant (per 9.3); if so, the UI surfaces the `Grant access` banner and any send is blocked until the user grants it.
6. API client fires a fresh `/health` and `GET /v1/models` against the new URL. The model fallback rule from 9.6 runs against the active session for the new profile.
7. The new profile's draft input — which lives in memory under that profile — is shown in the input box. If it has none, the input box is blank (per 9.6).
8. If the new profile has never been used before, the empty-state card is shown and no session and no draft are auto-created (per 9.6).

### 5.6 Same-profile save (only whitespace or trailing slash changed)

Profile manager detects an unchanged profile key. Nothing visible changes. The current session, draft input, streaming state, and model selection are preserved (per 9.6).

### 5.7 API key change only (same profile)

1. Settings store persists the new key.
2. Profile manager confirms the profile key is unchanged.
3. The visible session list, the current active session, draft input, and streaming state are all preserved. An in-flight request is **not** aborted by a key edit alone — the user must explicitly press `Stop` to cancel a stream still using the old key (per 9.6).
4. The next send uses the new key. Prior messages are not retroactively re-authenticated.
5. API client re-fetches `GET /v1/models` because the model set may differ for a different key (per 9.6).

### 5.8 Connection failure (any kind)

A failed `/health`, a denied runtime permission (per 9.3), a CORS rejection (per 9.4), a DNS failure, a TLS failure, a network outage, a 401, or a 403 leaves every local session and its messages intact (per 9.6). The UI may disable sending and show the relevant row from `product-design.md` section 10. Local sessions are **never** deleted by a connection-level event. Draft input is **never** cleared by a connection failure. Deletion of local sessions remains only ever user-initiated (per 7.6 and 9.6).

### 5.9 Panel close

The side panel page ends. All in-flight `fetch` calls are aborted via their `AbortController`s. Empty drafts and per-profile draft input text are dropped from memory. On reopen, partial agent messages that were mid-stream at close look the same as a `Stopped` message (per 7.6). v1 does **not** move requests into the service worker to keep them alive past a panel close.

---

## 6. Future seam: Responses API and beyond

`product-design.md` 8.3 reserves room for the Responses API to land later as an additional transport without disturbing the rest of the architecture. The architectural seam is the `ChatTransport` interface in section 3.8.

What this means concretely:

- **The seam lives at the API client.** Controllers, session manager, stream handler, view model, and UI shell ask the API client for a "send" without naming the underlying endpoint. v1 ships exactly one implementation (`ChatCompletionsTransport`); a future `ResponsesTransport` is a sibling implementation chosen by configuration.
- **The session manager is unchanged by the seam.** Local lifecycle from 7.6 is owned by the front end regardless of whether the transport is stateless (Chat Completions) or stateful (Responses with `previous_response_id` / `conversation`). A Responses-backed session that holds server-side state is still subject to the rule in 7.6 and 7.3 that the local session is the source of truth.
- **`serverSessionRef` generalizes naturally.** Today it is the optional pointer used to attach `X-Hermes-Session-Id` against Chat Completions (per 7.3). Under a Responses transport it would carry whatever continuation reference the Responses API exposes (e.g. a `previous_response_id`). The session manager treats it as an opaque per-session value; the API client decides how to use it for the chosen transport.
- **The stream handler will need a parallel parser path.** Responses streams structured events (`function_call`, `function_call_output`, etc., per 8.3) instead of OpenAI-compatible deltas. That is a parser-surface change inside the stream handler module; it does not fan out into other modules.
- **The Runs API (per 8.4) is even further out** and would land as a richer tool-progress visualization that consumes `GET /v1/runs/{run_id}/events`. The current `hermes.tool.progress` projection on the agent message is the placeholder it would eventually replace.

v1 must therefore avoid baking Chat Completions specifics into anything **except** `ChatCompletionsTransport` and the Chat-Completions branch of the stream parser. In particular: no controller should know about OpenAI delta chunk shapes, and no session manager primitive should be named after a Chat Completions field.

---

## 7. Open architecture questions

These items affect module boundaries or state ownership and should be resolved before the corresponding module is built. They are deliberately separate from the product-level open questions in `product-design.md` section 12.

1. **Storage schema versioning.** When the per-session record shape changes, how does the storage gateway migrate existing rows on panel open, and how is a half-migrated state recovered from? Until this is decided, the storage gateway should write a schema-version field on every record so future migrations have a starting point.
2. **Cross-window concurrency.** If two side panel pages are open against the same browser profile, how do they reconcile concurrent edits to the same session (e.g. a rename in one, a delete in the other)? v1 will likely take a last-write-wins approach with a notification on the next read, but the gateway needs to decide that explicitly.
3. **Persistence of tool-progress state.** How much of the in-memory tool-progress projection is persisted alongside a finalized agent message? At minimum the final tool name(s) and a status; the exact shape depends on `product-design.md` open question 9.
4. **Where to draw the line between controllers and view model on transient UI banners.** Banners like `Model {old} isn't available on {host}. Sends now use {new}.` (per 9.6) are not message-level state. Whether they live in the view model or in a separate banner store is a small but real boundary call that should be made before the UI shell is built.
5. **Service worker scope creep.** The v1 service worker is intentionally near-empty. Any future request to give it more responsibility (e.g. keeping a long-running send alive past a panel close, per the evolution list in `product-design.md` section 11) should be evaluated against the cost of moving chat state out of the side panel page and into a context Chrome may terminate.

---
