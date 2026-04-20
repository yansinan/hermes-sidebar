# hermes-sidebar — Documentation

This directory is the documentation home for `hermes-sidebar`, an open-source Chrome Side Panel extension that talks to a Hermes Agent API server (local **or** remote, your choice).

> **Status: design-first.** The repository does not yet contain extension code. The documents here describe what we plan to build, the scope boundaries we are committing to, and the open questions that need answering before implementation begins. Treat every "current assumption" and every entry in the **Open questions** section of `product-design.md` as something to revisit before writing code.

## Documentation map

Each document owns a distinct slice of the design. The boundaries below exist so that each doc stays focused; do not restate content from one document inside another.

| Document | What it covers | When to read it |
| --- | --- | --- |
| [product-design.md](./product-design.md) | Product boundary and positioning, scenarios, information architecture, conversation/session model (including the full local session lifecycle in §7.6), interaction principles for talking to a Hermes API server, permissions and security posture (including connection scoping and connection-change behavior in §9.6), v1 scope and non-goals, open questions | When you want to understand **what** the extension is for, **how it should feel**, and the rules its state and lifecycle must obey |
| [architecture.md](./architecture.md) | Internal module breakdown of the extension (side panel page / service worker / storage / API client), responsibility boundaries, runtime data flows, where state lives | When you are about to implement or review the extension's internal structure and want the implementation-layer companion to product-design |
| [api-contract.md](./api-contract.md) | The exact wire contract between the extension and a Hermes Agent API server: endpoints, request/response shapes, SSE event shapes, headers, error-code mapping | When you are wiring up HTTP calls or need to reason about what goes over the network |
| [ui-spec.md](./ui-spec.md) | Visual specification, component inventory, interaction details, accessibility notes — the concrete translation of product-design into pixels and behaviors | When you are building or reviewing UI and need the visual and interaction rules |
| [dev-setup.md](./dev-setup.md) | The intended developer loop: loading the unpacked extension, pointing it at a local or remote Hermes Agent, iterating | When you want to know how development *will* work once implementation catches up with the design |

## Suggested reading order

Product-design is the spine; the other four documents each take a different layer of it and make it concrete. Read in this order:

1. **[product-design.md](./product-design.md) sections 1–3** — confirm the goals, scope, and surface choice still match your expectations.
2. **product-design.md section 7**, especially **7.6 Local session lifecycle** — the rules a v1 implementation must obey for sessions, drafts, streaming, switching, and rename/delete. This is the part most likely to be misimplemented if skimmed.
3. **product-design.md sections 8 and 9** — the Hermes API integration principles and the local/remote connection model. **§9.6 Connection scoping and connection-change behavior** is the companion to §7.6: it defines how local sessions are scoped to a connection profile and what the panel does when the user changes the API base URL or API key. Skip it and it is easy to assume sessions are global across endpoints when they are not.
4. **product-design.md section 12 (Open questions)** — the items that must be resolved with maintainers before implementation begins.
5. **[architecture.md](./architecture.md)** — once you accept the product rules, see how the extension is structured to enforce them.
6. **[api-contract.md](./api-contract.md)** — the wire-level answer to "how does the client actually talk to Hermes?" Read alongside architecture.md when touching the API client.
7. **[ui-spec.md](./ui-spec.md)** — the visual and interaction spec. Read when implementing or reviewing UI; it assumes you have already read product-design §5–§7.
8. **[dev-setup.md](./dev-setup.md)** — read last; it only becomes actionable once the above are implemented.

## How to propose changes to the design

1. Open an issue describing the assumption you want to change and why.
2. If maintainers agree the change is in scope, send a PR that updates `product-design.md` and (if needed) this map.
3. Implementation PRs that contradict the design without first updating the design will be asked to split.
