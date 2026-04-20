# hermes-sidebar — Documentation

This directory is the documentation home for `hermes-sidebar`, an open-source Chrome Side Panel extension that talks to a Hermes Agent API server (local **or** remote, your choice).

> **Status: design-first.** The repository does not yet contain extension code. The documents here describe what we plan to build, the scope boundaries we are committing to, and the open questions that need answering before implementation begins. Treat every "current assumption" and every entry in the **Open questions** section of `product-design.md` as something to revisit before writing code.

## Documentation map

| Document | What it covers | When to read it |
| --- | --- | --- |
| [product-design.md](./product-design.md) | Product positioning, scenarios, information architecture, screen and region design, conversation/session model **(including the full local session lifecycle in section 7.6)**, interaction with the Hermes API server, permissions and security, v1 scope and future evolution, UI copy examples, open questions | When you want to understand what the extension is for, how it should feel, and how it talks to Hermes |

## Documents intentionally not yet written

The following documents will be added once the design in `product-design.md` is aligned. Do **not** stuff their content into `product-design.md` ahead of time — the boundaries below exist to keep each doc focused.

- `architecture.md` — internal module breakdown of the extension (side panel page / service worker / storage / API client) at the implementation layer.
- `api-contract.md` — exact request/response shapes used against the Hermes API server, SSE event shapes, error code mapping.
- `ui-spec.md` — visual specification, component inventory, interaction details, accessibility notes.
- `dev-setup.md` — how to load the unpacked extension, point it at a local or remote Hermes Agent, and iterate.

## Suggested reading order

1. Read sections 1, 2, and 3 of [product-design.md](./product-design.md) to confirm the goals and scope still match your expectations.
2. Read section 7 — especially **7.6 Local session lifecycle** — to understand the rules a v1 implementation must obey for sessions, drafts, streaming, switching, and rename/delete. This is the part most likely to be misimplemented if skimmed.
3. Read sections 8 and 9 to confirm the Hermes API integration assumptions and the local/remote connection model are sound for your deployment.
4. Finish with section 12 (Open questions) — these are the items that must be resolved with maintainers before implementation begins.

## How to propose changes to the design

1. Open an issue describing the assumption you want to change and why.
2. If maintainers agree the change is in scope, send a PR that updates `product-design.md` and (if needed) this map.
3. Implementation PRs that contradict the design without first updating the design will be asked to split.
