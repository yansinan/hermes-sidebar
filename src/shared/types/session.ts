// Session shapes owned by the side panel page (the front end is the source of
// truth — docs/product-design.md §7.2, §7.6; docs/architecture.md §3.4, §4.2).

import type { Message } from "./message";
import type { ProfileKey } from "./profile";

export interface Session {
  id: string;
  /** The profile this session belongs to. Cross-profile leakage is forbidden. */
  profileKey: ProfileKey;
  /** User-editable title; initially derived from the first user message. */
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Model selected for *new* sends in this session. Historical messages keep their own. */
  modelId: string;
  messages: Message[];
  /** Optional continuation hint captured when "Reuse Hermes server-side session" is on. */
  serverSessionRef?: string;
}

/**
 * An empty, in-memory-only draft session. It has a tentative id and model but
 * has never been persisted; it is promoted to a real `Session` on the first
 * send and never appears in the persisted session list until then (§7.6).
 */
export interface DraftSession {
  kind: "draft";
  tentativeId: string;
  profileKey: ProfileKey;
  modelId: string;
}

export type SessionOrDraft = Session | DraftSession;

/**
 * Lifecycle phase of a session from the controllers' point of view.
 * The "streaming" phase is per-session, not global: two different sessions can
 * be streaming at the same time (docs/product-design.md §7.6).
 */
export type SessionPhase =
  | "idle"
  | "sending"
  | "queued"
  | "running"
  | "waiting-approval"
  | "streaming";
