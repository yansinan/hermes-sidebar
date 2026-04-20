# hermes-sidebar — UI Specification (Draft)

## 0. Scope and status

This document is the **visual and interaction specification** for the side panel. It is design-first: no extension code exists yet, so every spec here is a target that the eventual implementation must satisfy, not a description of existing behavior.

Boundary notes:

- Information architecture, scenarios, and conversation model live in [product-design.md](./product-design.md). This file does **not** restate them; it translates them into concrete visual and interaction rules.
- Internal module structure (side panel page, service worker, storage, API client) belongs in `architecture.md`, not here.
- Exact request/response shapes, SSE event payloads, and error code mappings belong in `api-contract.md`, not here.
- Developer workflow (loading the unpacked extension, pointing it at a Hermes endpoint) belongs in [dev-setup.md](./dev-setup.md), not here.

If any rule below conflicts with a normative subsection in `product-design.md` (notably 7.6 and 9.6), `product-design.md` wins and this file must be updated.

---

## 1. Surface and frame

- Single Chrome Side Panel page, Chrome 114+ / Manifest V3.
- The panel is vertically divided into three regions (top, middle, bottom) as described in product-design §5, plus overlay surfaces: the **settings drawer** and the **session drawer/popover**.
- The panel never navigates between pages; overlays slide in over the conversation area and are dismissed back to it.
- The panel has no horizontal split. The side panel is narrow, and any feature that demands side-by-side columns is deferred.

### 1.1 Target widths and responsive constraints

- **Assumed minimum usable width:** 320 px. Anything narrower is treated as degraded: the conversation area still renders, but the top region collapses (see §2.3) and the input caption truncates.
- **Design width:** 360–420 px. Most Chrome Side Panel deployments sit in this range; layout should look deliberate, not stretched, at 400 px.
- **Maximum practical width:** 560 px. Beyond that, line length is capped by a content max-width inside the conversation area so long-form messages do not grow into unreadable line lengths.
- **No horizontal scrollbars** anywhere in the main flow. Long code blocks scroll horizontally **inside** the code block only.
- **Vertical density:** the top region is fixed height; the bottom input area grows up to a cap (see §4.2) and then internally scrolls; the middle region takes all remaining vertical space.

### 1.2 Theming assumptions

- v1 follows the user's Chrome light/dark setting via `prefers-color-scheme`. A manual theme switch is a v2 candidate (product-design §11).
- All colors referenced below (status dot green/yellow/red, badge colors, banner backgrounds) must have a defined light and dark token. Exact hex values are left to implementation; this spec only constrains **semantic** use.

---

## 2. Top region — connection and session switch

The top region is a single fixed-height row. From left to right:

1. **Status dot** (§2.1)
2. **Connection profile label** (§2.2) — the thing that tells the user which Hermes they are looking at
3. **Model dropdown** (§2.3)
4. **Sessions button** (§2.4) — opens the session drawer/popover
5. **Settings gear** — opens the settings drawer

The row never wraps. If width drops below the responsive threshold, elements collapse in this priority order (highest priority kept last): gear > status dot > profile label > sessions button > model dropdown. The model dropdown is the first thing to collapse into an icon-only control because its label is already repeated in the bottom caption (§4.3).

### 2.1 Status dot

A small circular indicator (approx. 8–10 px) with three semantic states driven by the health check described in product-design §8.2 and §10:

| State | Color | When | Tooltip (from product-design §6.1) |
| --- | --- | --- | --- |
| Healthy | Green | Last `/health` or `/v1/health` check succeeded within the poll window | `Connected to {hostShort}` |
| Connecting | Yellow | A check is in flight, or the panel just reopened and no result yet | `Connecting to {hostShort}…` |
| Failed | Red | Last check returned non-2xx, timed out, was blocked by CORS, or host permission was denied | `Cannot reach {hostShort}. Click to retry.` |

Interaction:

- **Click** the dot triggers an immediate re-check (this is the `Click it triggers a fresh /v1/health check` rule from product-design §6.1).
- **Keyboard:** the dot is a focusable button with `role="button"` semantics and `aria-label` matching its current tooltip; Enter and Space trigger the re-check.
- **Animation:** the yellow "connecting" state uses a subtle pulse. The red state does **not** animate — a steady red is calmer and less alarming during transient outages.
- **Do not** cover the dot with unrelated badges (unread counts, notifications). Its one job is connection health.

### 2.2 Connection profile label

This is the surface that makes "which backend am I looking at" unambiguous, per product-design §9.6 ("How the UI talks about these transitions").

- Shows `{hostShort}`: host and port with the scheme stripped for display (e.g. `127.0.0.1:8642`, `hermes.example.com`). The full URL is available in settings; it is **not** shown here because it eats width.
- Tooltip on hover/focus: `Showing conversations for {hostShort}`.
- **Click opens the settings drawer** (not the session drawer). Rationale: the label is the primary way the user reasons about "I want to change where this panel is pointed." Session switching has its own dedicated button (§2.4) to avoid overloading this click target.
- On a **profile switch** that completed in the last few seconds (base URL was changed to a different profile per product-design §9.6), a small accent underline or dot appears on the label for a brief period so the user notices the session list they now see is scoped to the new profile. This is a visual echo of the toast/confirmation in §7.1; the underline fades automatically.

### 2.3 Model dropdown

- Populated from the last successful `GET /v1/models` response.
- Shows the current model's display name. If no models are available (see §6.3), shows the placeholder text `No models available` and is disabled.
- **Switching the model does not destroy the active conversation.** Prior messages keep the `modelId` they were answered with; only subsequent sends use the new model. This is a direct restatement of product-design §6.1 and is mirrored in the §5.3 rule about per-message model attribution in the transcript.
- **Model fallback after reconnect** (product-design §9.6) is handled here:
  - If the active session's previous `modelId` is still in the refreshed list, it stays selected.
  - If it is not, the dropdown falls back to the first model in the new list and a non-blocking banner appears in the conversation area (see §6.2). The dropdown label reflects the new selection; it does **not** show a phantom "old model".
- When the panel width is too narrow, the dropdown collapses to a compact chip showing a truncated model name; tapping it opens a full-width menu sheet.

### 2.4 Sessions button

- Labelled `Sessions` (per product-design §6.1).
- Click opens the **session drawer/popover** (§5). On very narrow panels (< 360 px) this surface uses the full panel width; on wider panels it overlays as a popover anchored to the button.
- The button shows a small count badge only when there are ≥ 1 persisted sessions for the current profile. An empty profile shows the button without a badge.
- A session currently streaming (product-design §7.6, row "User switches to another session while a request is streaming") is hinted at by a subtle spinner-dot overlay on the button, so a user who navigated away from a streaming session still knows the panel has live activity somewhere.

---

## 3. Middle region — conversation area

### 3.1 Message list

- Messages flow top to bottom in chronological order.
- **Alignment decision for v1:** all messages are **left-aligned** with a small role label (`You` / `Hermes`) above each turn. Right-aligning the user message was considered but hurts readability at 320 px. This finalizes the open question raised in product-design §6.2. (If a maintainer overrides this, update this section and §6.2.)
- Turn spacing is generous enough that a user scanning the transcript can find turn boundaries without relying on color.
- The conversation area auto-scrolls to the bottom **only if the user is already pinned to the bottom** when a new token arrives. If the user has scrolled up to read earlier content, streaming does not yank them back down; instead a small `New messages ↓` pill appears above the input area and jumps to the bottom on click. This is the standard chat-app behavior and is explicitly called out because it is easy to implement the yanking version by accident.

### 3.2 Markdown rendering

Supported block elements (per product-design §6.2):

- Paragraphs, headings (h1–h4 only; h5/h6 render as h4 to avoid a size cliff).
- Ordered and unordered lists, including nested lists up to 3 levels.
- Tables. On narrow widths, tables scroll horizontally **inside** their own container; they do not push the panel layout.
- Fenced code blocks with a monospaced font, syntax-highlight treatment, and a **copy button** in the top-right corner of each block.
- Inline code.
- Blockquotes.
- Links render underlined; opening a link uses `target="_blank"` with `rel="noopener noreferrer"`.

Explicitly **out of scope for v1 rendering:** raw HTML passthrough, image rendering inline from Markdown, LaTeX/math, Mermaid/diagram rendering. These are v2 candidates.

Copy button micro-interaction:

- Default label: `Copy` (from product-design §6.2).
- On click: momentarily swap to `Copied` for ~1.5 seconds, then revert.
- Keyboard accessible: focusable, triggered by Enter/Space.

### 3.3 Streaming state

For a session in **Streaming** (product-design §7.6):

- The agent's message bubble appears immediately as a placeholder with a blinking caret or typing cue, even before the first token arrives, so the user knows their send was accepted.
- As tokens arrive, they are appended to the bubble. Cursor stays at the end during streaming when the user is pinned to the bottom (see §3.1).
- The **bottom region's Send button is replaced by a Stop button** for this session only (see §4.4). Other sessions that are not streaming still show Send.
- When the stream completes normally, the caret disappears and the bubble is finalized.
- When the user presses **Stop**, whatever was received is kept and a `Stopped` badge is attached to the partial agent message (§3.6).
- When the stream cuts mid-response with no user action, a `Connection interrupted` badge is attached and a `Continue` action is offered (§3.6 and product-design §10).

### 3.4 Tool-progress blocks

Driven by `hermes.tool.progress` SSE events (product-design §6.2, §7.4). v1 keeps this lightweight:

- A tool event renders as a small **inline, collapsible block** positioned at the point in the stream where the event arrived.
- Collapsed (default) shows only: an icon, the tool name, and the phase text — `Calling tool {toolName}…` while in progress, `Tool {toolName} finished` when complete.
- Expanded shows the same text; v1 deliberately does **not** render full arguments or tool return payloads. This keeps the narrow side panel readable and avoids committing the UI to a payload shape that is still unstable (product-design open question 9).
- The block must not break the reading flow of the surrounding agent message. If prose resumes after a tool event, the prose continues in the same bubble below the block.
- Tool-progress content is never appended to the message text copy (product-design §7.4). Copying the agent message via text selection copies prose only.

### 3.5 Error and empty banners (in-conversation)

Banners in the conversation area are for state that is **contextual to the current session** or the current connection. They are distinct from per-message badges (§3.6).

Banners used:

- **Empty state (no messages yet in this session, profile is connected)** — welcome copy plus three clickable example prompts (product-design §10: `Summarize this paragraph`, `Explain this code`, `Draft a reply to this email`). Clicking a prompt fills the input; it does **not** auto-send.
- **Empty state for a newly reached profile** (product-design §9.6) — `No conversations yet for {hostShort}. Start one below.`
- **Connection-lost but sessions preserved** (product-design §9.6) — non-blocking banner at the top of the conversation area: `Can't reach {hostShort} right now. Your conversations are saved locally — you can keep reading them and resume sending once the connection is back.` Input is disabled while this banner is up; the banner auto-dismisses when the health check recovers.
- **Model fallback after reconnect** (product-design §9.6) — non-blocking banner: `Model {oldModelId} isn't available on {hostShort}. Sends now use {newModelId}.` Dismissable by the user; reappears on the next fallback event.
- **Permission not yet granted for a remote host** (product-design §10) — banner: `This extension needs your permission to connect to {originShort}.` with a `Grant access` button that triggers the runtime permission flow (product-design §9.3).
- **CORS hint** (product-design §10) — inline hint under the red status dot's tooltip and/or as a banner on first failure: `Looks like a CORS error. Add chrome-extension://{extensionId} to your Hermes server's API_SERVER_CORS_ORIGINS.`
- **Model list empty** — `No models available. Check that your Hermes server has at least one model configured.` Sending is disabled while this is up.

Banner visual rules:

- Three severity tones: **info** (profile switch, model fallback), **warning** (connection lost, permission needed), **error** (CORS rejected, health check hard-failed). All tones must be distinguishable without color alone — use an icon per tone.
- Banners stack at most **two deep**; additional banners are queued and shown on dismissal of the topmost. This prevents a wall-of-warnings UX.
- Banners never dismiss the user's typed draft input (§4.1, and product-design §9.6 "Draft input across profiles").

### 3.6 Per-message badges

Badges are attached to individual messages, surfacing the outcome of a specific send (product-design §7.6 — "message-level badge on the most recent message").

| Badge | Attached to | Action offered | Notes |
| --- | --- | --- | --- |
| `Failed to send` | User's message | `Retry` button | Retry reuses the same `Idempotency-Key` (product-design §7.5, §7.6). The retry replaces the failed send in place — it is not a new user message. |
| `Stopped` | Partial agent message | None | Keeps whatever was received. No side effects. |
| `Connection interrupted` | Partial agent message | `Continue` button | `Continue` re-sends the conversation with a new `Idempotency-Key` (product-design §10). v1 is not resume-from-offset; the UI copy must not imply it is. |

Badges render as small pill chips adjacent to the message, not as inline prose. They are announced to screen readers as part of the message's accessible name (§8.2).

---

## 4. Bottom region — input area

### 4.1 Input box

- Multiline textarea. Grows vertically as content is added, up to a cap (§4.2), after which it scrolls internally.
- Placeholder: `Ask Hermes anything…` (product-design §6.3).
- The input box is **always visible** as long as the panel is open. It is **disabled** (but still visible) when:
  - The connection status dot is red (product-design §10), or
  - The model list is empty (§2.3 / §6.3), or
  - The active profile's permission has not been granted yet.
- Disabled state shows the same placeholder with a muted color and a small lock or plug icon; hover/focus surfaces a tooltip explaining which condition is blocking (`Connection to {hostShort} failed — open settings to retry`).

### 4.2 Size and density

- Minimum height: one line of text plus padding.
- Soft cap: roughly 40% of the panel's vertical height; past that, internal scroll. This preserves the conversation area.
- A small caption line sits below the input (§4.3) and does not contribute to the input's own scroll.

### 4.3 Caption

Directly under the input (product-design §6.3):

```
Model: {modelId}  ·  {charCount} chars
```

- `{modelId}` mirrors the top dropdown selection. If the user switched models mid-draft, the caption updates live; the already-drafted text is not affected.
- `{charCount}` is a simple character count. v1 intentionally does not do token counting (product-design §6.3).
- On a model fallback (§2.3, §3.5), the caption reflects the **new** model immediately; this is one of two places in the UI that make a fallback visible (the other is the banner in §3.5).

### 4.4 Send / Stop buttons

- `Send` and `Stop` are **mutually exclusive** (product-design §6.3). For a session currently streaming, the Stop button takes the Send button's slot; there is no separate Stop button elsewhere.
- `Send` is disabled when the input is empty-after-trim or when the conditions in §4.1 disable the input.
- `Stop` is always enabled whenever it is visible.
- Primary visual treatment for Send; a secondary/neutral treatment for Stop so it does not read as destructive. Stopping a stream is a routine action, not a warning.

### 4.5 Keyboard and input behavior

- **Enter** sends; **Shift+Enter** inserts a newline. The reverse can be configured in settings (product-design §6.3 and §6.4). The configured behavior is reflected in the input's `aria-keyshortcuts`.
- **Escape** while streaming: equivalent to pressing Stop. While not streaming: no-op (does not clear the draft; drafts are too valuable to wipe on a stray keypress).
- **Up arrow at the very start of an empty input**: no behavior in v1. Recalling the last user message is a v2 candidate; for v1 the up arrow simply moves the caret.
- IME composition (CJK input methods, dead-key sequences) must not trigger a send. The send hotkey must wait for `compositionend`.
- Paste of plain text: inserted at the caret. Paste of rich text (HTML): stripped to plain text in v1 to avoid surprising formatting.
- Drag-and-drop of files into the input: **not supported in v1** (v1 has no attachment model). Dropped files should produce a clear "Attachments are not supported yet" hint rather than being silently ignored.

### 4.6 Draft behavior

This translates product-design §7.6 and §9.6 ("Draft input across profiles") into UI rules:

- The draft (text typed but not yet sent) is **in-memory only**. It is never written to `chrome.storage.local`.
- The draft is **scoped to the current connection profile**. Switching profiles swaps the visible draft together with the visible session list (product-design §9.6).
- The draft is **also scoped to the current session within the profile**. Switching sessions swaps the visible draft. Because drafts are in-memory, the set of per-session drafts is bounded by whatever the user has touched during the panel's lifetime.
- A **connection outage does not clear the draft** (product-design §9.6). The input becomes disabled (§4.1), but the typed text stays on screen; when the connection recovers, the user can hit Send.
- **Closing the panel drops every in-memory draft, on every profile and every session** (product-design §9.6). This is an explicit v1 design stance, not a bug. The user is never told their draft was saved.
- A session's **empty draft promotion** on first send (product-design §7.6) is invisible to the user: the session simply appears in the session drawer after the first message, and the panel does not show a "saving…" affordance. The UI must not surface the internal draft/persisted distinction.

---

## 5. Session drawer / popover

Triggered by the `Sessions` button in the top region (§2.4). On narrow panels the surface is a full-width drawer; on wider panels it is a popover anchored to the button. The contents are identical.

### 5.1 List layout

Each row shows:

- Session **title** (derived from the first user message on promotion, per product-design §7.6; user-editable via rename).
- A **secondary line** with the last-updated relative time (`2 min ago`, `Yesterday`) and the `modelId` last used in that session.
- A **streaming hint** dot if that session currently has an in-flight request (product-design §7.6, "User switches to another session while a request is streaming"). This mirrors the hint on the Sessions button itself (§2.4).
- A **row menu** affordance (kebab or hover-exposed icons) that contains `Rename` and `Delete`.

Rows are sorted by `updatedAt` descending. The currently active session is highlighted and visually pinned to the visible area when the drawer opens.

### 5.2 New-session action

- A prominent `New session` button at the top of the list.
- Clicking it creates an **empty draft** (product-design §7.6): the draft is **not** added to the list and **not** written to storage. The drawer closes and the input is focused.
- If an empty draft already exists, clicking `New session` simply focuses the existing draft (product-design §7.6, row "User opens the panel and an empty draft already exists"). The drawer does not create a second draft.
- This behavior means the session list will visibly grow only when the user actually sends a message. This is a deliberate design choice; the UI must not preview an empty row in the list before the first send.

### 5.3 Rename affordance

- Rename can be triggered from the row menu.
- Opens an inline edit on the row (preferred) or a small dialog (fallback for very narrow widths).
- Confirm via Enter or a `Save` button; cancel via Escape or clicking outside. An empty title is not allowed; the control reverts to the previous title.
- Rename is local-only (product-design §7.6). The UI must not suggest the change was synced: no "Saved to server" affordance, no sync spinner.

### 5.4 Delete affordance

- Delete can be triggered from the row menu.
- Always behind a confirmation step. v1's suggested pattern is an inline two-step ("Delete" → "Confirm delete?") on the same row, because a modal dialog is heavyweight in a narrow panel.
- Confirmation copy must name the session: `Delete "{title}"? This can't be undone.`
- If the session had an in-flight request, deletion aborts it first (product-design §7.6).
- If the deleted session was the currently active one, the panel falls back to the most recently updated remaining session, or to the empty-state card if none remain (product-design §7.6). The drawer stays open so the user can pick a different session themselves; the panel does not silently switch underneath them.

### 5.5 Session drawer empty state

When the current profile has zero persisted sessions:

- The list area shows the empty-state card (`No conversations yet for {hostShort}. Start one below.`, product-design §9.6) plus the `New session` button.
- No "deleted" or "archived" view in v1.

---

## 6. Settings drawer

Triggered by the settings gear in the top region, or by clicking the connection profile label (§2.2), or by an `Open settings` control in an error banner (§3.5). Structure follows product-design §6.4.

### 6.1 Sections

- **Connection.** API base URL, API key (optional), `Test connection` button.
- **Conversation.** Default model, Enter behavior (Enter-sends vs Shift+Enter-sends), streaming on/off.
- **Advanced.** `Idempotency-Key` auto-attach toggle; `Reuse Hermes server-side session` toggle (with the `Requires the Hermes server to have API_SERVER_KEY configured.` helper text from product-design §6.4).
- **About.** Version, license, link to documentation.

### 6.2 Connection field behavior

- The API base URL field accepts `http://` and `https://` URLs; relative URLs are rejected at save time with inline validation copy.
- On save, the field is normalized as described in product-design §9.6 (scheme + host + port + optional path prefix, trailing slash canonicalized).
- If the normalized URL resolves to a **different** profile than the one currently loaded, the settings drawer shows the confirmation copy from product-design §9.6 before committing: `Switching to {newHostShort}. You'll see the conversations saved for that connection. Your conversations for {oldHostShort} stay saved and reappear if you switch back.`
- If the normalized URL is the **same** profile, the drawer shows `Connection details updated.` and the conversation area is not disturbed.
- The `Test connection` button runs `/v1/health` + `GET /v1/models`, and shows one of the two result strings from product-design §6.4 (`Connected. {modelCount} models available.` or `Could not reach {host}: {reason}`).

### 6.3 API key field behavior

- Type is a password input by default, with a "show" toggle.
- Saving only the API key (no URL change) is the "Changing only the API key" flow from product-design §9.6: the visible session list is unchanged, in-flight requests are not aborted by the edit, and the next send uses the new key. The drawer shows `API key updated for {hostShort}.`
- The field never echoes the saved key back into rendered error text (product-design §9.5 — keys never written to logs/errors).

### 6.4 Runtime permission flow

When the user saves a non-loopback URL and permission for that origin has not yet been granted (product-design §9.3):

- The drawer shows a `Grant access to {originShort}` button.
- Clicking it invokes `chrome.permissions.request` for the specific origin. The Chrome-native prompt is what the user sees next; the drawer does not re-implement it.
- On denial, the drawer shows `Permission for {originShort} was not granted. The extension cannot connect to that host until you allow it.` (product-design §9.3). The URL save is kept; the user can retry the grant from the same drawer.

### 6.5 Settings drawer dismiss

- Closing the drawer never discards unsaved text that the user has typed into input fields — v1 simply auto-saves on blur / on `Save` per field. An unsaved-changes modal is explicitly **not** part of v1: it is overkill for the scope of these settings.

---

## 7. Cross-cutting transitions

This section specifies how the UI **visibly reacts** to the normative rules in product-design §7.6 and §9.6. The rules themselves live there; this section only answers "what does the user see."

### 7.1 Profile switch (product-design §9.6)

1. User saves a base URL in the settings drawer that normalizes to a different profile.
2. Settings drawer shows the confirmation copy from §6.2 **before** committing.
3. On commit:
   - Any in-flight request in the previous profile is aborted (no spinner lingers on the old session).
   - The visible **session list is swapped** to the new profile's list. The previous profile's sessions are still in storage, not deleted.
   - The visible **draft input is swapped** too (§4.6). Because drafts are in-memory, the new profile's draft input will typically be blank unless the user has typed something for it earlier in the panel's lifetime.
   - The top region's profile label updates to `{newHostShort}` and briefly accents to draw attention (§2.2).
   - If the new profile has prior sessions, the last active session for that profile is rehydrated; if it has none, the `No conversations yet for {hostShort}. Start one below.` empty-state card is shown (§3.5).
   - A fresh `/health` check and `GET /v1/models` run before any send is allowed. While they are pending, the status dot is yellow and the input is disabled.

### 7.2 Draft behavior transitions (product-design §9.6)

- Within a profile, switching sessions swaps the draft (§4.6).
- Across profiles, switching profiles swaps the draft alongside the session list (§7.1).
- A connection outage disables the input but keeps the draft visible (§3.5 connection-lost banner, §4.6).
- Closing the panel drops every draft (§4.6). On reopen, the input is blank — this is the specified behavior, not a bug.

### 7.3 Model fallback (product-design §9.6)

On reconnect, base-URL change, or key change, after `GET /v1/models` returns:

- If the active session's `modelId` is in the new list → no visible change, no banner.
- If not → dropdown falls back to the first model in the new list (§2.3), caption under the input updates (§4.3), and the banner from §3.5 appears.
- **Historical messages keep their original `modelId`** (product-design §9.6). The transcript must not rewrite past messages to the new model.

### 7.4 Connection lost, sessions preserved (product-design §9.6)

- Status dot turns red (§2.1).
- `/v1/models` is not re-fetched on every failed poll — only on an actual user-initiated retry or a successful health recovery.
- The connection-lost banner appears at the top of the conversation area (§3.5).
- Input is disabled (§4.1); the typed draft is preserved (§4.6).
- **The session list is not touched.** Rename/delete affordances remain available — the user can still organize their local history while offline.
- On recovery, the banner auto-dismisses, the status dot returns to green, and the input re-enables. If a model fallback happened during the outage, the §7.3 banner appears after the connection-lost banner clears.

---

## 8. Accessibility

### 8.1 Keyboard reachability

- Every interactive control (status dot, profile label, model dropdown, sessions button, gear, session rows, rename/delete controls, send/stop, example prompts, banner dismiss) must be reachable via keyboard and have a visible focus indicator.
- Tab order follows reading order: top region left-to-right → conversation area → input area. Overlays (session drawer, settings drawer) trap focus until dismissed.
- Escape dismisses the top-most overlay. In the conversation area, Escape during streaming acts as Stop (§4.5).

### 8.2 Screen reader semantics

- The conversation area is an ARIA live region for newly streamed content. v1 uses `aria-live="polite"` so a long stream does not spam the user; the placeholder agent bubble announces `Hermes is responding…` once when streaming starts, and the final content is announced when the stream completes.
- Per-message badges (`Failed to send`, `Stopped`, `Connection interrupted`) are part of the accessible name of their message, so a screen reader user who arrows to that message hears the state without having to find a separate control.
- The status dot's accessible name reflects its current state (e.g. `Connection status: failed. Click to retry.`), so screen reader users are not reliant on color.
- The session drawer uses `role="dialog"` on narrow widths (full-width surface) and `role="menu"`/`role="listbox"` on wider widths (anchored popover); both expose the current active session via `aria-current="true"`.

### 8.3 Visual accessibility

- No information is conveyed by color alone: the status dot has tooltip text; banners have icons per tone (§3.5); badges include text labels.
- Text contrast meets WCAG AA for body copy and for all status/badge text.
- Focus rings must remain visible in both light and dark themes; using only a subtle shadow is not sufficient.
- Respect `prefers-reduced-motion`: the streaming caret blink, the profile-switch accent animation, and the status-dot pulse all switch to static alternatives under reduced motion.

### 8.4 Internationalization assumptions

- All UI copy strings used in this document are **examples in English**, matching the example copy already in product-design. v1 ships English only; translatable string IDs are a v2 candidate and are not specified here.
- Layout must tolerate strings up to ~1.5× the length of their English example without breaking (title bars, labels). Truncation rules (`{hostShort}`, session titles) prevent most overflow.

---

## 9. Open UI questions

These are unresolved at the UI-spec layer and should be decided before implementation. They are tracked separately from the product-level open questions in product-design §12, because they are visual/interaction rather than product or protocol questions.

1. **Avatars vs. role labels.** §3.1 commits to left-aligned messages with role labels (`You` / `Hermes`). Do we want small avatars too, or is the label enough? Default lean: label only, no avatar, because avatars eat horizontal space in a narrow panel.
2. **Session-list streaming hint.** §2.4 and §5.1 both show a streaming hint when a background session is streaming. Do we also want a tiny "N streaming" counter on the Sessions button? Default lean: no — a single hint dot is enough and the number is available by opening the drawer.
3. **Confirm-on-delete pattern.** §5.4 proposes an inline two-step confirmation. Do we instead want a modal dialog that includes the last message preview, to reduce accidental deletes? Default lean: inline two-step, to stay lightweight; revisit if user testing shows accidental deletes.
4. **Example-prompt set.** §3.5 lists three example prompts (matching product-design §10). Should these be user-configurable in settings? Default lean: not in v1.
5. **Up-arrow recall.** §4.5 explicitly defers "up arrow to recall last user message." Should v1 ship a simple "last message recall" since it is common in chat UIs? Default lean: no — scope creep, and the draft-per-session model (§4.6) already covers most re-send needs via the failed-message `Retry` action.
6. **Disabled-input messaging.** §4.1 surfaces the blocking reason via tooltip. Is that discoverable enough, or should we always pair it with an inline hint above the input? Default lean: tooltip plus the existing banners in §3.5 is enough; an always-on inline hint would be redundant.
