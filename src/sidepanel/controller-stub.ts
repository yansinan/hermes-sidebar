// Controller entrypoint for the side panel page.
//
// Two factories live here:
//
//   * `createPanelController`  — wires the real runtime controller from
//     `src/runtime/controller.ts`. This is what `main.tsx` uses.
//   * `createStubController`    — a self-contained, in-memory controller
//     used by tests and dev rendering. It never touches storage or the
//     network; session/draft/profile transitions are all emulated locally
//     so the UI can be exercised without a Hermes backend.
//
// The UI shell talks to the `AppController` seam from
// `src/shared/app-state.ts` and does not care which factory produced it.

import type {
  AppController,
  AppState,
  ModelInfo,
} from "../shared/app-state";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import type { ProfileKey } from "../shared/profile";
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from "../shared/message";
import type { Session, SessionPhase } from "../shared/session";
import {
  createRealController,
  type BuildControllerOptions,
} from "../runtime/controller";
import { toProfile } from "../runtime/profile";

function randomId(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Async factory that loads from storage and kicks off the initial health
 * check. The side panel page uses this on mount.
 */
export async function createPanelController(
  opts?: BuildControllerOptions,
): Promise<AppController> {
  return createRealController(opts);
}

export function initialStubState(settings: Settings = DEFAULT_SETTINGS): AppState {
  return {
    settings,
    activeProfile: toProfile(settings.apiBaseUrl),
    connectionStatus: { kind: "unknown" },
    models: [],
    sessions: [],
    activeSessionId: null,
    sessionPhases: {},
    draftInput: "",
    banners: [],
  };
}

export interface StubControllerOptions {
  /** Optional initial app state override (used by tests / dev preview). */
  initial?: AppState;
  /**
   * Optional: model list to serve after the first `recheckHealth` call, so
   * the UI can exercise the "healthy + models" branch without real network.
   */
  seededModels?: ModelInfo[];
  /**
   * Optional: when true, the stub pretends `recheckHealth` succeeds instantly.
   * Defaults to true for the default dev preview so the UI renders the happy
   * path; the smoke test keeps the initial `unknown` status untouched because
   * it never calls `recheckHealth`.
   */
  autoHealthOnRecheck?: boolean;
}

export function createStubController(
  opts: StubControllerOptions = {},
): AppController {
  const seededModels: ModelInfo[] =
    opts.seededModels ?? [
      { id: "hermes-default", displayName: "hermes-default" },
      { id: "gpt-4o-mini", displayName: "gpt-4o-mini" },
    ];
  const autoHealth = opts.autoHealthOnRecheck ?? true;

  let state: AppState = opts.initial ?? initialStubState();
  const listeners = new Set<(s: AppState) => void>();

  // Per-session in-flight abort controllers (architecture.md §4.1).
  const aborts = new Map<string, AbortController>();
  // Per-session draft memo (profile scoped — the active profile's sessions are
  // the only ones in state.sessions at any time). This lets session switching
  // swap the visible draft, per ui-spec §4.6.
  const draftBySession = new Map<string, string>();
  // Draft memo for the "no-active-session" slot (empty draft / empty state).
  const noSessionDraftByProfile = new Map<ProfileKey, string>();
  // Off-profile sessions: when the user switches profile, the current list is
  // stashed here so it reappears unchanged on switch-back (product-design §9.6).
  const sessionsByProfile = new Map<ProfileKey, Session[]>();
  const activeByProfile = new Map<ProfileKey, string | null>();

  const emit = () => {
    for (const l of listeners) l(state);
  };

  const setState = (next: AppState) => {
    state = next;
    emit();
  };

  const patch = (partial: Partial<AppState>) => {
    setState({ ...state, ...partial });
  };

  const updateSession = (
    sessionId: string,
    mutate: (s: Session) => Session,
  ): Session[] =>
    state.sessions.map((s) => (s.id === sessionId ? mutate(s) : s));

  const updateMessage = (
    sessionId: string,
    messageId: string,
    mutate: (m: Message) => Message,
  ): Session[] =>
    updateSession(sessionId, (s) => ({
      ...s,
      updatedAt: Date.now(),
      messages: s.messages.map((m) => (m.id === messageId ? mutate(m) : m)),
    }));

  const stubResponse =
    "Here's a simulated streamed reply from the stub controller.\n\n" +
    "```ts\nfunction greet(name: string) {\n  return `hello, ${name}`;\n}\n```\n\n" +
    "The real runtime will stream actual tokens from the Hermes API.";

  const simulateStream = (sessionId: string, assistantMessageId: string) => {
    const controller = new AbortController();
    aborts.set(sessionId, controller);

    let index = 0;
    const tick = () => {
      if (controller.signal.aborted) return;
      index = Math.min(stubResponse.length, index + 4);

      // Insert a tool-progress event around 25% through, for demo.
      const shouldInsertToolStart = index >= Math.floor(stubResponse.length * 0.25);
      const shouldInsertToolEnd = index >= Math.floor(stubResponse.length * 0.55);

      setState({
        ...state,
        sessions: updateMessage(sessionId, assistantMessageId, (m) => {
          if (m.role !== "assistant") return m;
          const toolProgress = [...(m.toolProgress ?? [])];
          const existing = toolProgress.find((t) => t.id === "tool-demo");
          if (shouldInsertToolStart && !existing) {
            toolProgress.push({
              id: "tool-demo",
              toolName: "web_search",
              phase: "start",
              statusText: "Calling tool web_search…",
              startedAt: Date.now(),
            });
          }
          if (shouldInsertToolEnd && existing && existing.phase !== "end") {
            const idx = toolProgress.indexOf(existing);
            toolProgress[idx] = {
              ...existing,
              phase: "end",
              statusText: "Tool web_search finished",
              endedAt: Date.now(),
            };
          }
          return {
            ...m,
            content: stubResponse.slice(0, index),
            toolProgress,
          };
        }),
      });

      if (index >= stubResponse.length) {
        setState({
          ...state,
          sessions: updateMessage(sessionId, assistantMessageId, (m) => {
            if (m.role !== "assistant") return m;
            return { ...m, streaming: false };
          }),
          sessionPhases: { ...state.sessionPhases, [sessionId]: "idle" },
        });
        aborts.delete(sessionId);
        return;
      }
      setTimeout(tick, 30);
    };
    setTimeout(tick, 30);
  };

  const pickModelId = (): string => {
    return (
      state.settings.defaultModelId ||
      state.models[0]?.id ||
      seededModels[0]?.id ||
      "hermes-default"
    );
  };

  const stub: AppController = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setDraftInput(text) {
      if (state.activeSessionId) {
        draftBySession.set(state.activeSessionId, text);
      } else {
        noSessionDraftByProfile.set(state.activeProfile.key, text);
      }
      patch({ draftInput: text });
    },

    newDraft() {
      if (state.activeSessionId) {
        draftBySession.set(state.activeSessionId, state.draftInput);
      }
      const existingDraft =
        noSessionDraftByProfile.get(state.activeProfile.key) ?? "";
      patch({
        activeSessionId: null,
        draftInput: existingDraft,
      });
    },

    async send() {
      const text = state.draftInput.trim();
      if (!text) return;
      if (state.models.length === 0) return;
      if (state.connectionStatus.kind === "failed") return;

      const now = Date.now();
      let sessionId = state.activeSessionId;
      let sessions = state.sessions;

      const userMsg: UserMessage = {
        id: randomId("um"),
        role: "user",
        content: text,
        createdAt: now,
        idempotencyKey: randomId("idem"),
      };
      const assistantMsg: AssistantMessage = {
        id: randomId("am"),
        role: "assistant",
        content: "",
        createdAt: now,
        modelId: pickModelId(),
        streaming: true,
        toolProgress: [],
      };

      if (!sessionId) {
        const newSession: Session = {
          id: randomId("s"),
          profileKey: state.activeProfile.key,
          title: text.slice(0, 48),
          createdAt: now,
          updatedAt: now,
          modelId: pickModelId(),
          messages: [userMsg, assistantMsg],
        };
        sessionId = newSession.id;
        sessions = [newSession, ...state.sessions];
        noSessionDraftByProfile.delete(state.activeProfile.key);
      } else {
        sessions = state.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                updatedAt: now,
                messages: [...s.messages, userMsg, assistantMsg],
              }
            : s,
        );
      }

      draftBySession.delete(sessionId);

      setState({
        ...state,
        sessions,
        activeSessionId: sessionId,
        draftInput: "",
        sessionPhases: { ...state.sessionPhases, [sessionId]: "streaming" },
      });

      simulateStream(sessionId, assistantMsg.id);
    },

    stop(sessionId) {
      const controller = aborts.get(sessionId);
      if (controller) {
        controller.abort();
        aborts.delete(sessionId);
      }
      setState({
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== sessionId) return s;
          const last = s.messages[s.messages.length - 1];
          if (!last || last.role !== "assistant") return s;
          const updated: AssistantMessage = {
            ...last,
            streaming: false,
            badge: { kind: "stopped" },
          };
          return {
            ...s,
            updatedAt: Date.now(),
            messages: [...s.messages.slice(0, -1), updated],
          };
        }),
        sessionPhases: { ...state.sessionPhases, [sessionId]: "idle" },
      });
    },

    async retry(sessionId, userMessageId) {
      const session = state.sessions.find((s) => s.id === sessionId);
      if (!session) return;
      const userMsg = session.messages.find(
        (m) => m.id === userMessageId && m.role === "user",
      ) as UserMessage | undefined;
      if (!userMsg) return;

      const assistantMsg: AssistantMessage = {
        id: randomId("am"),
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        modelId: pickModelId(),
        streaming: true,
        toolProgress: [],
      };

      const sessions = updateSession(sessionId, (s) => ({
        ...s,
        updatedAt: Date.now(),
        messages: s.messages
          .map((m) =>
            m.id === userMessageId && m.role === "user"
              ? ({ ...m, badge: undefined } as UserMessage)
              : m,
          )
          .concat(assistantMsg),
      }));

      setState({
        ...state,
        sessions,
        sessionPhases: { ...state.sessionPhases, [sessionId]: "streaming" },
      });
      simulateStream(sessionId, assistantMsg.id);
    },

    async continueInterrupted(sessionId) {
      const session = state.sessions.find((s) => s.id === sessionId);
      if (!session) return;
      const assistantMsg: AssistantMessage = {
        id: randomId("am"),
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        modelId: pickModelId(),
        streaming: true,
        toolProgress: [],
      };
      const sessions = updateSession(sessionId, (s) => ({
        ...s,
        updatedAt: Date.now(),
        messages: [...s.messages, assistantMsg],
      }));
      setState({
        ...state,
        sessions,
        sessionPhases: { ...state.sessionPhases, [sessionId]: "streaming" },
      });
      simulateStream(sessionId, assistantMsg.id);
    },

    switchSession(sessionId) {
      if (state.activeSessionId === sessionId) return;
      if (state.activeSessionId) {
        draftBySession.set(state.activeSessionId, state.draftInput);
      } else {
        noSessionDraftByProfile.set(state.activeProfile.key, state.draftInput);
      }
      const nextDraft = draftBySession.get(sessionId) ?? "";
      patch({ activeSessionId: sessionId, draftInput: nextDraft });
    },

    renameSession(sessionId, title) {
      const trimmed = title.trim();
      if (!trimmed) return;
      patch({
        sessions: updateSession(sessionId, (s) => ({
          ...s,
          title: trimmed,
          updatedAt: Date.now(),
        })),
      });
    },

    deleteSession(sessionId) {
      const controller = aborts.get(sessionId);
      if (controller) {
        controller.abort();
        aborts.delete(sessionId);
      }
      draftBySession.delete(sessionId);

      const remaining = state.sessions.filter((s) => s.id !== sessionId);
      let nextActive = state.activeSessionId;
      if (state.activeSessionId === sessionId) {
        const fallback = [...remaining].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        )[0];
        nextActive = fallback ? fallback.id : null;
      }
      const nextPhases = { ...state.sessionPhases };
      delete nextPhases[sessionId];
      patch({
        sessions: remaining,
        activeSessionId: nextActive,
        sessionPhases: nextPhases,
        draftInput:
          nextActive === null
            ? noSessionDraftByProfile.get(state.activeProfile.key) ?? ""
            : draftBySession.get(nextActive) ?? "",
      });
    },

    async saveSettings(next) {
      const merged: Settings = { ...state.settings, ...next };
      const newProfile = toProfile(merged.apiBaseUrl);
      const profileChanged = newProfile.key !== state.activeProfile.key;
      const keyChanged = merged.apiKey !== state.settings.apiKey;

      if (profileChanged) {
        sessionsByProfile.set(state.activeProfile.key, state.sessions);
        activeByProfile.set(state.activeProfile.key, state.activeSessionId);
        if (state.activeSessionId) {
          draftBySession.set(state.activeSessionId, state.draftInput);
        } else {
          noSessionDraftByProfile.set(
            state.activeProfile.key,
            state.draftInput,
          );
        }
        for (const [, c] of aborts) c.abort();
        aborts.clear();

        const incomingSessions = sessionsByProfile.get(newProfile.key) ?? [];
        const incomingActive = activeByProfile.get(newProfile.key) ?? null;
        const incomingDraft =
          incomingActive && draftBySession.has(incomingActive)
            ? draftBySession.get(incomingActive) ?? ""
            : noSessionDraftByProfile.get(newProfile.key) ?? "";

        setState({
          ...state,
          settings: merged,
          activeProfile: newProfile,
          sessions: incomingSessions,
          activeSessionId: incomingActive,
          draftInput: incomingDraft,
          sessionPhases: {},
          connectionStatus: { kind: "connecting" },
          models: [],
          banners: [
            ...state.banners,
            {
              id: randomId("banner"),
              severity: "info",
              text: `Switched to ${newProfile.hostShort}. Your conversations for the previous endpoint stay saved.`,
              dismissable: true,
            },
          ],
        });
        await stub.recheckHealth();
      } else if (keyChanged) {
        setState({
          ...state,
          settings: merged,
          banners: [
            ...state.banners,
            {
              id: randomId("banner"),
              severity: "info",
              text: `API key updated for ${state.activeProfile.hostShort}.`,
              dismissable: true,
            },
          ],
        });
      } else {
        setState({ ...state, settings: merged });
      }
    },

    selectModel(modelId) {
      const nextSettings: Settings = {
        ...state.settings,
        defaultModelId: modelId,
      };
      const nextSessions = state.activeSessionId
        ? updateSession(state.activeSessionId, (s) => ({
            ...s,
            modelId,
            updatedAt: Date.now(),
          }))
        : state.sessions;
      patch({ settings: nextSettings, sessions: nextSessions });
    },

    async recheckHealth() {
      patch({ connectionStatus: { kind: "connecting" } });
      if (!autoHealth) return;
      await new Promise((r) => setTimeout(r, 30));
      const nextModels = seededModels;
      const prevModelId = state.settings.defaultModelId;
      const modelStillAvailable =
        prevModelId && nextModels.some((m) => m.id === prevModelId);

      const nextBanners = [...state.banners];
      let nextDefaultModel = prevModelId;
      if (!modelStillAvailable && nextModels.length > 0) {
        nextDefaultModel = nextModels[0]!.id;
        if (prevModelId) {
          nextBanners.push({
            id: randomId("banner"),
            severity: "info",
            text: `Model ${prevModelId} isn't available on ${state.activeProfile.hostShort}. Sends now use ${nextDefaultModel}.`,
            dismissable: true,
          });
        }
      }
      if (!prevModelId && nextModels.length > 0) {
        nextDefaultModel = nextModels[0]!.id;
      }

      setState({
        ...state,
        connectionStatus: { kind: "healthy", lastCheckedAt: Date.now() },
        models: nextModels,
        settings: { ...state.settings, defaultModelId: nextDefaultModel ?? "" },
        banners: nextBanners,
      });
    },

    async grantHostPermission() {
      return true;
    },

    dismissBanner(bannerId) {
      patch({ banners: state.banners.filter((b) => b.id !== bannerId) });
    },
  };

  return stub;
}

export { toProfile };
export type { SessionPhase };
