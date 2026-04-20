// Top-level AppState shape the view model projects from.
//
// See docs/architecture.md §3.2 (view model), §3.3 (controllers), §4.1 (in-memory
// state) and §4.2 (persisted state). This is an *in-memory* snapshot; it is
// rebuilt on panel open from settings + per-profile persisted data.

import type {
  ConnectionProfile,
  ConnectionStatus,
  ProfileKey,
} from "./profile";
import type { Session, SessionPhase } from "./session";
import type { Settings } from "./settings";

export interface ModelInfo {
  id: string;
  /** Display label for the dropdown; falls back to `id` when absent. */
  displayName?: string;
}

export type BannerSeverity = "info" | "warning" | "error";

export interface Banner {
  id: string;
  severity: BannerSeverity;
  /** Short message body. Copy strings live in the UI layer; keep this generic. */
  text: string;
  /** If true, user can dismiss with the banner's close button. */
  dismissable: boolean;
}

export interface AppState {
  settings: Settings;
  activeProfile: ConnectionProfile;
  connectionStatus: ConnectionStatus;
  /** Last-fetched model list for the active profile (in-memory cache). */
  models: ModelInfo[];
  /** Session rows for the active profile only (per-profile scoping §9.6). */
  sessions: Session[];
  /** Active session id within the active profile, or null for empty-state. */
  activeSessionId: string | null;
  /** Per-session phase; keys are session ids. Sessions not present are idle. */
  sessionPhases: Record<string, SessionPhase>;
  /** Profile-scoped draft input text, in-memory only (§9.6). */
  draftInput: string;
  /** Stacked banners; UI renders at most two deep (docs/ui-spec.md §3.5). */
  banners: Banner[];
}

/**
 * Shape of the controller seam exposed to the UI shell.
 * Controllers are where docs/product-design.md §7.6 and §9.6 transitions live
 * (see docs/architecture.md §3.3). This scaffold declares the seam; the real
 * implementation lands with the session manager / API client work.
 */
export interface AppController {
  getState(): AppState;
  subscribe(listener: (state: AppState) => void): () => void;

  // Input
  setDraftInput(text: string): void;

  // Session lifecycle (primitives — see architecture.md §3.4)
  newDraft(): void;
  send(): Promise<void>;
  stop(sessionId: string): void;
  retry(sessionId: string, userMessageId: string): Promise<void>;
  continueInterrupted(sessionId: string, agentMessageId: string): Promise<void>;
  switchSession(sessionId: string): void;
  renameSession(sessionId: string, title: string): void;
  deleteSession(sessionId: string): void;

  // Profile and settings
  saveSettings(next: Partial<Settings>): Promise<void>;
  selectModel(modelId: string): void;
  recheckHealth(): Promise<void>;
  grantHostPermission(profileKey: ProfileKey): Promise<boolean>;

  // Banners
  dismissBanner(bannerId: string): void;
}
