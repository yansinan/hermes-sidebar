# hermes-sidebar — Product Design (Draft)

## 1. Purpose and current assumptions

This document is the product-design spine for `hermes-sidebar`. Its job is to align maintainers and contributors on the **product boundary**, the **interaction principles**, and the **state and lifecycle rules** that govern the extension and the way it talks to a Hermes Agent API server. **It does not contain implementation code.**

### What this document owns vs. its companions

To keep each document focused, the design set is split along fixed boundaries. This file owns the product layer; the companion docs listed in [docs/README.md](./README.md) own everything downstream:

- **This document** — product boundary and positioning, scenarios, information architecture, conversation/session model and lifecycle rules, interaction principles, permissions and security posture, v1 scope and non-goals, open questions.
- **[architecture.md](./architecture.md)** — internal module breakdown (side panel page / service worker / storage / API client), responsibility boundaries, and runtime data flows.
- **[api-contract.md](./api-contract.md)** — the exact wire contract against the Hermes API server: endpoints, request/response shapes, SSE event shapes, error-code mapping.
- **[ui-spec.md](./ui-spec.md)** — visual specification, component inventory, interaction details, accessibility.
- **[dev-setup.md](./dev-setup.md)** — how the developer loop is intended to work once implementation lands.

When this document references system structure, a wire-level shape, a visual detail, or a developer workflow, it does so only at the level needed to state a product rule; the companion doc is authoritative for the detail.

### Current assumptions

- **Design-first stage.** No extension code exists in the repo yet. This document is written from requirements and from the Hermes API server's documented capabilities — it is not a summary of an existing implementation.
- **Runtime target.** Chrome 114+ (the Side Panel API became stable in this version), Manifest V3.
- **Connection target.** A Hermes Agent API server reachable over HTTP(S). The default suggested address is `http://127.0.0.1:8642` (a local Hermes), but the extension must equally support a remote Hermes instance the user has deployed themselves.
- **Deployment is the user's responsibility.** This project does **not** prescribe how Hermes is run — local process, LAN host, container, remote VM, or behind a reverse proxy with TLS are all valid. The extension treats the Hermes endpoint as opaque and only requires that it speaks the Hermes API server contract.
- **User profile.** Developers and power users who can stand up a Hermes Agent on their own — not end users with no technical background.
- **Open source.** The project is open source; design documents live alongside the code in this repo.

### Reference sources

- Chrome Side Panel API: <https://developer.chrome.com/docs/extensions/reference/api/sidePanel>
- Manifest V3 migration and `host_permissions`: <https://developer.chrome.com/docs/extensions/develop/migrate/manifest>
- MDN `host_permissions`: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions>
- Hermes API server documentation: `hermes-agent/website/docs/user-guide/features/api-server.md`
- Hermes API server with Open WebUI: `hermes-agent/website/docs/user-guide/messaging/open-webui.md`
- Hermes API server implementation: `hermes-agent/gateway/platforms/api_server.py`

---

## 2. Goals and non-goals

### Goals

- Provide a clean, low-friction Hermes Agent chat surface inside the Chrome side panel.
- Let "ask the agent something quickly" and "browse the web" happen in parallel without window or tab switching.
- Reuse what the Hermes API server already does (OpenAI-compatible Chat Completions, model listing, health checks, SSE streaming, session continuation). Do **not** rebuild any of that on the front end.
- Support **both** local Hermes instances and remote Hermes instances behind the same UI, with a connection model that does not assume one over the other.
- Keep an architectural seam for migrating to the Responses API later (structured tool events, server-side conversation state).

### Non-goals (explicitly out of scope for v1)

- No content-script-based "understand the current page" feature.
- No local RAG, no embedded vector store, no document management UI.
- No account system, no login, no cloud message sync.
- No hosted relay service. The extension only ever talks to the Hermes endpoint **the user configured**.
- No multi-user collaboration or shared sessions.
- No attempt to replace full agent operations dashboards such as Open WebUI.
- No opinion on **how** the user's Hermes Agent is deployed — that is owned by the user, not by this project.

---

## 3. Why a Chrome Side Panel (instead of a popup or a full tab)

- **Popups close when the user clicks anywhere else.** That is hostile to "read and ask in parallel" — losing your half-typed prompt because you clicked the page is unacceptable.
- **A standalone tab** fully separates the agent from the browsing context, which removes the entire reason for living inside the browser.
- **The Side Panel** is a first-class Chrome 114+ extension surface, docked to the side of the window, opened and closed explicitly by the user. It fits a long-running conversation.
- The Side Panel is an extension page, so it can use `chrome.*` APIs and can `fetch` allowed origins (local or remote) declared via `host_permissions`. The technology base is stable.
- Calling `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` lets the toolbar icon directly open the panel — a one-click entry point.

Decision: the v1 UI surface is locked to the Side Panel. There is no popup fallback.

---

## 4. Typical scenarios

1. **Quick question while reading.** The user is reading a long document; they paste a paragraph into the side panel and ask "summarize this in one sentence." (v1 does not auto-extract page content — they paste it themselves.)
2. **Writing assistance.** The user drafts an email or doc in one tab and uses the side panel agent to rewrite, polish, or check grammar without switching windows.
3. **Developer / debugging companion.** A developer running Hermes locally with custom skills triggers tools or pulls information through the side panel instead of swapping back to a terminal.
4. **Connecting to a shared remote Hermes.** A user has deployed Hermes on a remote machine (their own server, a LAN box, a VM behind a reverse proxy) and points the side panel at that endpoint. The experience should be the same as local — only the connection settings differ.
5. **Conversation continuity.** After closing and reopening the side panel, the user sees the prior conversations and can resume any of them.

Counter-examples (explicitly **not** supported in v1):

- "Read the whole current page for me" — needs a content script and reliable extraction; deferred.
- "Summarize across multiple tabs" — same reason.

---

## 5. Information architecture

The side panel is a single page laid out as three regions plus a settings drawer:

```
┌──────────────────────────────────────┐
│  Top: connection & session switch    │  ← connection status / current model / session switch
├──────────────────────────────────────┤
│                                      │
│  Middle: conversation area           │  ← message stream, streaming output, tool progress
│                                      │
│                                      │
├──────────────────────────────────────┤
│  Bottom: input area                  │  ← multiline input, send, stop
└──────────────────────────────────────┘
        ⚙ Settings drawer (slides in from top or bottom)
```

Design principles:

- **One screen for the main flow.** Connect → choose model → type → see streamed output, with no page navigation.
- **Settings live in a drawer or secondary view.** Settings change rarely; they should not fight the conversation for space.
- **Session list is not always visible.** The side panel is narrow; the session list is a drawer / popover so it does not steal width from the conversation.

---

## 6. Region-by-region design

### 6.1 Top — connection & session region

- Show the current API base URL in shortened form (e.g. `127.0.0.1:8642` or `hermes.example.com`). Click to open the settings drawer.
- A small status dot represents connection health: green = healthy, yellow = connecting, red = failed. Clicking it triggers a fresh `/v1/health` check.
- A current-model dropdown populated from `GET /v1/models`. Switching models does **not** destroy the active conversation; only subsequent messages use the new model.
- A "Sessions" button opens the session list drawer for create / switch / delete / rename.

Example UI copy:

- Status dot tooltip (healthy): `Connected to {hostShort}`
- Status dot tooltip (connecting): `Connecting to {hostShort}…`
- Status dot tooltip (failed): `Cannot reach {hostShort}. Click to retry.`
- Sessions button label: `Sessions`

### 6.2 Middle — conversation area

- Messages flow top to bottom in chronological order. User messages right-aligned, agent messages left-aligned (or all left-aligned with avatars — the visual decision lives in [ui-spec.md](./ui-spec.md)).
- Markdown rendering: code blocks, lists, tables. Code blocks have a copy button.
- **Streaming output** appears character-by-character (or token-by-token). While output is streaming, a `Stop` button is shown at the bottom.
- Tool calls are surfaced via collapsible blocks driven by `hermes.tool.progress` SSE events. v1 only shows `Calling tool {name}…` / `Tool {name} finished`, without expanding full arguments or returns — keeping the side panel readable.

Example UI copy:

- Stop button: `Stop`
- Tool progress (in progress): `Calling tool {toolName}…`
- Tool progress (done): `Tool {toolName} finished`
- Copy code button: `Copy`
- Code copied confirmation: `Copied`

### 6.3 Bottom — input area

- Multiline input box. Default: Enter sends, Shift+Enter inserts a newline. The reverse can be configured in settings.
- Two buttons on the right: `Send` and `Stop` (mutually exclusive).
- Below the input, a small caption shows the current model name and a character count. v1 does **not** attempt accurate token counting — it requires extra calls and is not worth the complexity for a v1 hint.

Example UI copy:

- Input placeholder: `Ask Hermes anything…`
- Send button: `Send`
- Caption: `Model: {modelId}  ·  {charCount} chars`

### 6.4 Settings drawer

Sections:

- **Connection.** API base URL, API key (optional), `Test connection` button. The base URL field accepts both local (`http://127.0.0.1:8642`) and remote (`https://hermes.example.com`) values.
- **Conversation.** Default model, Enter behavior, streaming on/off (default on).
- **Advanced.** Whether to attach `Idempotency-Key` automatically; whether to enable `X-Hermes-Session-Id` to reuse an existing Hermes server-side session (this capability requires the Hermes server to have `API_SERVER_KEY` configured — see section 8).
- **About.** Version, license, link to documentation.

Example UI copy:

- API base URL label: `API base URL`
- API base URL helper: `Local example: http://127.0.0.1:8642  ·  Remote example: https://hermes.example.com`
- API key label: `API key (optional)`
- API key helper: `Sent as Authorization: Bearer <API_SERVER_KEY>  ·  Stored locally in your browser`
- Test connection button: `Test connection`
- Test connection result (ok): `Connected. {modelCount} models available.`
- Test connection result (fail): `Could not reach {host}: {reason}`
- Reuse Hermes server-side session label: `Reuse Hermes server-side session (X-Hermes-Session-Id)`
- Reuse Hermes server-side session helper: `Requires the Hermes server to have API_SERVER_KEY configured.`

---

## 7. Conversation and session model

### 7.1 What "session" means

From the front-end's point of view, a session is one message history the user sees in the UI. A session is persisted locally with: `id`, `title`, `createdAt`, `updatedAt`, `modelId`, `messages[]`, and an optional `serverSessionRef` (see 7.3).

### 7.2 How conversation context is sent to the backend

v1 takes the simplest workable strategy: **the front end owns the history, and the entire history is sent on every request.**

- Default channel: Chat Completions (`POST /v1/chat/completions`). The `messages` array in the request body is composed by the front end from local history.
- This makes the backend stateless from the conversation's point of view; the front end is the source of truth.
- Upside: simplest implementation, easiest to migrate to any other OpenAI-compatible backend.
- Downside: long conversations grow the request body. Token cost is controlled by the front-end's truncation policy (v1 keeps the most recent N messages plus the leading system message; the exact rule is finalized in [architecture.md](./architecture.md)).

### 7.3 When to use Hermes server-side sessions

The Hermes API server offers two "continuation" mechanisms:

1. The `X-Hermes-Session-Id` header on Chat Completions, which attaches a request to an existing Hermes session. Documentation states this requires `API_SERVER_KEY` to be configured on the Hermes side.
2. The Responses API's `previous_response_id` / `conversation`, where the server holds response state and the client only needs a reference.

v1 strategy:

- Default off. Keep the front end as source of truth and the backend stateless.
- Provide an Advanced toggle, `Reuse Hermes server-side session`. When on, the front end stores a `serverSessionRef` for that session as soon as the Hermes API contract specifies where the reference is surfaced (open question 2), and attaches `X-Hermes-Session-Id` on subsequent requests. Regardless of how the reference is obtained, the local session remains the source of truth; `serverSessionRef` is a continuation hint, not the authoritative record of the conversation. The setting must clearly state that this requires the user's Hermes server to have `API_SERVER_KEY` configured.
- The Responses API path is reserved for the evolution in 8.3 and is **not** part of v1's default transport.

### 7.4 Streaming and interruption

- Default uses SSE streaming; the front end consumes `text/event-stream`.
- The `Stop` button aborts the in-flight `fetch` via `AbortController`. Whatever has been received so far is kept as the message body, marked `Stopped`.
- `hermes.tool.progress` events update the tool-progress collapsible block; their content is not appended to the message text.

### 7.5 Idempotency

- For non-streaming requests, the front end generates a client UUID per user message and attaches it as `Idempotency-Key`, so transient retries do not double-submit.
- For streaming requests, v1 does not require an `Idempotency-Key`. (Whether the Hermes server accepts/honours it on streaming requests is open question 4.)

### 7.6 Local session lifecycle

This subsection is normative for v1. The lifecycle is owned entirely by the side panel; the Hermes server is not consulted to drive any of these transitions.

#### States a session can be in

A session is in exactly one **session-level state** at any moment:

- **Empty draft.** Lives only in memory. Has a tentative `id` and the currently selected `modelId`, but no messages, no `createdAt`, no entry in the session list, and no row in `chrome.storage.local`. Promoted to a persisted session as soon as the first send begins; it then immediately enters **Streaming** for that request (see the lifecycle table).
- **Idle.** Persisted in `chrome.storage.local` and shown in the session list; no in-flight request. Input is enabled. Default state between sends.
- **Streaming.** Persisted, with a request in flight. The `Stop` button replaces `Send` for this session.

Once a send resolves — normally, by user stop, by error, or by a dropped stream — the session transitions back to **Idle**. The outcome of that send is then surfaced as a **message-level badge** on the most recent message, not as a separate session state:

- **Failed to send** — attached to the user's message when the send returned a non-2xx, timed out, or had no permission to reach the host. A `Retry` action is offered beside the badge.
- **Stopped** — attached to the partial agent message when the user pressed `Stop` mid-stream.
- **Connection interrupted** — attached to the partial agent message when the stream cut mid-response without user action. A `Continue` action is offered (per section 10, `Continue` re-sends the conversation in v1; it is not resume-from-offset).

#### Lifecycle table

| Event | What happens |
| --- | --- |
| Panel opens for the first time, ever | Empty-state card from section 10 is shown. **No session is created yet.** |
| User clicks `New session` | An empty draft is created in memory. It is **not** added to the session list and **not** written to storage. |
| User opens the panel and an empty draft already exists from a prior `New session` click | The same empty draft is reused. The panel never accumulates multiple unsent drafts. |
| User sends the first message in an empty draft | The draft is promoted to a persisted session: `createdAt` and `updatedAt` are set, the session is written to `chrome.storage.local`, it appears in the session list, and a default `title` is derived from the first user message (truncated to a fixed length; user can rename later). The send proceeds against this newly persisted session. |
| Request starts streaming | The session enters **Streaming**. The user message and a placeholder agent message are appended and persisted immediately, so a panel reload mid-stream does not lose the prompt. |
| Stream completes normally | The agent message is finalized, `updatedAt` is bumped, the session returns to **Idle**. |
| User presses `Stop` | The in-flight `fetch` is aborted via `AbortController`. Whatever has been received so far is kept and the agent message is marked `Stopped`. The session returns to **Idle**. No retry is implied. |
| Send fails before any bytes arrive | The user message is marked `Failed to send` with `Retry`. No agent placeholder is left behind. The session returns to **Idle**. |
| Stream cuts mid-response with no user action | The received portion is kept with `Connection interrupted` and a `Continue` button (section 10). |
| User clicks `Retry` on a failed message | The same client-side `Idempotency-Key` is reused (7.5). The retry replaces the failed send in place; it is **not** a new user message. |
| User clicks `Continue` on an interrupted message | A fresh send is issued with the existing conversation. It receives a new `Idempotency-Key`. |
| Panel is closed (toggled off, window or browser closed) | Nothing is proactively saved beyond what was already persisted during streaming. The in-flight `fetch` is owned by the side panel page, so closing the panel ends that page and therefore aborts the request. On reopen, the partial agent message looks the same as a `Stopped` message. v1 does **not** move requests to a service worker to keep them alive past a panel close — that is on the evolution list in section 11. |
| Panel is reopened | The panel rehydrates from `chrome.storage.local`: the active session id, all persisted sessions, and the last selected model. If the active session id no longer exists (e.g. deleted from another window), the panel falls back to the most recently updated session, or to the empty-state card if there are none. |
| User switches to another session while a request is streaming | The streaming request is **not** cancelled. Streamed tokens continue to be written to the originating session in storage; they do not appear in the now-visible session. The originating session shows a small "Streaming…" indicator in the session list. Switching back resumes showing the live stream from its current position. |
| User starts a send in session B while session A is still streaming | Allowed. Each session owns its own `AbortController` and `Idempotency-Key`. v1 does not impose a global single-flight limit. |
| User renames a session | The title is updated locally and `updatedAt` is bumped. No backend call. If `Reuse Hermes server-side session` is on, the rename does **not** propagate — the Hermes server never learns the local title. |
| User deletes a session | If a request was in flight in that session, it is aborted first. The session row is then removed from `chrome.storage.local`. The local `serverSessionRef`, if any, is dropped along with the row; v1 does **not** call any "delete server-side session" endpoint. Cleaning up server-side state is the user's responsibility. |
| User deletes the currently active session | After deletion the panel falls back to the most recently updated remaining session, or to the empty-state card if none remain. No empty draft is auto-created. |
| All sessions are deleted | The panel returns to the empty-state card. No empty draft is auto-created until the user acts. |

#### Relationship to Hermes server-side sessions

The lifecycle above is entirely local. `serverSessionRef` (7.3) is an **optional pointer** a local session may carry when `Reuse Hermes server-side session` is enabled. Specifically:

- A local session can exist with no `serverSessionRef`. This is the v1 default.
- When the toggle is on, the front end records a `serverSessionRef` for the session at whatever point the Hermes API contract says the reference becomes available (open question 2). Subsequent sends in that session attach `X-Hermes-Session-Id` derived from the stored reference.
- Turning the toggle off does not delete a captured `serverSessionRef` — it just stops attaching the header. Turning it back on resumes attaching the same reference.
- Local lifecycle events (create, rename, delete, switch, retry, panel close) **never** call out to the Hermes server to mutate server-side session state. The local session is the source of truth; `serverSessionRef` is only a pointer used to opt into server-side continuation.

This preserves the v1 stance that the **front end is the source of truth**: the server-side reference is a continuation hint, not the authoritative record of the conversation.

---

## 8. Interaction with the Hermes API server

### 8.1 Default channel — Chat Completions

All v1 normal conversation goes through `POST /v1/chat/completions`:

- **Why this one.** Highest OpenAI compatibility, most mature, lowest front-end implementation cost; community streaming-parser patterns apply directly.
- **Request shape.** Standard `messages` array plus `model` plus `stream: true | false`.
- **Response shape.** Non-streaming: a single completion. Streaming: standard OpenAI delta chunks, possibly interleaved with `hermes.tool.progress` custom events.
- **Headers we may attach:**
  - `Idempotency-Key` (non-streaming, automatic).
  - `X-Hermes-Session-Id` (only when the user has explicitly turned on `Reuse Hermes server-side session`).
  - `Authorization: Bearer <API_SERVER_KEY>` (only if the user filled in an API key in settings).

### 8.2 Auxiliary endpoints

- `GET /v1/models` — fetched once after a successful connection to populate the model dropdown. Re-fetched when the base URL or API key changes.
- `GET /health` and/or `GET /v1/health` — drives the connection status dot via low-frequency polling (e.g. every 30s) plus an immediate retry when the panel comes back into focus. The semantic difference between the two is tracked in open question 5.

### 8.3 Future-ready channel — Responses API

`POST /v1/responses` improves on Chat Completions in two ways relevant here:

- It supports `previous_response_id` and `conversation`, so the server can hold session state and the client does not need to resend full history.
- Its streaming events are more structured (`function_call`, `function_call_output`, etc.), enabling richer tool-call visualizations.

The v1 architecture reserves a `ChatTransport` abstraction whose default implementation is Chat Completions; a Responses implementation can be added later **without** changing the UI layer. v1 explicitly does **not** ship the Responses implementation — keeping scope narrow.

### 8.4 Further out — Runs API

The Hermes API server also exposes `POST /v1/runs` and `GET /v1/runs/{run_id}/events` for "start a run, then subscribe to a structured event stream." This is the right substrate for fully visualizing multi-step tool chains. v1 does not use it; it is on the evolution list.

---

## 9. Connection configuration, permissions, and the local-vs-remote model

### 9.1 User-configurable settings

- **API base URL.** Suggested default `http://127.0.0.1:8642`. Users can change it to any reachable HTTP(S) endpoint that speaks the Hermes API server contract (local, LAN, or remote). Both `http://` and `https://` schemes are supported; for remote hosts users should prefer `https://`.
- **API key.** Optional. When set, the front end sends `Authorization: Bearer <API_SERVER_KEY>`. Stored in `chrome.storage.local` by default. Whether to switch to `chrome.storage.session` for higher-risk deployments is open question 7.
- **Advanced toggles.** Streaming on/off, reuse Hermes server-side session, idempotency behavior.

### 9.2 Local vs remote — one connection model, no special-case UI

The extension does **not** distinguish local and remote in the connection model. Both go through the same `API base URL` field and the same request path. The differences are:

| Concern | Local Hermes (loopback) | Remote Hermes |
| --- | --- | --- |
| Suggested URL | `http://127.0.0.1:8642` | `https://hermes.example.com` (user-defined) |
| `host_permissions` | `http://127.0.0.1:8642/*` shipped by default (see 9.3) | Granted at runtime via `optional_host_permissions` (see 9.3) |
| Auth | API key optional; loopback isolation reduces blast radius | API key strongly recommended; the user owns transport security |
| TLS | Usually plain HTTP on loopback | User should terminate TLS upstream — out of scope for this project |
| CORS | May or may not need extra config — see open question 1 | The user's Hermes deployment **must** allow `chrome-extension://<id>` as an origin — see 9.4 |

Deployment shape — local process, container on the same machine, machine on the LAN, remote VM behind a reverse proxy — is **the user's choice**. The extension treats the configured endpoint as opaque.

### 9.3 Chrome extension permissions (least privilege)

Suggested `manifest.json` permission shape:

```jsonc
{
  "manifest_version": 3,
  "permissions": [
    "sidePanel",
    "storage"
  ],
  "host_permissions": [
    "http://127.0.0.1:8642/*"
  ],
  "optional_host_permissions": [
    "http://*/*",
    "https://*/*"
  ],
  "side_panel": {
    "default_path": "sidepanel.html"
  }
}
```

Principles:

- **Only the Chrome APIs we actually need.** `sidePanel` for the panel, `storage` for settings and sessions. v1 does **not** request `tabs`, `activeTab`, `scripting`, or `cookies` — there is no page-content reading.
- **Default `host_permissions` cover only the loopback default.** This is the convenience case (local Hermes on its default port). Per the MDN `host_permissions` reference, this gives the extension page `fetch`/`XMLHttpRequest` access to that origin.
- **Remote endpoints are granted at runtime via `optional_host_permissions`.** When the user enters a non-loopback base URL in settings, the extension prompts the user to grant permission for that specific origin via `chrome.permissions.request({ origins: [...] })`. This keeps the install-time permission prompt minimal while still letting the user point at any host they own.
- **No wildcard origins are ever requested at install time.** The `optional_host_permissions` declaration is a capability surface, not a grant — Chrome will still ask the user before any specific origin is enabled.

Example UI copy for the runtime grant flow:

- Setting blurb above the API base URL: `Local Hermes works out of the box. To connect to a remote Hermes you'll be asked to grant access to that host.`
- Permission grant button: `Grant access to {originShort}`
- Permission denied banner: `Permission for {originShort} was not granted. The extension cannot connect to that host until you allow it.`

### 9.4 CORS, especially for remote

When the side panel calls a Hermes server from `chrome-extension://<id>`, the server's CORS middleware decides whether the call is allowed.

- **Local case.** Whether Chrome treats extension-to-loopback calls as "no CORS needed" or as standard cross-origin is something we will verify in implementation — see open question 1.
- **Remote case.** Standard CORS applies. The user's remote Hermes deployment **must** include `chrome-extension://<id>` in its CORS allowlist (e.g. `API_SERVER_CORS_ORIGINS`). The extension cannot work around this — it is something the user configures on their Hermes side.

The documentation should not hard-code a conclusion. The recommended user-facing copy:

> If your first request fails with a CORS error in the console, add your extension ID `chrome-extension://<id>` to the Hermes server's `API_SERVER_CORS_ORIGINS` setting.

### 9.5 Security boundaries

- The extension only talks to the Hermes endpoint the user explicitly configured. It never sends requests to any third party.
- The extension does not collect telemetry in v1.
- The API key lives only in browser storage and is sent only as `Authorization: Bearer <API_SERVER_KEY>` to the configured endpoint. It is never written to logs or attached to any error report (v1 has no error reporting integration).
- Because the extension can connect to remote endpoints, the user is responsible for the security of that endpoint (TLS, auth, network policy). The project documentation makes this responsibility clear and does not provide a "managed" or "shared" Hermes.

### 9.6 Connection scoping and connection-change behavior

This subsection is normative for v1. It defines how local sessions relate to the configured Hermes endpoint, and what happens when the user edits that configuration. The rules here interlock with the local session lifecycle in 7.6 — they deliberately preserve the front-end-is-source-of-truth stance from 7.3 while making endpoint changes safe and legible.

#### What a connection profile is

Local sessions are **not** a single global list shared across every backend the user has ever pointed the panel at. They are scoped to a **connection profile**, keyed by the normalized API base URL (scheme + host + port + optional path prefix; a trailing slash is canonicalized). Concretely:

- `http://127.0.0.1:8642` and `http://127.0.0.1:8642/` resolve to the same profile.
- `http://127.0.0.1:8642` and `http://localhost:8642` do **not** resolve to the same profile. v1 performs no DNS canonicalization; the user's typed host is taken at face value.
- A profile owns the session list scoped to it, the last active session id, the last selected model id, and any captured `serverSessionRef`s (7.3) recorded against its sessions.
- A profile does **not** own the API key. The key is stored per profile but is treated as a credential, not as part of the profile's identity. Changing the key alone does not open a different namespace.

Rationale: the same local conversation cannot safely be replayed against a different backend — different model lists, different system prompts, different permissions, different tools, different governance. Treating each endpoint as its own namespace avoids silently sending a conversation originally authored against one backend into another.

v1 exposes the profile implicitly via the single `API base URL` field in settings; there is no labelled multi-profile picker. Whether v1 grows one is open question 12.

#### Changing the API base URL

When the user saves a base URL that normalizes to a **different** profile than the one currently loaded:

1. Any in-flight request in the previous profile is aborted via its `AbortController`. v1 does **not** retry or replay that send against the new endpoint.
2. The visible session list is swapped to the list scoped to the new profile. The previous profile's sessions are **not** deleted — they remain in `chrome.storage.local` under the old profile key and reappear unchanged if the user points back at that URL.
3. If the new profile has never been used before, the panel shows the empty-state card from section 10. No session is auto-created, and no empty draft is auto-created.
4. If the new profile has prior sessions, the panel rehydrates the last active session for that profile using the same rules as the `Panel is reopened` row in 7.6, scoped to the new profile.
5. The runtime permission flow (9.3) and a fresh `/health` check (8.2) run against the new URL before any send is allowed, and `GET /v1/models` is re-fetched.

When the user saves a base URL that normalizes to the **same** profile (e.g. they only edited whitespace or a trailing slash), none of the above happens. The current session, the draft input, streaming state, and model selection are preserved.

#### Changing only the API key

When the base URL stays on the same profile and only the API key changes:

- The visible session list is **unchanged**. The key is a credential, not a namespace.
- The current active session, its messages, its draft input, and its streaming state are preserved.
- An in-flight request is **not** aborted by a key edit alone; the user must explicitly press `Stop` to cancel a stream that is still using the old key.
- The next send uses the new key. Prior messages are not retroactively re-authenticated.
- `GET /v1/models` is re-fetched (8.2), since the available model set may differ for a different key.

#### Model list changes after reconnect

After a base-URL change, an API-key change, or a reconnect following an outage, the freshly fetched `GET /v1/models` may not contain the model the active session was using:

- If the active session's `modelId` is still present in the new list, it is kept as-is on the dropdown.
- If it is not present, existing messages keep the historical `modelId` they were actually answered with (the transcript must reflect reality), but the current-model dropdown falls back to the first model in the new list and surfaces a non-blocking banner in the conversation area.
- The session itself is not mutated, renamed, duplicated, or moved between profiles on a model fallback. The user can switch models again at any time.
- If the new model list is empty, sending is disabled per the `Model list empty` row in section 10.

#### Connection failures never delete local sessions

Local sessions are **never** deleted by a connection-level event:

- A failed `/health` check, a denied runtime permission (9.3), a CORS rejection (9.4), a DNS failure, a TLS failure, a network outage, a 401, or a 403 leave every local session and its messages intact in `chrome.storage.local`.
- The UI may disable sending and show the relevant row from section 10, but the session list, session bodies, and drafts are not touched.
- Sessions stay local and preserved while a connection is temporarily broken; when the endpoint recovers, the user resumes against the same sessions without any re-import step.
- Deletion of local sessions remains only ever user-initiated, per the `User deletes a session` / `User deletes the currently active session` / `All sessions are deleted` rows in 7.6.

This preserves the v1 stance that the **front end is the source of truth** (7.3, 7.6): the connection can come and go; the local record does not.

#### Draft input across profiles

The bottom-area draft input — text the user has typed but not yet sent — is scoped to the current connection profile and lives only in memory. This mirrors the rule in 7.6 that empty drafts are not written to `chrome.storage.local`. Concretely:

- When the user switches to a different profile, the visible draft input is swapped together with the visible session list. The previous profile's draft input remains in memory under that profile for as long as the panel page stays alive.
- If the destination profile has no in-memory draft input, the input box is blank.
- Closing the panel ends the panel page and drops every in-memory draft input, on every profile. On reopen, the input box starts blank — draft input is never persisted across panel close.
- Connection failures (failed `/health`, denied runtime permission per 9.3, CORS rejection per 9.4, DNS or TLS failure, network outage, 401, 403) do **not** clear the current profile's in-memory draft input. As long as the panel page is alive, typed-but-unsent text survives a transient outage.

This keeps the front-end-is-source-of-truth stance from 7.3 honest at the input layer too: drafts are deliberately ephemeral, scoped per profile, and never silently leak across endpoints.

#### How the UI talks about these transitions

The user must always be able to tell which backend the currently visible conversations belong to. The panel therefore surfaces the current profile prominently in the top region and makes every cross-profile transition observable rather than silent.

Example UI copy:

- Profile label in the top region: `{hostShort}` — click opens settings; tooltip on hover: `Showing conversations for {hostShort}`
- Settings confirmation when the saved URL resolves to a different profile: `Switching to {newHostShort}. You'll see the conversations saved for that connection. Your conversations for {oldHostShort} stay saved and reappear if you switch back.`
- Settings confirmation when the saved URL is the same profile: `Connection details updated.` (no mention of session lists, because nothing visible changes)
- Settings confirmation when only the API key changed: `API key updated for {hostShort}.`
- Banner after a model fallback on reconnect: `Model {oldModelId} isn't available on {hostShort}. Sends now use {newModelId}.`
- Empty-state card for a newly reached profile: `No conversations yet for {hostShort}. Start one below.`
- Connection-lost banner (sessions preserved): `Can't reach {hostShort} right now. Your conversations are saved locally — you can keep reading them and resume sending once the connection is back.`

The intent of this copy is that a user who switches endpoints never has to ask "wait, where did my conversation go?" — the UI names the profile, states that histories are kept per profile, and shows how to get back.

---

## 10. Error states and empty states

Core principle: **do not dump raw HTTP errors on the user**, but also do not over-polish to the point that the user cannot tell what went wrong.

| Scenario | UI presentation | Behavior |
| --- | --- | --- |
| First open, never configured | Empty-state card: `You're not connected to a Hermes Agent yet. The default is http://127.0.0.1:8642 — change it in settings to point at a remote Hermes.` plus a `Test connection` button | Clicking opens the settings drawer and immediately runs a health check |
| Health check failed | Top status dot turns red. Tooltip: `Cannot reach {hostShort}: {shortReason}` | Input is disabled; an `Open settings` button appears |
| Health check failed because of CORS | As above, plus an inline hint: `Looks like a CORS error. Add chrome-extension://{extensionId} to your Hermes server's API_SERVER_CORS_ORIGINS.` | Same disabled-input behavior |
| Permission for remote host not yet granted | Banner: `This extension needs your permission to connect to {originShort}.` plus a `Grant access` button | Clicking triggers `chrome.permissions.request` for that origin |
| Model list empty | Model dropdown shows `No models available`; sending is disabled | Hint: `Check that your Hermes server has at least one model configured.` |
| Send returned non-2xx | The user message is marked `Failed to send`, with a `Retry` button beneath | Retry reuses the same `Idempotency-Key` |
| Stream cut mid-response | The received portion is kept as the agent message, with a `Connection interrupted` badge | A `Continue` button is offered. **In v1, "continue" re-sends the conversation** — this is not true resume-from-offset. |
| User pressed Stop | Message keeps received content with a `Stopped` badge | No side effects |
| Conversation empty | Welcome state plus three example prompts (clickable to fill the input) | None |

Error copy tone: direct, no apologies, always offer a next step. Avoid `Oops, something went wrong :(`. Prefer `Request failed (401): API key is missing or invalid.`

Additional example error strings:

- `Request failed (401): API key is missing or invalid.`
- `Request failed (404): The configured Hermes endpoint does not expose /v1/chat/completions.`
- `Request failed (timeout): {hostShort} did not respond within {seconds}s.`
- `Streaming interrupted: connection closed before the response finished.`

Example empty-state strings:

- `No conversations yet. Start one below.`
- Example prompts: `Summarize this paragraph`, `Explain this code`, `Draft a reply to this email`.

---

## 11. v1 scope and future evolution

### v1 (MVP)

- Chrome extension skeleton (MV3 + Side Panel).
- Connection configuration: API base URL (local **or** remote), API key, runtime permission flow for non-loopback hosts, connection status indicator, `/v1/health` health check.
- Model discovery: `GET /v1/models`, model dropdown, ability to switch.
- Chat main UI: single active conversation, Markdown rendering, SSE streaming, stop button.
- Session management: local multi-session (new / switch / delete / rename), persisted in `chrome.storage.local`.
- Lightweight tool-progress hint based on `hermes.tool.progress`.
- Core empty / error / permission states (section 10).
- Least-privilege permissions (section 9.3).

### v2 candidates (roughly in priority order)

- Add Responses API as an optional transport, picking up server-side conversation state and structured tool events.
- Detailed tool-progress UI based on the Runs API (`/v1/runs/{run_id}/events`).
- Optional page-context injection (content script, gated on explicit `activeTab` grant).
- Optional error reporting and a local log viewer.
- Keyboard shortcuts: open the side panel, switch sessions, clear input.
- Theme (follow system / manual switch).
- Import/export sessions.
- TLS/identity hints for remote setups (e.g. clearer error when a self-signed cert blocks the request).

### Explicitly not planned (unless requirements change)

- Hosted/managed Hermes or any cloud relay service.
- Multi-tenant accounts or login.
- Clients outside of a browser extension (desktop, mobile) — those would be separate projects.

---

## 12. Open questions

Before implementation begins, the following must be answered with maintainers (or against the Hermes API server itself). **These are not implementation details — they affect decisions in sections 7, 8, and 9.**

1. **CORS and the `chrome-extension://` origin.** What does the Hermes API server's CORS middleware do today when it sees `Origin: chrome-extension://<id>` on a preflight request? Should the documentation tell users to add the extension ID to `API_SERVER_CORS_ORIGINS` in all cases, only for remote, or never?
2. **How to obtain `X-Hermes-Session-Id`.** After the first Chat Completions call, where does the front end read the session id from — a response header? A separate create-session call? The current docs say "use it to continue an existing session" but do not specify how the session is created.
3. **Coupling between `X-Hermes-Session-Id` and `API_SERVER_KEY`.** The docs say this header requires `API_SERVER_KEY` to be configured. Does that mean "the request must carry a matching `Authorization`" or "the server only enables session tracking when a key is configured"? This changes the wording of the Advanced toggle.
4. **`Idempotency-Key` on streaming.** Does the Hermes API server accept and honour `Idempotency-Key` on streaming Chat Completions? On retry, does it replay a cached full response or open a fresh stream?
5. **`/health` vs `/v1/health`.** What is the semantic difference? Which one is the correct heartbeat for the connection status dot?
6. **Contents of `GET /v1/models`.** Is it every model registered with Hermes, or only those available to the calling user/key? Is `API_SERVER_KEY` required to see the full list?
7. **Where to store the API key.** `chrome.storage.local` persists to disk. For a single-user local deployment that may be acceptable; for a remote deployment with a long-lived bearer token it is more sensitive. Should v1 default to `chrome.storage.session` (cleared when the browser closes), or default to `local` and offer a "do not persist" toggle? This is a product risk decision, not just a technical one.
8. **Reachability of the loopback default.** If the user runs Hermes in a container, `127.0.0.1:8642` from the browser may not reach it. Is this purely a documentation problem, or should v1 detect the symptom and suggest changing the host?
9. **Stability of the tool-progress payload.** Is the `hermes.tool.progress` event payload stable enough that v1 can rely on it for the simple "tool name + status" UI? Are additional fields needed for a sensible collapsible block?
10. **Conversation storage size.** `chrome.storage.local` has a default ~10MB quota that can be raised with `unlimitedStorage`. Should v1 request `unlimitedStorage` at install time, or do simple session truncation? Default lean: do not request the extra permission.
11. **Mixed-content / TLS for remote.** If a user types an `http://` remote address (not loopback), should the extension warn that credentials and message content will travel unencrypted? Should this be a soft warning or a hard refusal in v1?
12. **Named connection profiles.** v1 keys profiles implicitly by the normalized base URL in the single `API base URL` field (9.6). Should v1 instead expose a small "connection profiles" list (name + base URL + key per entry) so users who routinely switch between several Hermes endpoints can label them and avoid re-typing? Default lean: no — a single-field URL is enough for MVP, and named profiles are a v2 candidate alongside import/export.
