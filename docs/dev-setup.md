# hermes-sidebar — Developer Setup (Draft)

## 0. Status and scope

**This document tracks the developer loop as the extension is being built.** The first implementation slice — a shared scaffold with Vite + React + TypeScript, a loadable MV3 manifest, the background service worker, and a three-region side panel shell — has landed. The chat runtime (session manager, API client, SSE parser, settings drawer) is **not** wired up yet; the side panel renders its empty state and exposes the controller seam the runtime will plug into.

Concretely, if you clone this repo today:

- `npm install && npm run build` produces a loadable unpacked extension in `dist/`.
- `npm test` runs a Vitest smoke test that mounts the side panel against a stubbed controller.
- There is no chat flow yet: sending a message surfaces a scaffold-only banner.

Use this document as a **design contract for the eventual dev workflow**. When implementation PRs land, they must either satisfy this document or update it. Anything labelled "planned" or "assumed" is subject to change; items explicitly marked as **open questions** defer to the maintainers.

Boundary notes:

- Visual and interaction details live in [ui-spec.md](./ui-spec.md).
- Request/response shapes, SSE event payloads, and error codes belong in [api-contract.md](./api-contract.md).
- Internal module layout (side panel page, service worker, storage, API client) belongs in [architecture.md](./architecture.md).
- Product rationale, permission model, and the local-vs-remote stance live in [product-design.md](./product-design.md) (sections 9.3 and 9.6 are especially relevant here).

---

## 1. Prerequisites

### 1.1 Chrome

- Chrome 114+ is required, because the Side Panel API became stable in this version (product-design §1). Chrome Canary / Beta / Dev channels also work.
- Other Chromium-based browsers (Edge, Brave, Arc) are **not** in the v1 support matrix. They may work, but issues filed against them should be triaged against upstream Chromium's Side Panel implementation before being treated as extension bugs.
- A dedicated Chrome **profile** for development is strongly recommended. Loading unpacked extensions pollutes the extension list and can pick up stale state; a dedicated profile keeps your personal browsing untouched.

### 1.2 Hermes Agent API server

You need a Hermes Agent API server reachable over HTTP(S). This repository does not bundle one, and it does **not** prescribe how you run yours (product-design §1 and §9.2). Pick one:

- **Local.** Run Hermes on your development machine. The suggested default address used throughout the design is `http://127.0.0.1:8642`. This matches the default `host_permissions` entry in the planned manifest (§2.2) and needs no runtime permission flow.
- **Remote.** Point the extension at a Hermes you have deployed elsewhere (LAN host, container, VM, or a reverse-proxied host). This path requires granting runtime host permissions (§3.2) and usually requires CORS configuration on the Hermes side (§5.2).

Minimum verification that your Hermes is ready:

- `GET /v1/health` (or `/health`) returns success.
- `GET /v1/models` returns at least one model.
- `POST /v1/chat/completions` with `"stream": true` produces SSE deltas.

If any of these fail, fix them on the Hermes side before touching the extension — the extension cannot paper over a backend that does not speak its contract.

### 1.3 Local toolchain

The first implementation PR picked the following toolchain. It is the answer to open question 1 in §7 and is the only toolchain `main` currently builds against:

- **Node.js:** `24.14.1`, pinned in `.tool-versions` (asdf / mise compatible). Other recent Node versions may work but CI has not been set up yet.
- **Package manager:** `npm`. A `package-lock.json` is checked in; do not introduce a competing lockfile.
- **Language / UI:** TypeScript + React 18.
- **Bundler:** Vite 5, configured in `vite.config.ts`. The side panel HTML is authored under `src/sidepanel/index.html`; a small Vite plugin (`flattenSidepanelHtmlPlugin` in `vite.config.ts`) flattens it to `dist/sidepanel.html` so the manifest can reference a stable name at the extension root.
- **Tests:** Vitest + React Testing Library running under jsdom.

From a fresh clone:

```bash
npm install
npm run build     # writes dist/
npm test          # Vitest smoke suite
npm run typecheck # tsc --noEmit over src/ and tests/
```

The build emits:

- `dist/manifest.json` (generated from `manifest.config.ts`)
- `dist/sidepanel.html` + `dist/assets/…` (the React side panel bundle)
- `dist/background.js` (the MV3 service worker, unbundled to a stable filename so the manifest can reference it)
- `dist/icons/icon-{16,32,48,128}.png`

`dist/` is the directory you point Chrome's **Load unpacked** at (§3.1).

---

## 2. Project layout and manifest

### 2.1 Current layout

The scaffold in `main` uses this layout. Deeper chat-runtime modules (session manager, API client, storage gateway, stream handler) will be added under `src/` as their designs in `architecture.md` are implemented.

```
/ (repo root)
├─ docs/                   # design documents
├─ src/
│  ├─ sidepanel/           # React side panel page (index.html + App + TopBar / ConversationArea / Composer)
│  ├─ background/          # MV3 service worker (service-worker.ts)
│  ├─ shared/              # contracts: profile, session, message, tool-progress, settings, app-state
│  └─ styles/              # global CSS
├─ public/
│  └─ icons/               # toolbar icons emitted at dist/icons/
├─ tests/                  # Vitest suites
├─ manifest.config.ts      # typed manifest source, serialized to dist/manifest.json at build time
├─ vite.config.ts          # flattens src/sidepanel/index.html to dist/sidepanel.html at build time
├─ tsconfig*.json
├─ .tool-versions          # pins Node 24.14.1
└─ dist/                   # build output — what Chrome loads (gitignored)
```

The layout is not prescriptive beyond the external contract: Chrome must be able to load `dist/` as an unpacked MV3 extension.

### 2.2 `manifest.json` shape

The manifest is authored in `manifest.config.ts` and serialized to `dist/manifest.json` by a Vite plugin on every build. Its current shape mirrors product-design §9.3:

```jsonc
{
  "manifest_version": 3,
  "name": "hermes-sidebar",
  "version": "0.0.0",
  "permissions": ["sidePanel", "storage"],
  "host_permissions": ["http://127.0.0.1:8642/*"],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "side_panel": { "default_path": "sidepanel.html" },
  "action": {
    "default_title": "hermes-sidebar",
    "default_icon": { "16": "icons/icon-16.png", /* …32, 48, 128 */ }
  },
  "icons": { "16": "icons/icon-16.png", /* …32, 48, 128 */ },
  "background": { "service_worker": "background.js", "type": "module" },
  "minimum_chrome_version": "114"
}
```

Key points to preserve during future edits (and to verify in code review):

- No `tabs`, `activeTab`, `scripting`, or `cookies`. v1 does not read page content (product-design §9.3).
- `host_permissions` ships only the loopback default. Anything else is promoted to a runtime grant via `optional_host_permissions`.
- `optional_host_permissions` is the *declaration* of what the extension *may* ask for — it is not a grant. Chrome prompts per-origin at runtime (§3.2).
- The `action` entry exists so `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` (in `src/background/service-worker.ts`) can wire the toolbar icon to open the panel.

### 2.3 Build output

- Build output goes to `dist/`. It is self-contained: generated `manifest.json`, built `sidepanel.html` + hashed JS/CSS bundles under `assets/`, an unhashed `background.js`, icons under `icons/`, and source maps.
- `sidepanel.html` references bundles via absolute extension-root paths (`/assets/…`), which resolve correctly under `chrome-extension://<id>/`.
- `dist/` is gitignored; regenerate with `npm run build`.

---

## 3. Loading the unpacked extension

### 3.1 First-time load

After `npm install && npm run build`, load the extension in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (toggle in the top-right).
3. Click **Load unpacked**.
4. Select the `dist/` directory at the repo root.
5. Confirm the extension appears in the list and shows no errors under `Errors`. If you see an "Unpacked extensions are being loaded" warning, that is normal.
6. Note the **extension ID** shown under the extension's name. You will need it later for CORS configuration (§5.2). The ID is stable for this unpacked load; reloading in place keeps it, but loading from a different path gives you a new ID.
7. Pin the extension to the toolbar (puzzle-piece icon → pin). This makes opening the side panel a single click.

### 3.2 Granting runtime host permissions (remote Hermes only)

When you configure the extension to point at a **non-loopback** URL, Chrome will prompt for permission for that specific origin (product-design §9.3). This happens from inside the settings drawer flow described in [ui-spec.md §6.4](./ui-spec.md), not from `chrome://extensions`:

1. Open the side panel.
2. Open the settings drawer (gear icon in the top region).
3. Enter your remote URL (e.g. `https://hermes.example.com`) in `API base URL`.
4. Save. The UI will show a `Grant access to {originShort}` button.
5. Click it; Chrome displays its native permission prompt; accept.
6. The status dot in the top region will go yellow → green as the health check runs.

If you deny the prompt, you can retry from the same settings drawer without reinstalling (see [ui-spec.md §6.4](./ui-spec.md)). You can also revoke the permission later from `chrome://extensions` → Details → Site access.

### 3.3 Iteration loop

During active development:

- `npm run dev` runs Vite in watch mode against the same config as `npm run build` — it rebuilds `dist/` on every save, so your `chrome://extensions` reload always reflects the latest source. (Hot-reloading the extension itself is open question 3 in §7 and not in v1 scope.)
- After a rebuild, click the **reload icon** on the extension card in `chrome://extensions`. This picks up new bundle contents without losing your granted host permissions or local storage.
- If a change touches `manifest.json`, reload is still sufficient — full remove-and-re-add is only needed if the extension ID has to change (e.g. different unpacked path).
- The side panel page can be reopened by closing and reopening it (toolbar icon). The service worker can be inspected and restarted from the extension card's **Inspect views** list (`service worker` entry).

`console.log` output and uncaught errors from the side panel page are visible by right-clicking inside the side panel and choosing **Inspect**. This is the side panel's own DevTools context; the host page's DevTools do not see side panel logs.

---

## 4. Configuring your Hermes endpoint

### 4.1 Local-first default

The happy path for a developer running Hermes on the same machine:

1. Start Hermes on `http://127.0.0.1:8642` (or whatever port you have configured — if you change the port, you will also need to adjust `host_permissions` in `manifest.json` or grant the new origin at runtime).
2. Load the extension (§3.1).
3. Open the side panel; the default base URL (per product-design §9.1) will already be `http://127.0.0.1:8642`.
4. The status dot should go yellow → green within a few seconds.
5. If Hermes is configured to require an API key (`API_SERVER_KEY`), paste it into the settings drawer's `API key` field.

If the status dot stays red, jump to §5 (troubleshooting) before assuming it is an extension bug.

### 4.2 Remote test path

For a remote Hermes:

1. Make sure your Hermes server allows the extension's origin via `API_SERVER_CORS_ORIGINS` (product-design §9.4). The origin string is `chrome-extension://<your extension ID>` from §3.1. See §5.2 for the exact setting.
2. Prefer `https://`. The extension does not refuse `http://` for non-loopback in v1, but see product-design open question 11 — this may change. Using `https://` now avoids any future migration.
3. In the settings drawer, set `API base URL` to your remote URL and paste an API key if your server has one configured.
4. Grant the runtime host permission when Chrome prompts (§3.2).
5. Expect the same status-dot → green handshake as local.

### 4.3 Switching between local and remote

This exercises the profile-switch behavior described in product-design §9.6 and [ui-spec.md §7.1](./ui-spec.md). It is one of the more important paths to manually verify because the behavior is easy to get wrong:

- Local sessions are **scoped per connection profile**. Switching from `http://127.0.0.1:8642` to `https://hermes.example.com` shows a different session list; switching back restores the first one. The previous profile's sessions are not deleted.
- The settings drawer shows an explicit confirmation when the new URL resolves to a different profile ("Switching to {newHostShort}…"). That confirmation is a design contract — if you do not see it on a profile change during manual verification, file a bug.

---

## 5. Troubleshooting

### 5.1 Status dot stays red against local Hermes

Checklist, in order:

1. Is Hermes actually running on the configured port? `curl http://127.0.0.1:8642/v1/health` from the same machine should succeed.
2. Does the port match what is in the base URL field? If you changed Hermes to a non-default port, the default `host_permissions` entry (`http://127.0.0.1:8642/*`) will **not** cover it. Update `manifest.json` or rely on the runtime grant for the new origin.
3. Is Hermes running inside a container or VM? `127.0.0.1` inside the container is not the same as `127.0.0.1` from Chrome's perspective (product-design open question 8). You will need to bind Hermes to the host-reachable interface and point the extension at that address.
4. Does inspecting the side panel DevTools (§3.3) show a specific failure? A `TypeError: Failed to fetch` with no preflight usually means the host permission is wrong; a CORS error means Hermes is reachable but rejecting the origin (§5.2).

### 5.2 CORS errors against remote Hermes

Symptom: in the side panel's DevTools, the `fetch` fails with a message mentioning CORS, `Access-Control-Allow-Origin`, or the preflight.

Fix: add the extension's origin to your Hermes server's CORS allowlist. The origin is `chrome-extension://<extension ID>` where `<extension ID>` comes from `chrome://extensions` (§3.1). The exact setting on the Hermes side is `API_SERVER_CORS_ORIGINS`; refer to the Hermes documentation for how to set it in your deployment.

The extension cannot work around this — it is a server-side configuration (product-design §9.4).

Note that the extension ID from `chrome://extensions` changes if you reload the extension from a different unpacked path. For a team that wants a stable ID, consider packing the extension and loading that consistently, or configuring `key` in `manifest.json` (this is an implementation-time decision and not covered further here).

### 5.3 "Permission denied" on a remote URL

If you denied the Chrome runtime permission prompt (§3.2), the extension cannot talk to that origin. Two options:

- Retry the grant from the settings drawer's `Grant access to {originShort}` button ([ui-spec.md §6.4](./ui-spec.md)).
- Or grant it manually via `chrome://extensions` → Details → Site access → *allow on specific sites* and add the origin.

### 5.4 Streaming hangs or cuts

- If the stream cuts with no user action, the UI surfaces a `Connection interrupted` badge with a `Continue` action ([ui-spec.md §3.6](./ui-spec.md)). In v1, `Continue` re-sends the conversation — it is not resume-from-offset (product-design §10). Expect a fresh, full send.
- If the stream hangs (no tokens for a long time and no error), check the side panel DevTools for an aborted or stalled `fetch`. A common cause is an intermediate proxy buffering SSE; make sure any reverse proxy in front of Hermes is configured to flush SSE promptly.

### 5.5 Model list is empty

- Confirm `GET /v1/models` from the same machine returns at least one model.
- If the list is key-gated (product-design open question 6), make sure the API key is filled in.
- If the model list truly is empty, sending is disabled by design ([ui-spec.md §3.5](./ui-spec.md), §6.3).

### 5.6 Local storage weirdness

`chrome.storage.local` persists to disk. If you are repeatedly testing first-run flows, clear it from the extension's DevTools:

```js
chrome.storage.local.clear();
```

Run that from the side panel DevTools console. This is the v1 equivalent of "reset to first-run state" — there is no in-app reset button in v1.

Clearing local storage drops **all** local sessions for **all** connection profiles (product-design §9.6). Only do this when you actually want to nuke local history.

---

## 6. Manual verification checklist

This is the **minimum** path to verify before considering a build locally ready to review. It maps to the normative product rules in product-design §7.6 and §9.6 and to the visible states in [ui-spec.md §3.5 / §7](./ui-spec.md). If any item fails, the change is not ready.

### 6.1 Against local Hermes

- [ ] Extension loads without errors in `chrome://extensions`.
- [ ] Clicking the toolbar icon opens the side panel on the active tab.
- [ ] Status dot goes yellow → green within a few seconds.
- [ ] Model dropdown populates with at least one model.
- [ ] Typing and sending a message produces a streamed response; characters appear progressively, not all at once.
- [ ] Pressing **Stop** mid-stream keeps the partial response and attaches a `Stopped` badge to the agent message.
- [ ] Closing and reopening the side panel restores the session list, the active session, and the last selected model.
- [ ] Creating a new session via `New session` does **not** add a row to the session list until the first message is sent (the empty-draft rule from product-design §7.6).
- [ ] Renaming a session updates the title without any server call and without a sync indicator.
- [ ] Deleting a session removes it from the list; if the deleted session was active, the panel falls back to the most recently updated remaining session or to the empty-state card.
- [ ] Switching to another session while a request is streaming keeps the request alive for the originating session (the session list shows a streaming hint; returning to that session shows the live stream from its current position).

### 6.2 Against remote Hermes

- [ ] Entering a non-loopback URL prompts for runtime host permission.
- [ ] Granting the permission clears the permission banner; denying it leaves the `Grant access` control available for retry.
- [ ] Status dot goes yellow → green after permission is granted and CORS is configured.
- [ ] CORS failures produce the hint `Add chrome-extension://{extensionId} to your Hermes server's API_SERVER_CORS_ORIGINS.` rather than a raw error dump.
- [ ] With an API key set, authenticated endpoints work; clearing the key causes them to fail with a legible `Request failed (401): API key is missing or invalid.`

### 6.3 Profile-switch and connection-lost behavior

- [ ] Switching the base URL to a different profile shows the confirmation `Switching to {newHostShort}…` before committing.
- [ ] After switching, the session list is swapped to the new profile's sessions; switching back restores the original list.
- [ ] Switching profiles clears the visible draft input (because it is scoped per profile and was blank for the new profile) but does **not** delete the previous profile's draft from memory.
- [ ] Simulating an outage (e.g. stopping Hermes) turns the status dot red and shows `Can't reach {hostShort} right now. Your conversations are saved locally…` The session list remains intact; the draft input remains on screen.
- [ ] Restarting Hermes returns the status dot to green and re-enables the input without losing the draft.
- [ ] If the model the active session was using is no longer in the reconnected model list, the dropdown falls back to the first available model and the banner `Model {oldModelId} isn't available on {hostShort}. Sends now use {newModelId}.` appears. Historical messages still show their original `modelId`.

### 6.4 Accessibility quick pass

- [ ] Tab order reaches every top-region control, the conversation area, the input, and Send/Stop without getting stuck in the overlays.
- [ ] Escape closes the settings and session drawers; Escape during streaming acts as Stop.
- [ ] The status dot announces its state to a screen reader (e.g. via VoiceOver or NVDA) without relying on color.

---

## 7. Open setup questions

These are unresolved at the dev-setup layer. They should be decided by the implementation PRs that introduce the relevant tooling, and this file should be updated rather than accumulating parallel answers elsewhere.

1. ~~**Toolchain.** Which package manager and bundler?~~ **Resolved.** Node 24.14.1 (pinned in `.tool-versions`), `npm`, TypeScript + React + Vite + Vitest. See §1.3 and §2.3.
2. **Pinned `key` in `manifest.json`.** Do we want a stable extension ID across unpacked loads so that team members share CORS setup? Or do we accept per-developer IDs and document the retrieval step (§3.1) as the price? Default lean: per-developer IDs for v1.
3. **Dev-time automation.** `npm run dev` already rebuilds `dist/` on save, but does not reload the extension automatically in Chrome. A "reload on rebuild" watcher is nice-to-have, not a v1 blocker.
4. **Containerized Hermes on the dev box.** Should this repo ship a docker-compose file that brings up a local Hermes for contributors who do not already run one? Default lean: no — running Hermes is the user's responsibility (product-design §1), and pushing a compose file blurs that boundary.
5. **Automated end-to-end tests against a real Hermes.** Out of scope for v1 dev setup, but worth calling out so the manual checklist in §6 does not become load-bearing forever.
