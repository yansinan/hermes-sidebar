// Message shapes the side panel reasons about.
//
// The wire-level shape sent to `/v1/chat/completions` is strictly `{ role, content }`
// per docs/api-contract.md §5.2.1. The richer shape below is the UI/local
// representation: it carries an id, a timestamp, a recorded `modelId`, per-message
// badge state, and — for user messages — the client `Idempotency-Key` needed for
// Retry (per docs/product-design.md §7.5, §7.6).

import type { ToolProgressEntry } from "./tool-progress";

export type MessageRole = "system" | "user" | "assistant";

export type MessageBadge =
  | { kind: "failed-to-send" }
  | { kind: "stopped" }
  | { kind: "connection-interrupted" };

export interface BaseMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
}

export interface SystemMessage extends BaseMessage {
  role: "system";
}

export interface UserMessage extends BaseMessage {
  role: "user";
  /** Client-generated UUID, stable across Retry (per §7.5 / §7.6). */
  idempotencyKey: string;
  badge?: MessageBadge & { kind: "failed-to-send" };
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  /** The model that produced (or is producing) this message. */
  modelId: string;
  /** True while tokens are still arriving. */
  streaming: boolean;
  badge?: MessageBadge & { kind: "stopped" | "connection-interrupted" };
  /** In-order tool-progress events attached to this assistant turn. */
  toolProgress?: ToolProgressEntry[];
}

export type Message = SystemMessage | UserMessage | AssistantMessage;
