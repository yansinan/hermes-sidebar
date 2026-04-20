// Tool-progress projection attached to a streaming assistant message.
//
// Driven by the `hermes.tool.progress` SSE custom event (docs/product-design.md
// §6.2, §7.4 and docs/ui-spec.md §3.4). Tool-progress content is never appended
// to the message text; it is shown as inline collapsible blocks and is copied
// separately from the message prose.

export type ToolProgressPhase = "start" | "update" | "end";

export interface ToolProgressEntry {
  /** Stable id so later events can update a started entry in place. */
  id: string;
  toolName: string;
  phase: ToolProgressPhase;
  /** Human-readable status line, e.g. `Calling tool {name}…`. */
  statusText: string;
  startedAt: number;
  endedAt?: number;
}
