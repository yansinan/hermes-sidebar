# hermes-sidebar

A Chrome Side Panel extension that brings the Hermes Agent API server's chat experience into the browser sidebar — so you can keep your tabs and your agent open side by side.

> **Status: design-first.** The repo is currently at the design and alignment stage. There is no shipping extension code yet; the documents under [`docs/`](./docs) describe what we intend to build and the boundaries we're committing to before any implementation lands. Pull requests that disagree with the design are welcome — open an issue first.

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

Start at [`docs/README.md`](./docs/README.md) — it is the documentation map. The substantive design is in [`docs/product-design.md`](./docs/product-design.md).

## Contributing

Because the repo is design-first, the most useful contributions right now are:

1. Reviewing [`docs/product-design.md`](./docs/product-design.md) and pushing back on assumptions in the **Open questions** section.
2. Sharing real-world deployment shapes (local, LAN, remote with TLS, etc.) so the connection-config UX covers them.
3. Filing issues for missing UI states or error cases the design overlooks.

Implementation PRs are welcome once the design questions in section 12 of `product-design.md` are resolved.

## License

To be decided before the first implementation PR. The intent is a permissive open-source license (MIT or Apache-2.0); see the open issue discussion before contributing copyrightable code.
