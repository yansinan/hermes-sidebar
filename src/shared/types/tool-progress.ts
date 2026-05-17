/**
 * Tool-progress projection attached to a streaming assistant message.
 * Driven by the `hermes.tool.progress` SSE custom event (see docs/product-design.md §6.2, §7.4; docs/ui-spec.md §3.4).
 * Tool-progress content is shown as inline collapsible blocks, never appended to message text.
 */
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
