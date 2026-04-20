// Stub implementation of the AppController seam.
//
// This exists so the UI shell can mount, render all three regions, and exercise
// a realistic state shape without any of the real runtime (session manager,
// API client, storage gateway, stream handler) being implemented yet. When the
// real runtime lands, this file is replaced; the UI imports only the
// `AppController` seam from `src/shared/app-state.ts`.

import type {
  AppController,
  AppState,
  Banner,
} from "../shared/app-state";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import type {
  ConnectionProfile,
  ProfileKey,
} from "../shared/profile";

function deriveProfile(baseUrl: string): ConnectionProfile {
  let hostShort = baseUrl;
  try {
    const u = new URL(baseUrl);
    hostShort = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    // leave hostShort as the raw string
  }
  return {
    key: baseUrl.replace(/\/$/, "") as ProfileKey,
    baseUrl,
    hostShort,
  };
}

function initialState(settings: Settings = DEFAULT_SETTINGS): AppState {
  return {
    settings,
    activeProfile: deriveProfile(settings.apiBaseUrl),
    connectionStatus: { kind: "unknown" },
    models: [],
    sessions: [],
    activeSessionId: null,
    sessionPhases: {},
    draftInput: "",
    banners: [],
  };
}

export function createStubController(
  initial: AppState = initialState(),
): AppController {
  let state: AppState = initial;
  const listeners = new Set<(s: AppState) => void>();

  const emit = () => {
    for (const l of listeners) l(state);
  };
  const patch = (next: Partial<AppState>) => {
    state = { ...state, ...next };
    emit();
  };

  const unimplementedBanner = (text: string): Banner => ({
    id: `stub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    severity: "info",
    text,
    dismissable: true,
  });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setDraftInput(text) {
      patch({ draftInput: text });
    },

    newDraft() {
      patch({
        banners: [
          ...state.banners,
          unimplementedBanner("New draft is a scaffold stub."),
        ],
      });
    },
    async send() {
      patch({
        banners: [
          ...state.banners,
          unimplementedBanner("Send is not wired yet — scaffold only."),
        ],
      });
    },
    stop() {
      /* noop */
    },
    async retry() {
      /* noop */
    },
    async continueInterrupted() {
      /* noop */
    },
    switchSession(sessionId) {
      patch({ activeSessionId: sessionId });
    },
    renameSession() {
      /* noop */
    },
    deleteSession() {
      /* noop */
    },

    async saveSettings(next) {
      const merged: Settings = { ...state.settings, ...next };
      patch({
        settings: merged,
        activeProfile: deriveProfile(merged.apiBaseUrl),
      });
    },
    selectModel(modelId) {
      patch({ settings: { ...state.settings, defaultModelId: modelId } });
    },
    async recheckHealth() {
      patch({ connectionStatus: { kind: "connecting" } });
    },
    async grantHostPermission() {
      return false;
    },

    dismissBanner(bannerId) {
      patch({ banners: state.banners.filter((b) => b.id !== bannerId) });
    },
  };
}
