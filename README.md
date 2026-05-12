# hermes-sidebar

A Chrome Side Panel extension that brings the Hermes Agent API server's chat experience into the browser sidebar — so you can keep your tabs and your agent open side by side.

> **Status: early scaffold.** The first implementation slice — TypeScript + React + Vite + Vitest, a loadable MV3 manifest, the background service worker, and a three-region side panel shell — has landed. The chat runtime (session manager, API client, SSE parser, settings drawer) is not wired up yet; the side panel renders its empty state against a stub controller. Running `npm install && npm run build` produces a loadable unpacked extension at `dist/`. See [`docs/dev-setup.md`](./docs/dev-setup.md) for the full loop.

## What it is

`hermes-sidebar` is an MV3 Chrome extension that uses the [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) (Chrome 114+) to host a chat UI talking to a Hermes Agent API server over its OpenAI-compatible `/v1` endpoints.

- Default transport: **Chat Completions** (`POST /v1/chat/completions`) — wide compatibility, simple streaming.
- Future-ready upgrade path: **Responses API** (`POST /v1/responses`) — structured tool events, server-held conversation state.
- Connects to **either** a local Hermes Agent (e.g. `http://127.0.0.1:8642`) **or** a remote Hermes Agent that the user has stood up themselves.

## What it is not

- Not a hosted service. There is no cloud relay; your extension talks directly to the Hermes Agent endpoint **you** configured.
- Not a deployment tool. How and where you run the Hermes Agent (laptop, LAN box, VM, container, behind a reverse proxy, etc.) is entirely your choice — see [Deployment is your call](#deployment-is-your-call) below.
- Not a page-understanding tool. The first version does not inject content scripts to read the active tab.
- Not an account system, not a multi-tenant chat product, not a replacement for full agent operations UIs like Open WebUI.

## Deployment is your call

`hermes-sidebar` deliberately does **not** prescribe how to run the Hermes Agent. You can:

- Run Hermes locally on your laptop and point the extension at `http://127.0.0.1:8642`.
- Run Hermes on another machine on your LAN and point the extension at `http://<host>:8642`.
- Run Hermes on a remote server behind TLS and point the extension at `https://hermes.example.com`.

The extension only needs a reachable HTTP(S) endpoint that speaks the Hermes API server contract. Everything upstream of that — TLS termination, auth, network policy, process supervision, autoscaling — is your responsibility, and is explicitly out of scope for this project.

## Documentation

Start at [`docs/README.md`](./docs/README.md) — it is the documentation hub and explains what each document covers and in what order to read them. The current documentation set is [`product-design.md`](./docs/product-design.md) (the product-layer spine) together with its companion docs [`architecture.md`](./docs/architecture.md), [`api-contract.md`](./docs/api-contract.md), [`ui-spec.md`](./docs/ui-spec.md), and [`dev-setup.md`](./docs/dev-setup.md).

## Getting started

```bash
# Requires Node 24.14.1 (see .tool-versions) and npm.
npm install
npm run build     # emits dist/ (load unpacked in chrome://extensions)
npm test          # Vitest smoke suite
```

## Publish a GitHub Release

Release publishing is intentionally kept as one script under `scripts/release/`:

- `scripts/release/publish_github_release.py`

It uploads an existing ZIP package to a GitHub release using the GitHub API.

```bash
# 1) Build/package first (example file name)
# hermes-sidebar-v0.1.0-20260512.zip

# 2) Publish
export GITHUB_TOKEN=your_token_here
npm run release:github -- \
	--repo yansinan/hermes-sidebar \
	--tag v0.1.0-20260512 \
	--asset hermes-sidebar-v0.1.0-20260512.zip \
	--title "Token-based DOM Input Limit v0.1.0"
```

Optional:

- `--notes-file <path>`: load release notes from a Markdown file.
- `--draft`: create draft release.
- `--prerelease`: create prerelease.

## Contributing

With the scaffold in place, the most useful contributions right now are:

1. Reviewing [`docs/product-design.md`](./docs/product-design.md) and pushing back on assumptions in the **Open questions** section.
2. Sharing real-world deployment shapes (local, LAN, remote with TLS, etc.) so the connection-config UX covers them.
3. Implementation PRs landing one architectural seam at a time — session manager, storage gateway, API client (ChatTransport), stream handler, settings drawer — against the contracts under `src/shared/`.
4. Filing issues for missing UI states or error cases the design overlooks.

## License

To be decided before the first implementation PR. The intent is a permissive open-source license (MIT or Apache-2.0); see the open issue discussion before contributing copyrightable code.
