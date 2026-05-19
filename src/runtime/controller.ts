// Real AppController (docs/architecture.md §3.3).
//
// Composes settings, profile normalization, session lifecycle, storage, and
// the Hermes API client behind the `AppController` seam already consumed by
// the UI shell. The UI only talks to this module; nothing else.

import type {
  AppController,
  AppState,
  Banner,
  ModelInfo,
  AssistantMessage,
  Message,
  UserMessage,
  ConnectionProfile,
  ConnectionStatus,
  ProfileKey,
  Session,
  SessionPhase,
  ToolProgressEntry,
} from "../shared/types";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types/settings";
import {
  extractPageMainContent,
  htmlToMarkdown,
  shortId,
  uuid,
  type PageExtractionResult,
} from "../shared/utils";

import {
  HermesApiClient,
  toWireMessages,
  type ChatCompletionsRequest,
} from "../api/client";
import type { ApiError } from "../api/errors";
import { consumeChatStream, type StreamOutcome } from "../api/stream";
import { consumeRunEvents } from "../api/runs";

import {
  createStorageGateway,
  type StorageGateway,
} from "../storage/gateway";
import { normalizeBaseUrl, toProfile } from "./profile";
import {
  formatProcessTimestamp,
  toSystemTimelineMessages,
  type ActivityTimelineItem,
} from "../shared/process-events";
import { formatRunsQueueWait, RUNS_EVENT_LABELS } from "../shared/runs-status";

export interface BuildControllerOptions {
  gateway?: StorageGateway;
  apiClient?: HermesApiClient;
  /** Used only when no custom client is supplied. */
  fetchImpl?: typeof fetch;
  /** If false, skip the boot-time health check (used by tests). */
  autoBoot?: boolean;
}

interface InFlight {
  controller: AbortController;
  sessionId: string;
  userMessageId: string;
  idempotencyKey: string;
  runId?: string;
  transport?: "chat" | "runs";
}

const MAX_TITLE_LENGTH = 64;

/**
 * Synchronously build a controller with stubbed state. Call `boot()` to load
 * from storage and fire the initial health/model fetches. The default
 * `createRealController` below calls `boot()` for you.
 */
export function buildController(
  opts: BuildControllerOptions = {},
): RealController {
  const gateway = opts.gateway ?? createStorageGateway();
  const apiClient =
    opts.apiClient ??
    new HermesApiClient({
      baseUrl: DEFAULT_SETTINGS.apiBaseUrl,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  return new RealController(gateway, apiClient);
}

export async function createRealController(
  opts: BuildControllerOptions = {},
): Promise<RealController> {
  const c = buildController(opts);
  if (opts.autoBoot !== false) await c.boot();
  return c;
}

export class RealController implements AppController {
  private state: AppState;
  private readonly listeners = new Set<(s: AppState) => void>();

  /** Draft input text per profile. In-memory only. */
  private readonly drafts = new Map<ProfileKey, string>();

  /** Per-session in-flight request metadata. */
  private readonly inFlight = new Map<string, InFlight>();

  /** Cached models per profile, re-fetched on profile/key change. */
  private readonly modelsByProfile = new Map<ProfileKey, ModelInfo[]>();

  /** Last successful full-page capture; restored when user clears selection. */
  private lastPageCapture: import("../shared/app-state").MarkdownPreviewState | null = null;

  constructor(
    private readonly gateway: StorageGateway,
    private readonly api: HermesApiClient,
  ) {
    const settings = { ...DEFAULT_SETTINGS };
    const profile = toProfile(settings.apiBaseUrl);
    this.state = {
      settings,
      activeProfile: profile,
      connectionStatus: { kind: "unknown" },
      models: [],
      sessions: [],
      activeSessionId: null,
      sessionPhases: {},
      draftInput: "",
      banners: [],
      markdownPreview: {
        content: "",
        collapsed: true,
        status: "idle",
      },
      composerSelection: { start: 0, end: 0 },
      runtimeDebugLog: [],
    };
  }

  async boot(): Promise<void> {
    const settings = await this.gateway.loadSettings();
    const parsed = normalizeBaseUrl(settings.apiBaseUrl);
    const profile = parsed
      ? {
          key: parsed.key,
          baseUrl: parsed.baseUrl,
          hostShort: parsed.hostShort,
        }
      : toProfile(settings.apiBaseUrl);
    this.api.setBaseUrl(profile.baseUrl);

    const record = await this.gateway.loadProfile(profile.key);
    let activeSessionId: string | null = null;
    if (
      record.activeSessionId &&
      record.sessions.some((s) => s.id === record.activeSessionId)
    ) {
      activeSessionId = record.activeSessionId;
    } else if (record.sessions.length > 0) {
      const latest = [...record.sessions].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      )[0]!;
      activeSessionId = latest.id;
    }

    this.setState({
      settings,
      activeProfile: profile,
      sessions: record.sessions,
      activeSessionId,
      draftInput: this.drafts.get(profile.key) ?? "",
      sessionPhases: {},
      models: [],
      banners: [],
      connectionStatus: { kind: "unknown" },
      markdownPreview: this.state.markdownPreview,
      composerSelection: this.state.composerSelection,
    });

    await this.refreshConnection();
    await this.refreshMarkdownPreview();
  }

  // ---- AppController surface -------------------------------------------

  getState(): AppState {
    return this.state;
  }

  subscribe(listener: (s: AppState) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  setDraftInput(text: string): void {
    this.drafts.set(this.state.activeProfile.key, text);
    this.patch({ draftInput: text });
  }

  newDraft(): void {
    // An empty draft is just a null `activeSessionId` plus a blank textarea.
    // v1 never accumulates multiple unsent drafts.
    this.drafts.set(this.state.activeProfile.key, "");
    this.patch({ activeSessionId: null, draftInput: "" });
  }

  async send(): Promise<void> {
    const draft = this.state.draftInput.trim();
    if (draft.length === 0) return;
    const modelId = this.currentModelId();
    if (!modelId) {
      this.pushBanner({
        severity: "warning",
        text: "No model selected. Pick a model in the top bar first.",
      });
      return;
    }

    const now = Date.now();
    let session = this.activeSession();
    if (!session) {
      session = this.promoteDraft(draft, modelId, now);
    }

    const userMessage: UserMessage = {
      id: shortId("um"),
      role: "user",
      content: draft,
      createdAt: now,
      idempotencyKey: uuid(),
    };
    const assistantMessage: AssistantMessage = {
      id: shortId("am"),
      role: "assistant",
      content: "",
      createdAt: now,
      modelId,
      responseChannelTrying:
        this.state.settings.streamingEnabled && this.state.settings.useRunsApi !== false
          ? "run"
          : "chat",
      streaming: true,
    };
    const updatedSession: Session = {
      ...session,
      updatedAt: now,
      modelId,
      messages: [...session.messages, userMessage, assistantMessage],
    };
    this.putSession(updatedSession, { makeActive: true });
    this.drafts.set(this.state.activeProfile.key, "");
    this.patch({ draftInput: "" });
    await this.persist();

    await this.runSend(updatedSession.id, userMessage, assistantMessage);
  }

  stop(sessionId: string): void {
    const handle = this.inFlight.get(sessionId);
    if (!handle) return;
    this.setRuntimeDebug(`stop requested: session=${sessionId}`);
    if (handle.runId) {
      const apiKey = this.state.settings.apiKey || undefined;
      this.setRuntimeDebug(`stop run request sent: run_id=${handle.runId}`);
      void this.api.stopRun(handle.runId, { apiKey }).catch(() => undefined);
    }
    handle.controller.abort();
  }

  async retry(sessionId: string, userMessageId: string): Promise<void> {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const idx = session.messages.findIndex((m) => m.id === userMessageId);
    if (idx < 0) return;
    const user = session.messages[idx];
    if (!user || user.role !== "user") return;

    // Drop the failed-to-send badge, re-issue with the same idempotency key.
    const cleanedUser: UserMessage = { ...user };
    delete cleanedUser.badge;

    const assistantPlaceholder: AssistantMessage = {
      id: shortId("am"),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      modelId: this.currentModelId() ?? session.modelId,
      responseChannelTrying:
        this.state.settings.streamingEnabled && this.state.settings.useRunsApi !== false
          ? "run"
          : "chat",
      streaming: true,
    };
    // Keep everything before the failed user message, replace the user
    // message itself, then append a fresh agent placeholder.
    const newMessages: Message[] = [
      ...session.messages.slice(0, idx),
      cleanedUser,
      assistantPlaceholder,
    ];
    const next: Session = {
      ...session,
      updatedAt: Date.now(),
      messages: newMessages,
    };
    this.putSession(next, { makeActive: true });
    await this.persist();
    await this.runSend(next.id, cleanedUser, assistantPlaceholder);
  }

  async continueInterrupted(
    sessionId: string,
    agentMessageId: string,
  ): Promise<void> {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const idx = session.messages.findIndex((m) => m.id === agentMessageId);
    if (idx < 0) return;
    const agent = session.messages[idx];
    if (!agent || agent.role !== "assistant") return;

    // v1 Continue = fresh send with existing conversation + new idempotency
    // key (§7.6). The interrupted assistant message stays in history; a new
    // agent placeholder is added for the new turn.
    const cleaned: AssistantMessage = { ...agent, streaming: false };
    delete cleaned.badge;
    const placeholder: AssistantMessage = {
      id: shortId("am"),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      modelId: this.currentModelId() ?? session.modelId,
      responseChannelTrying:
        this.state.settings.streamingEnabled && this.state.settings.useRunsApi !== false
          ? "run"
          : "chat",
      streaming: true,
    };
    // Re-use a synthetic "user" message marker: the last user message in the
    // conversation is the thing we're continuing from. We do NOT append a new
    // user message.
    const lastUser = [...session.messages]
      .slice(0, idx)
      .reverse()
      .find((m): m is UserMessage => m.role === "user");
    if (!lastUser) return;
    const refreshedUser: UserMessage = {
      ...lastUser,
      idempotencyKey: uuid(),
    };
    const newMessages: Message[] = session.messages.map((m) => {
      if (m.id === lastUser.id) return refreshedUser;
      if (m.id === agent.id) return cleaned;
      return m;
    });
    newMessages.push(placeholder);
    const next: Session = {
      ...session,
      updatedAt: Date.now(),
      messages: newMessages,
    };
    this.putSession(next, { makeActive: true });
    await this.persist();
    await this.runSend(next.id, refreshedUser, placeholder);
  }

  switchSession(sessionId: string): void {
    if (!this.state.sessions.some((s) => s.id === sessionId)) return;
    this.patch({ activeSessionId: sessionId });
    void this.persist();
  }

  renameSession(sessionId: string, title: string): void {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    this.putSession(
      { ...session, title: trimmed.slice(0, 120), updatedAt: Date.now() },
      {},
    );
    void this.persist();
  }

  deleteSession(sessionId: string): void {
    const handle = this.inFlight.get(sessionId);
    if (handle) {
      handle.controller.abort();
      this.inFlight.delete(sessionId);
    }
    const sessions = this.state.sessions.filter((s) => s.id !== sessionId);
    let activeSessionId = this.state.activeSessionId;
    if (activeSessionId === sessionId) {
      const fallback = [...sessions].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      )[0];
      activeSessionId = fallback ? fallback.id : null;
    }
    const phases = { ...this.state.sessionPhases };
    delete phases[sessionId];
    this.patch({ sessions, activeSessionId, sessionPhases: phases });
    void this.persist();
  }

  async saveSettings(next: Partial<Settings>): Promise<void> {
    const merged: Settings = { ...this.state.settings, ...next };
    const prevProfileKey = this.state.activeProfile.key;
    const prevKey = this.state.settings.apiKey;

    const parsed = normalizeBaseUrl(merged.apiBaseUrl);
    const newProfile: ConnectionProfile = parsed
      ? {
          key: parsed.key,
          baseUrl: parsed.baseUrl,
          hostShort: parsed.hostShort,
        }
      : toProfile(merged.apiBaseUrl);

    await this.gateway.saveSettings(merged);

    if (newProfile.key !== prevProfileKey) {
      // Cross-profile save: abort in-flight sends in the previous profile,
      // persist its state, then load the new profile's state.
      await this.persist();
      for (const handle of this.inFlight.values()) {
        handle.controller.abort();
      }
      this.inFlight.clear();
      this.api.setBaseUrl(newProfile.baseUrl);

      const record = await this.gateway.loadProfile(newProfile.key);
      let activeSessionId: string | null = null;
      if (
        record.activeSessionId &&
        record.sessions.some((s) => s.id === record.activeSessionId)
      ) {
        activeSessionId = record.activeSessionId;
      } else if (record.sessions.length > 0) {
        activeSessionId = [...record.sessions].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        )[0]!.id;
      }
      const draftInput = this.drafts.get(newProfile.key) ?? "";
      this.setState({
        settings: merged,
        activeProfile: newProfile,
        sessions: record.sessions,
        activeSessionId,
        draftInput,
        sessionPhases: {},
        models: this.modelsByProfile.get(newProfile.key) ?? [],
        connectionStatus: { kind: "unknown" },
        banners: [],
        markdownPreview: this.state.markdownPreview,
        composerSelection: this.state.composerSelection,
      });
      void this.refreshConnection();
      return;
    }

    // Same profile. The key may have changed.
    this.api.setBaseUrl(newProfile.baseUrl);
    const keyChanged = prevKey !== merged.apiKey;
    this.patch({
      settings: merged,
      activeProfile: newProfile,
    });
    if (keyChanged) {
      // API-key-only change: keep sessions/drafts/in-flight as-is, but
      // re-fetch models and health (§9.6).
      void this.refreshConnection();
    }
  }

  selectModel(modelId: string): void {
    const settings = { ...this.state.settings, defaultModelId: modelId };
    this.patch({ settings });
    void this.gateway.saveSettings(settings);
  }

  async recheckHealth(): Promise<void> {
    await this.refreshConnection();
  }

  async grantHostPermission(profileKey: ProfileKey): Promise<boolean> {
    // v1 permission broker stub — full wiring lives with the permissions
    // branch. When `chrome.permissions` is unavailable (tests) return false.
    const g = globalThis as {
      chrome?: {
        permissions?: {
          request: (
            req: { origins: string[] },
            cb: (granted: boolean) => void,
          ) => void;
        };
      };
    };
    const perms = g.chrome?.permissions;
    if (!perms) return false;
    const parsed = normalizeBaseUrl(profileKey);
    if (!parsed) return false;
    return new Promise<boolean>((resolve) => {
      perms.request({ origins: [`${parsed.baseUrl}/*`] }, (granted) => {
        resolve(Boolean(granted));
      });
    });
  }

  dismissBanner(bannerId: string): void {
    this.patch({
      banners: this.state.banners.filter((b) => b.id !== bannerId),
    });
  }

  async addExtractionResult(
    userMessage: UserMessage,
    assistantMessage: AssistantMessage,
    activityTimeline: ActivityTimelineItem[] = [],
  ): Promise<void> {
    const now = Date.now();
    let session = this.activeSession();
    
    if (!session) {
      // Create a new session with the user message as first message
      session = this.promoteDraft(userMessage.content, assistantMessage.modelId, now);
    }

    const modelId = assistantMessage.modelId || this.currentModelId() || session.modelId;
    const systemMessages: Message[] = toSystemTimelineMessages(
      activityTimeline,
      () => shortId("sm"),
    );
    
    // Add both user and assistant messages to the session
    const updatedSession: Session = {
      ...session,
      updatedAt: now,
      modelId,
      messages: [...session.messages, userMessage, ...systemMessages, assistantMessage],
    };
    
    this.putSession(updatedSession, { makeActive: true });
    this.patch({ extractionPhase: "idle" });
    await this.persist();
  }

  setExtractionPhase(phase?: "idle" | "extracting" | "processing"): void {
    this.patch({ extractionPhase: phase });
  }

  /**
   * Re-extract the current tab's content and convert it to Markdown.
   * Called on boot and whenever the user clicks "刷新" in the preview panel.
   *
   * Pipeline: extractPageMainContent (Readability) → htmlToMarkdown (Turndown)
   *   → fallback to parsed.text (article.textContent) if Turndown returns empty.
   */
  async refreshMarkdownPreview(): Promise<void> {
    const tabsApi = (globalThis as { chrome?: typeof chrome }).chrome?.tabs;
    if (!tabsApi?.query) return;

    const current = this.state.markdownPreview ?? {
      content: "",
      collapsed: true,
      status: "idle" as const,
    };
    // Prevent concurrent extractions from SPA onUpdated / onActivated storms.
    if (current.status === "loading") return;
    this.patch({
      markdownPreview: {
        ...current,
        status: "loading",
        error: undefined,
      },
    });

    // Safety net: if the Promise.race timeout somehow never fires (e.g. the
    // side-panel JS engine is throttled), force the panel out of "loading" so
    // the user can still click 刷新 again.
    const SAFETY_MS = 15_000;
    const safetyTimer = setTimeout(() => {
      if (this.state.markdownPreview?.status === "loading") {
        this.patch({
          markdownPreview: {
            ...(this.state.markdownPreview),
            status: "error",
            error: "extraction-timeout",
          },
        });
      }
    }, SAFETY_MS);

    try {
      const [tab] = await tabsApi.query({ active: true, currentWindow: true });
      const tabId = tab?.id;
      if (typeof tabId !== "number") {
        this.patch({
          markdownPreview: {
            ...current,
            status: "error",
            error: "No active tab available for extraction",
          },
        });
        return;
      }

      // Inject the selection watcher BEFORE extraction so it works even when
      // extraction times out (e.g. heavy GitHub / Microsoft SPA pages).
      this.injectSelectionWatcher(tabId);

      // Wrap the extraction + conversion pipeline in timeouts.
      // Pages with huge DOMs or restrictive environments cause executeScript
      // to hang; the race ensures the panel exits "loading" regardless.
      const EXTRACT_TIMEOUT_MS = 10_000;
      const MARKDOWN_TIMEOUT_MS = 14_000;
      const timeoutResult: PageExtractionResult = { text: "", error: "extraction-timeout" };
      const parsed = await Promise.race([
        // TEMP STABILIZATION: dynamic sites (e.g. app-shell pages) can freeze when
        // running Readability in-page. Use fast DOM snapshot mode for preview.
        extractPageMainContent(tabId, {
          useReadability: true,
          debugTrace: this.state.settings.debugPageCaptureTrace ?? false,
        }),
        new Promise<PageExtractionResult>((resolve) =>
          setTimeout(() => resolve(timeoutResult), EXTRACT_TIMEOUT_MS)
        ),
      ]);
      // Use the same converter as selection flow first, so full-page and
      // selection markdown rules stay consistent.
      const markdown = parsed.error === "extraction-timeout"
        ? parsed.error
        : (await Promise.race([
            htmlToMarkdown(parsed.html ?? "", tabId),
            new Promise<string>((resolve) =>
              setTimeout(() => resolve(""), MARKDOWN_TIMEOUT_MS)
            ),
          ])) || stripSkipLinks((parsed.text ?? "").trim());
      const nextPageCapture: import("../shared/app-state").MarkdownPreviewState = {
        content: markdown,
        title: parsed.title ?? tab?.title ?? "Untitled",
        sourceUrl: tab?.url,
        sourceTabId: tabId,
        collapsed: current.collapsed ?? true,
        status: markdown ? "ready" : "error",
        captureSource: "page",
        ...(markdown
          ? { updatedAt: Date.now(), error: undefined }
          : { error: parsed.error ?? "Markdown extraction returned empty content" }),
      };
      // Cache so revertToPageCapture() can restore without re-extracting.
      if (markdown) this.lastPageCapture = nextPageCapture;
      this.patch({ markdownPreview: nextPageCapture });
    } catch (error) {
      this.patch({
        markdownPreview: {
          ...current,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      clearTimeout(safetyTimer);
    }
  }

  toggleMarkdownPreview(collapsed?: boolean): void {
    const current = this.state.markdownPreview ?? {
      content: "",
      collapsed: true,
      status: "idle" as const,
    };
    this.patch({
      markdownPreview: {
        ...current,
        collapsed: typeof collapsed === "boolean" ? collapsed : !current.collapsed,
      },
    });
  }

  insertMarkdownTokenAtCaret(token = "{{markdown}}"): void {
    const draft = this.state.draftInput;
    const start = this.state.composerSelection?.start ?? draft.length;
    const end = this.state.composerSelection?.end ?? start;
    const next = draft.slice(0, start) + token + draft.slice(end);
    const caret = start + token.length;
    this.drafts.set(this.state.activeProfile.key, next);
    this.patch({
      draftInput: next,
      composerSelection: { start: caret, end: caret },
    });
  }

  setComposerSelection(start: number, end: number): void {
    this.patch({ composerSelection: { start, end } });
  }

  /**
   * Revert the preview panel back to the last full-page capture.
   * Called when the user clears their text selection.
   */
  revertToPageCapture(): void {
    if (!this.lastPageCapture) return;
    const current = this.state.markdownPreview;
    // Only revert if the panel is currently showing a selection capture.
    if (current?.captureSource !== "selection") return;
    this.patch({
      markdownPreview: {
        ...this.lastPageCapture,
        collapsed: current?.collapsed ?? this.lastPageCapture.collapsed,
      },
    });
  }

  /**
   * Convert selected HTML captured from the active tab into Markdown and
   * display it in the preview panel.  Called from the App message handler
   * when the injected selection-watcher sends a `page-selection-changed` msg.
   */
  async captureSelectionMarkdown(html: string, tabId: number, preConvertedMarkdown?: string): Promise<void> {
    const immediate = preConvertedMarkdown?.trim();
    if (!immediate && !html.trim()) return;
    const current = this.state.markdownPreview ?? {
      content: "",
      collapsed: false,
      status: "idle" as const,
    };
    // Don't race with an in-progress page extraction; wait for it to settle first.
    if (current.status === "loading") return;

    let markdown: string;
    if (immediate) {
      markdown = immediate;
    } else {
      const TIMEOUT_MS = 8_000;
      markdown = await Promise.race([
        htmlToMarkdown(html, tabId),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), TIMEOUT_MS)),
      ]);
    }
    if (!markdown) return;

    this.patch({
      markdownPreview: {
        ...current,
        content: markdown,
        title: "选中内容",
        sourceTabId: tabId,
        collapsed: false,   // auto-expand when selection is captured
        status: "ready",
        captureSource: "selection",
        updatedAt: Date.now(),
        error: undefined,
      },
    });
  }

  /**
   * Inject a debounced selectionchange listener into the given tab.
   * Protected by a window-level guard so it is safe to call multiple times.
   * Fire-and-forget — failures are non-fatal.
   */
  private injectSelectionWatcher(tabId: number): void {
    const scriptingApi = (globalThis as { chrome?: typeof chrome }).chrome?.scripting;
    if (!scriptingApi?.executeScript) return;
    scriptingApi
      .executeScript({
        target: { tabId },
        func: () => {
          if ((window as any).__hermesSelWatcher) return;
          (window as any).__hermesSelWatcher = true;
          let timer: ReturnType<typeof setTimeout> | null = null;
          let hadSelection = false;
          document.addEventListener("selectionchange", () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              const sel = window.getSelection();
              if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
                // Selection was cleared — revert to page capture if we had one.
                if (hadSelection) {
                  hadSelection = false;
                  try {
                    const p = (chrome as any).runtime
                      .sendMessage({ type: "page-selection-cleared" });
                    if (p && typeof p.catch === "function") {
                      void p.catch(() => { /* extension reloaded or no receiver */ });
                    }
                  } catch {
                    // extension context invalidated
                  }
                }
                return;
              }
              hadSelection = true;
              const parts: string[] = [];
              for (let i = 0; i < sel.rangeCount; i++) {
                const wrap = document.createElement("div");
                wrap.appendChild(sel.getRangeAt(i).cloneContents());
                parts.push(wrap.innerHTML);
              }
              const html = parts.join("\n").trim();
              if (!html) return;
              try {
                const p = (chrome as any).runtime
                  .sendMessage({ type: "page-selection-changed", html });
                if (p && typeof p.catch === "function") {
                  void p.catch(() => { /* extension reloaded, page navigated, or no receiver */ });
                }
              } catch {
                // extension context invalidated
              }
            }, 450);
          });
        },
      })
      .catch(() => { /* restricted page — ignore */ });
  }

  // ---- Internals -------------------------------------------------------

  private activeSession(): Session | null {
    const id = this.state.activeSessionId;
    if (!id) return null;
    return this.state.sessions.find((s) => s.id === id) ?? null;
  }

  private currentModelId(): string | null {
    const fromSettings = this.state.settings.defaultModelId;
    if (fromSettings) return fromSettings;
    const first = this.state.models[0]?.id;
    return first ?? null;
  }

  private promoteDraft(firstUserMessage: string, modelId: string, now: number): Session {
    const title = deriveTitle(firstUserMessage);
    const session: Session = {
      id: shortId("s"),
      profileKey: this.state.activeProfile.key,
      title,
      createdAt: now,
      updatedAt: now,
      modelId,
      messages: [],
    };
    this.patch({
      sessions: [...this.state.sessions, session],
      activeSessionId: session.id,
    });
    return session;
  }

  private putSession(
    session: Session,
    opts: { makeActive?: boolean },
  ): void {
    const has = this.state.sessions.some((s) => s.id === session.id);
    const sessions = has
      ? this.state.sessions.map((s) => (s.id === session.id ? session : s))
      : [...this.state.sessions, session];
    const patch: Partial<AppState> = { sessions };
    if (opts.makeActive) patch.activeSessionId = session.id;
    this.patch(patch);
  }

  private setSessionPhase(sessionId: string, phase: SessionPhase): void {
    const phases = { ...this.state.sessionPhases };
    if (phase === "idle") delete phases[sessionId];
    else phases[sessionId] = phase;
    this.patch({ sessionPhases: phases });
  }

  private pushBanner(b: Omit<Banner, "id" | "dismissable">): void {
    const banner: Banner = {
      id: shortId("b"),
      dismissable: true,
      ...b,
    };
    this.patch({ banners: [...this.state.banners, banner] });
  }

  private setRuntimeDebug(text: string): void {
    if (!(this.state.settings.debugPageCaptureTrace ?? false)) return;
    // 保留最近 40 条，避免长会话导致 UI 和内存持续增长。
    const nextEntry = { at: Date.now(), text };
    const prev = this.state.runtimeDebugLog ?? [];
    const nextLog = [...prev, nextEntry].slice(-40);
    this.patch({
      runtimeDebug: nextEntry,
      runtimeDebugLog: nextLog,
    });
  }

  private async persist(): Promise<void> {
    await this.gateway.saveProfile(this.state.activeProfile.key, {
      sessions: this.state.sessions,
      activeSessionId: this.state.activeSessionId,
      lastModelId: this.state.settings.defaultModelId || null,
    });
  }

  private async refreshConnection(): Promise<void> {
    const apiKey = this.state.settings.apiKey || undefined;
    console.log("[Controller] refreshConnection: checking health...");
    this.patch({ connectionStatus: { kind: "connecting" } });
    const h = await this.api.checkHealth(apiKey);
    if (!h.ok) {
      const reason = healthReason(h.error);
      const status: ConnectionStatus = {
        kind: "failed",
        lastCheckedAt: Date.now(),
        reason,
        ...(h.error?.message ? { message: h.error.message } : {}),
      };
      console.log("[Controller] Health check failed:", reason);
      this.patch({ connectionStatus: status });
      return;
    }
    console.log("[Controller] Health check OK, fetching models...");
    this.patch({
      connectionStatus: { kind: "healthy", lastCheckedAt: Date.now() },
    });
    try {
      const ids = await this.api.listModels(apiKey);
      console.log("[Controller] Models fetched:", ids);
      const models: ModelInfo[] = ids.map((id) => ({ id }));
      this.modelsByProfile.set(this.state.activeProfile.key, models);
      const nextSettings = this.maybeFallbackModel(models);
      console.log("[Controller] After fallback, defaultModelId:", nextSettings.defaultModelId);
      this.patch({ models, settings: nextSettings });
      if (models.length === 0) {
        this.pushBanner({
          severity: "warning",
          text: "No models are available on this Hermes server.",
        });
      }
    } catch (e) {
      // Model fetch failed separately from health — surface a banner.
      const err = e as ApiError;
      console.error("[Controller] Failed to fetch models:", err);
      this.pushBanner({
        severity: "error",
        text: `Could not fetch models: ${err.message ?? err.kind}`,
      });
    }
  }

  private maybeFallbackModel(models: ModelInfo[]): Settings {
    const current = this.state.settings.defaultModelId;
    if (!current && models.length > 0) {
      return { ...this.state.settings, defaultModelId: models[0]!.id };
    }
    if (current && !models.some((m) => m.id === current) && models.length > 0) {
      this.pushBanner({
        severity: "info",
        text: `Model "${current}" isn't available on ${this.state.activeProfile.hostShort}. Sends now use "${models[0]!.id}".`,
      });
      return { ...this.state.settings, defaultModelId: models[0]!.id };
    }
    return this.state.settings;
  }

  private async runSend(
    sessionId: string,
    userMessage: UserMessage,
    assistantMessage: AssistantMessage,
  ): Promise<void> {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    const controller = new AbortController();
    const inflight: InFlight = {
      controller,
      sessionId,
      userMessageId: userMessage.id,
      idempotencyKey: userMessage.idempotencyKey,
    };
    this.inFlight.set(sessionId, inflight);
    this.setSessionPhase(sessionId, "sending");
    this.setRuntimeDebug(
      `send start: session=${sessionId} streaming=${this.state.settings.streamingEnabled} runs=${this.state.settings.useRunsApi !== false}`,
    );

    const apiKey = this.state.settings.apiKey || undefined;
    const streaming = this.state.settings.streamingEnabled;
    const useRunsApi = this.state.settings.useRunsApi !== false;
    const renderedMessages = session.messages
      .filter((m) => m.id !== assistantMessage.id)
      .map((m) => ({ ...m, content: this.renderTemplateVariables(m.content) }));
    const wireMessages = toWireMessages(renderedMessages);

    const req: ChatCompletionsRequest = {
      model: assistantMessage.modelId,
      messages: wireMessages,
      stream: streaming,
      signal: controller.signal,
      ...(apiKey ? { apiKey } : {}),
      ...(this.state.settings.sendIdempotencyKey
        ? { idempotencyKey: userMessage.idempotencyKey }
        : {}),
      ...(this.state.settings.reuseServerSession && session.serverSessionRef
        ? { serverSessionRef: session.serverSessionRef }
        : {}),
    };

    const notifyExtractionProcessing = async (statusText: string): Promise<void> => {
      try {
        await chrome.runtime.sendMessage({
          type: "extraction-processing",
          statusText,
          transportInfo: inflight.transport === "runs" ? "runs" : "chat",
        });
      } catch {
        // best effort only
      }
    };

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    try {
      if (!streaming) {
        inflight.transport = "chat";
        this.setAssistantTryingChannel(sessionId, assistantMessage.id, "chat");
        this.setRuntimeDebug("transport=chat-completion (non-streaming)");
        const done = await this.api.completeOnce(req);
        this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
          content: done.content,
          outcome: "ok",
          responseChannel: "chat",
          ...(done.serverSessionRef ? { serverSessionRef: done.serverSessionRef } : {}),
        });
        await this.persist();
        return;
      }

      const runReq = {
        model: assistantMessage.modelId,
        messages: wireMessages,
        signal: controller.signal,
        ...(apiKey ? { apiKey } : {}),
        ...(this.state.settings.sendIdempotencyKey
          ? { idempotencyKey: userMessage.idempotencyKey }
          : {}),
        ...(this.state.settings.reuseServerSession && session.serverSessionRef
          ? {
              sessionId: session.serverSessionRef,
              serverSessionRef: session.serverSessionRef,
            }
          : {}),
      };

      if (useRunsApi) {
        try {
          inflight.transport = "runs";
          this.setAssistantTryingChannel(sessionId, assistantMessage.id, "run");
          const emitRunEvent = (line: string, detail?: string) => {
            this.pushActivityMessage(sessionId, assistantMessage.id, line, detail);
          };
          this.setRuntimeDebug("transport=runs createRun");
          const created = await this.api.createRun(runReq);
          inflight.runId = created.runId;
          this.setRuntimeDebug(`runs created: run_id=${created.runId} status=${created.status}`);
          emitRunEvent(RUNS_EVENT_LABELS.createAcceptedTimeline);

          const createdPhase = phaseFromRunStatus(created.status);
          if (createdPhase) {
            this.setSessionPhase(sessionId, createdPhase);
          }

          let firstActivitySeen = false;
          let heartbeatCount = 0;
          const heartbeatIntervalMs = 15_000;
          heartbeatTimer = setInterval(() => {
            if (firstActivitySeen) return;
            heartbeatCount += 1;
            const elapsedSeconds = (heartbeatCount * heartbeatIntervalMs) / 1000;
            const statusText = formatRunsQueueWait(elapsedSeconds);
            void notifyExtractionProcessing(statusText);
          }, heartbeatIntervalMs);

          void notifyExtractionProcessing(RUNS_EVENT_LABELS.createAcceptedProcessBar);
          this.setRuntimeDebug(`transport=runs events open run_id=${created.runId}`);
          emitRunEvent(RUNS_EVENT_LABELS.eventsConnectedTimeline);
          const runEventsRes = await this.api.openRunEvents(created.runId, {
            ...(apiKey ? { apiKey } : {}),
            signal: controller.signal,
          });
          const runHeaderRef = this.api.extractServerSessionRef(runEventsRes);
          if (runHeaderRef) this.attachServerSessionRef(sessionId, runHeaderRef);
          if (!runEventsRes.ok && isRunsFallbackStatus(runEventsRes.status)) {
            throw {
              kind: runEventsRes.status === 404 ? "not-found" : "client-error",
              status: runEventsRes.status,
              message: "runs events endpoint unavailable",
            } satisfies ApiError;
          }

          let streamedContent = "";
          let runOutcome: StreamOutcome | undefined;
          await consumeRunEvents(
            runEventsRes,
            {
              onMessageDelta: (p) => {
                if (!firstActivitySeen) {
                  firstActivitySeen = true;
                  void notifyExtractionProcessing(RUNS_EVENT_LABELS.generatingReply);
                }
                streamedContent += p.delta;
                this.appendStreamDelta(sessionId, assistantMessage.id, p.delta);
              },
              onToolStarted: (p) => {
                if (!firstActivitySeen) {
                  firstActivitySeen = true;
                  void notifyExtractionProcessing(
                    RUNS_EVENT_LABELS.toolRunningProcessBar(p.tool, p.preview),
                  );
                }
                this.setRuntimeDebug(`runs tool started: ${p.tool} ${p.preview || ""}`);
                emitRunEvent(
                  RUNS_EVENT_LABELS.toolStartedTimeline(p.tool),
                  p.preview ? `预览：${p.preview}` : undefined,
                );
              },
              onToolCompleted: (p) => {
                this.setRuntimeDebug(
                  `runs tool completed: ${p.tool} duration=${p.duration.toFixed(3)}s error=${p.error}`,
                );
                emitRunEvent(
                  RUNS_EVENT_LABELS.toolCompletedTimeline(p.tool, p.error),
                  `耗时：${p.duration.toFixed(3)} 秒${p.error ? "，结果失败" : ""}`,
                );
                void notifyExtractionProcessing(
                  RUNS_EVENT_LABELS.toolCompletedProcessBar(p.tool, p.error),
                );
              },
              onReasoningAvailable: (p) => {
                if (!firstActivitySeen) {
                  firstActivitySeen = true;
                  void notifyExtractionProcessing(RUNS_EVENT_LABELS.reasoningProcessBar);
                }
                this.setRuntimeDebug(`runs reasoning available: +${p.text.length} chars`);
                emitRunEvent(RUNS_EVENT_LABELS.reasoningTimeline, p.text);
                // Optionally append reasoning to conversation if desired
              },
              onRunCompleted: (p) => {
                if (!firstActivitySeen) {
                  firstActivitySeen = true;
                  void notifyExtractionProcessing(RUNS_EVENT_LABELS.resultReturned);
                }
                this.setRuntimeDebug(
                  `runs completed: output=${p.output.length} chars, tokens=${p.usage?.total_tokens || 0}`,
                );
                emitRunEvent(
                  RUNS_EVENT_LABELS.runCompletedTimeline,
                  `输出：${p.output.length} 字符${p.usage?.total_tokens ? `，总 tokens：${p.usage.total_tokens}` : ""}`,
                );
                if (streamedContent.length === 0 && p.output.length > 0) {
                  streamedContent = p.output;
                  this.appendStreamDelta(sessionId, assistantMessage.id, p.output);
                } else if (
                  p.output.length > streamedContent.length &&
                  p.output.startsWith(streamedContent)
                ) {
                  const suffix = p.output.slice(streamedContent.length);
                  if (suffix.length > 0) {
                    streamedContent += suffix;
                    this.appendStreamDelta(sessionId, assistantMessage.id, suffix);
                  }
                }
              },
              onRunStatus: (p) => {
                const phase = phaseFromRunStatus(p.status);
                if (phase) this.setSessionPhase(sessionId, phase);
                this.setRuntimeDebug(
                  `runs status: run_id=${p.runId || created.runId} status=${p.status}`,
                );
                if (p.status === "failed") {
                  emitRunEvent(
                    RUNS_EVENT_LABELS.runFailedTimeline,
                    p.error ? `错误：${p.error}` : undefined,
                  );
                } else if (p.status === "cancelled") {
                  emitRunEvent(RUNS_EVENT_LABELS.runCancelledTimeline);
                }
              },
              onServerSessionRef: (ref) => this.attachServerSessionRef(sessionId, ref),
              onUnknownEvent: (eventName, _data) => {
                this.setRuntimeDebug(`runs unknown event: ${eventName}`);
                if (eventName === "approval.request") {
                  const detail = this.formatRunEventDetail(_data, ["prompt", "choices"]);
                  emitRunEvent(RUNS_EVENT_LABELS.approvalRequest, detail);
                  return;
                }
                if (eventName === "approval.responded") {
                  const detail = this.formatRunEventDetail(_data, ["choice", "resolved"]);
                  emitRunEvent(RUNS_EVENT_LABELS.approvalResponded, detail);
                  return;
                }
                emitRunEvent(RUNS_EVENT_LABELS.unknownEvent(eventName));
              },
              onEnd: (outcome) => {
                runOutcome = outcome;
                clearInterval(heartbeatTimer);
                if (outcome.kind === "ok") {
                  emitRunEvent(RUNS_EVENT_LABELS.terminalOk);
                } else if (outcome.kind === "stopped") {
                  emitRunEvent(RUNS_EVENT_LABELS.terminalStopped);
                } else if (outcome.kind === "interrupted") {
                  emitRunEvent(RUNS_EVENT_LABELS.terminalInterrupted);
                }
              },
            },
            controller.signal,
          );

          const outcome = runOutcome ?? { kind: "interrupted", reason: "no outcome" };
          this.setRuntimeDebug(`runs end: kind=${outcome.kind}`);
          if (outcome.kind === "interrupted") {
            this.setRuntimeDebug(`runs interrupted: polling terminal state run_id=${created.runId}`);
            const resolved = await this.waitForRunTerminalState(
              created.runId,
              apiKey,
              controller.signal,
              (line) => emitRunEvent(line),
            );
            if (resolved) {
              if (resolved.serverSessionRef) {
                this.attachServerSessionRef(sessionId, resolved.serverSessionRef);
              }
              if (resolved.content && resolved.content !== streamedContent) {
                emitRunEvent(RUNS_EVENT_LABELS.recoveredFromPoll);
                if (
                  resolved.content.length > streamedContent.length &&
                  resolved.content.startsWith(streamedContent)
                ) {
                  const suffix = resolved.content.slice(streamedContent.length);
                  this.appendStreamDelta(sessionId, assistantMessage.id, suffix);
                } else {
                  this.appendStreamDelta(sessionId, assistantMessage.id, resolved.content);
                }
                streamedContent = resolved.content;
              }
              this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
                content: streamedContent,
                outcome: resolved.outcome,
                responseChannel: "runs",
                ...(resolved.serverSessionRef
                  ? { serverSessionRef: resolved.serverSessionRef }
                  : {}),
              });
              this.setRuntimeDebug(`runs resolved via getRun: ${resolved.outcome}`);
              await this.persist();
              return;
            }
            this.setRuntimeDebug("runs interrupted and unresolved after polling");
            throw {
              kind: "network",
              message: "runs stream ended before terminal state",
            } satisfies ApiError;
          }

          if (outcome.kind === "ok") {
            this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
              content: streamedContent,
              outcome: "ok",
              responseChannel: "runs",
            });
          } else if (outcome.kind === "stopped") {
            this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
              content: streamedContent,
              outcome: "stopped",
              responseChannel: "runs",
            });
          } else {
            this.markSendFailed(sessionId, userMessage.id, assistantMessage.id, {
              kind:
                outcome.status === 401
                  ? "unauthorized"
                  : outcome.status >= 500
                    ? "server-error"
                    : "client-error",
              status: outcome.status,
              ...(outcome.message ? { message: outcome.message } : {}),
            });
          }

          await this.persist();
          return;
        } catch (e) {
          const runsErr = toApiErrorLike(e);
          if (!isRunsFallbackError(runsErr) && runsErr.kind !== "network") {
            throw runsErr;
          }
          this.setRuntimeDebug(
            `runs failed, fallback to chat: kind=${runsErr.kind}${runsErr.status ? ` status=${runsErr.status}` : ""}`,
          );
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
          }
          if (inflight.runId) {
            this.pushActivityMessage(
              sessionId,
              assistantMessage.id,
              RUNS_EVENT_LABELS.fallbackToChat,
            );
          }
          // Continue to the chat streaming path below.
        }
      }

      inflight.transport = "chat";
      this.setAssistantTryingChannel(sessionId, assistantMessage.id, "chat");
      const emitChatEvent = (line: string) => {
        this.pushActivityMessage(sessionId, assistantMessage.id, line);
      };
      let firstActivitySeen = false;
      let chatConnected = false;
      let chatReasoningAnnounced = false;
      let chatReplyStarted = false;
      let heartbeatCount = 0;
      const heartbeatIntervalMs = 15_000;
      heartbeatTimer = setInterval(() => {
        if (firstActivitySeen) return;
        heartbeatCount += 1;
        const elapsedSeconds = (heartbeatCount * heartbeatIntervalMs) / 1000;
        const statusText =
          elapsedSeconds < 60
            ? `模型排队中，已等待 ${elapsedSeconds} 秒...`
            : `模型排队中，已等待 ${Math.round(elapsedSeconds / 60)} 分钟...`;
        void notifyExtractionProcessing(statusText);
      }, heartbeatIntervalMs);

      void notifyExtractionProcessing("请求已发送，等待模型响应...");
      this.setRuntimeDebug("transport=chat-stream");
      const res = await this.api.openChatStream(req);
      if (res.ok && !chatConnected) {
        chatConnected = true;
        emitChatEvent("已连接流式回复");
      }
      this.setSessionPhase(sessionId, "streaming");
      void notifyExtractionProcessing("正在接收模型流式响应...");
      // Capture any session ref off the response head.
      const headerRef = this.api.extractServerSessionRef(res);
      if (headerRef) this.attachServerSessionRef(sessionId, headerRef);

      let streamedContent = "";
      let toolProgress: ToolProgressEntry[] = [];
      await consumeChatStream(
        res,
        {
          onTextDelta: (delta) => {
            if (!firstActivitySeen) {
              firstActivitySeen = true;
              void notifyExtractionProcessing("模型已开始返回内容...");
            }
            if (!chatReplyStarted) {
              chatReplyStarted = true;
              emitChatEvent("模型开始生成回复");
            }
            streamedContent += delta;
            this.appendStreamDelta(sessionId, assistantMessage.id, delta);
          },
          onThinkingDelta: () => {
            if (!chatReasoningAnnounced) {
              chatReasoningAnnounced = true;
              emitChatEvent("模型正在分析问题");
            }
            if (!firstActivitySeen) {
              firstActivitySeen = true;
              void notifyExtractionProcessing("模型正在思考...");
              return;
            }
            void notifyExtractionProcessing("模型思考中...");
          },
          onToolProgress: (p) => {
            if (!firstActivitySeen) {
              firstActivitySeen = true;
            }
            toolProgress = this.applyToolProgress(toolProgress, p);
            this.setToolProgress(sessionId, assistantMessage.id, toolProgress);
            void notifyExtractionProcessing(
              p.status === "running"
                ? `工具 ${p.tool} 调用中${p.label ? `: ${p.label}` : ""}`
                : `工具 ${p.tool} 已完成`,
            );
          },
          onServerSessionRef: (ref) => this.attachServerSessionRef(sessionId, ref),
          onEnd: (outcome) => {
            clearInterval(heartbeatTimer);
            this.setRuntimeDebug(`chat stream end: kind=${outcome.kind}`);
            if (outcome.kind === "ok") {
              emitChatEvent("回复生成完成");
              this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
                content: streamedContent,
                outcome: "ok",
                responseChannel: "chat",
              });
            } else if (outcome.kind === "stopped") {
              emitChatEvent("已停止生成");
              this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
                content: streamedContent,
                outcome: "stopped",
                responseChannel: "chat",
              });
            } else if (outcome.kind === "interrupted") {
              emitChatEvent("连接中断，可继续");
              this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
                content: streamedContent,
                outcome: "interrupted",
                responseChannel: "chat",
              });
            } else {
              // Pre-stream HTTP error: treat as send failure. Drop the agent
              // placeholder and mark the user message failed-to-send.
              this.markSendFailed(
                sessionId,
                userMessage.id,
                assistantMessage.id,
                {
                  kind:
                    outcome.status === 401
                      ? "unauthorized"
                      : outcome.status >= 500
                        ? "server-error"
                        : "client-error",
                  status: outcome.status,
                  ...(outcome.message ? { message: outcome.message } : {}),
                },
              );
            }
          },
        },
        controller.signal,
      );
      await this.persist();
    } catch (e) {
      // If the stream never reached consumeChatStream, stop the heartbeat.
      const err = toApiErrorLike(e);
      this.setRuntimeDebug(
        `send error: kind=${err.kind}${err.status ? ` status=${err.status}` : ""}${err.message ? ` msg=${err.message}` : ""}`,
      );
      if (err.kind === "stopped") {
        // Aborted by user; the stream handler also signals this path in the
        // streaming case. Finalize as stopped.
        this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
          content: "",
          outcome: "stopped",
          responseChannel: inflight.transport === "runs" ? "runs" : "chat",
        });
      } else {
        this.markSendFailed(
          sessionId,
          userMessage.id,
          assistantMessage.id,
          err,
        );
      }
      await this.persist();
    } finally {
      // If the request failed before onEnd ran, clear the heartbeat here too.
      // Clearing an already-cleared interval is harmless.
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      this.inFlight.delete(sessionId);
      this.setSessionPhase(sessionId, "idle");
    }
  }

  private appendStreamDelta(
    sessionId: string,
    messageId: string,
    delta: string,
  ): void {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const messages = session.messages.map((m) => {
      if (m.id !== messageId || m.role !== "assistant") return m;
      return { ...m, content: m.content + delta };
    });
    this.putSession({ ...session, messages, updatedAt: Date.now() }, {});
  }

  private pushActivityMessage(
    sessionId: string,
    anchorMessageId: string,
    line: string,
    detail?: string,
  ): void {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const stamp = formatProcessTimestamp(Date.now());
    const detailText = detail?.trim();
    const msg: Message = {
      id: shortId("sm"),
      role: "system",
      createdAt: Date.now(),
      content: detailText ? `${stamp}  ${line}\n${detailText}` : `${stamp}  ${line}`,
    };
    const anchorIdx = session.messages.findIndex((m) => m.id === anchorMessageId);
    const nextMessages =
      anchorIdx >= 0
        ? [
            ...session.messages.slice(0, anchorIdx),
            msg,
            ...session.messages.slice(anchorIdx),
          ]
        : [...session.messages, msg];
    this.putSession(
      {
        ...session,
        updatedAt: Date.now(),
        messages: nextMessages,
      },
      {},
    );
  }

  private setToolProgress(
    sessionId: string,
    messageId: string,
    entries: ToolProgressEntry[],
  ): void {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const messages = session.messages.map((m) => {
      if (m.id !== messageId || m.role !== "assistant") return m;
      return { ...m, toolProgress: entries };
    });
    this.putSession({ ...session, messages }, {});
  }

  private setAssistantTryingChannel(
    sessionId: string,
    messageId: string,
    channel: "chat" | "run",
  ): void {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const messages = session.messages.map((m) => {
      if (m.id !== messageId || m.role !== "assistant") return m;
      return { ...m, responseChannelTrying: channel };
    });
    this.putSession({ ...session, messages }, {});
  }

  private applyToolProgress(
    prev: ToolProgressEntry[],
    payload: {
      tool: string;
      status: "running" | "completed";
      callId?: string;
      label?: string;
      emoji?: string;
    },
  ): ToolProgressEntry[] {
    if (payload.status === "running") {
      const entry: ToolProgressEntry = {
        id: payload.callId ?? shortId("tp"),
        toolName: payload.tool,
        phase: "start",
        statusText: payload.label
          ? `Calling tool ${payload.tool}: ${payload.label}`
          : `Calling tool ${payload.tool}…`,
        startedAt: Date.now(),
      };
      return [...prev, entry];
    }
    // completed
    if (payload.callId) {
      const idx = prev.findIndex((e) => e.id === payload.callId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = {
          ...next[idx]!,
          phase: "end",
          statusText: `Tool ${payload.tool} finished`,
          endedAt: Date.now(),
        };
        return next;
      }
    }
    return [
      ...prev,
      {
        id: payload.callId ?? shortId("tp"),
        toolName: payload.tool,
        phase: "end",
        statusText: `Tool ${payload.tool} finished`,
        startedAt: Date.now(),
        endedAt: Date.now(),
      },
    ];
  }

  private formatRunEventDetail(raw: string, keys: string[]): string | undefined {
    let parsed: Record<string, unknown> | undefined;
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
    if (!parsed) return undefined;

    const lines: string[] = [];
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        lines.push(`${key}：${value.trim()}`);
        continue;
      }
      if (Array.isArray(value) && value.length > 0) {
        const items = value
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => item.trim());
        if (items.length > 0) {
          lines.push(`${key}：${items.join(" / ")}`);
        }
      }
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  private attachServerSessionRef(sessionId: string, ref: string): void {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session || session.serverSessionRef === ref) return;
    this.putSession({ ...session, serverSessionRef: ref }, {});
  }

  private async waitForRunTerminalState(
    runId: string,
    apiKey?: string,
    signal?: AbortSignal,
    onStatus?: (line: string) => void,
  ): Promise<{
    outcome: "ok" | "stopped" | "interrupted";
    content?: string;
    serverSessionRef?: string;
  } | null> {
    let pollCount = 0;
    for (;;) {
      if (signal?.aborted) return { outcome: "stopped" };
      try {
        const state = await this.api.getRun(runId, {
          ...(apiKey ? { apiKey } : {}),
          ...(signal ? { signal } : {}),
        });
        this.setRuntimeDebug(`runs poll: run_id=${runId} status=${state.status}`);
        onStatus?.(`poll #${pollCount + 1} status ${state.status}`);
        const serverSessionRef = state.sessionId;
        if (state.status === "completed") {
          return {
            outcome: "ok",
            ...(state.output && state.output.trim().length > 0
              ? { content: state.output }
              : {}),
            ...(serverSessionRef ? { serverSessionRef } : {}),
          };
        }
        if (state.status === "cancelled" || state.status === "stopped") {
          return {
            outcome: "stopped",
            ...(state.output && state.output.trim().length > 0
              ? { content: state.output }
              : {}),
            ...(serverSessionRef ? { serverSessionRef } : {}),
          };
        }
        if (state.status === "failed") {
          return {
            outcome: "interrupted",
            ...(state.output && state.output.trim().length > 0
              ? { content: state.output }
              : {}),
            ...(serverSessionRef ? { serverSessionRef } : {}),
          };
        }
      } catch (e) {
        const err = toApiErrorLike(e);
        this.setRuntimeDebug(
          `runs poll failed: kind=${err.kind}${err.status ? ` status=${err.status}` : ""}`,
        );
        onStatus?.(
          `poll #${pollCount + 1} failed ${err.kind}${err.status ? ` status=${err.status}` : ""}`,
        );
        if (err.status === 404) return null;
      }
      pollCount += 1;
      await this.delayWithAbort(1200, signal);
    }
  }

  private async delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), ms);
      });
      return;
    }
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const id = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(id);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private finalizeStreamingMessage(
    sessionId: string,
    messageId: string,
    opts: {
      content: string;
      outcome: "ok" | "stopped" | "interrupted";
      responseChannel?: "chat" | "runs";
      serverSessionRef?: string;
    },
  ): void {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const messages = session.messages.map((m) => {
      if (m.id !== messageId || m.role !== "assistant") return m;
      const next: AssistantMessage = {
        ...m,
        content: opts.content.length > 0 ? opts.content : m.content,
        streaming: false,
        ...(opts.responseChannel ? { responseChannel: opts.responseChannel } : {}),
      };
      delete next.responseChannelTrying;
      if (opts.outcome === "stopped") {
        next.badge = { kind: "stopped" };
      } else if (opts.outcome === "interrupted") {
        next.badge = { kind: "connection-interrupted" };
      } else {
        delete next.badge;
      }
      return next;
    });
    const updated: Session = {
      ...session,
      messages,
      updatedAt: Date.now(),
      ...(opts.serverSessionRef ? { serverSessionRef: opts.serverSessionRef } : {}),
    };
    this.putSession(updated, {});
  }

  private markSendFailed(
    sessionId: string,
    userMessageId: string,
    placeholderId: string,
    err: ApiError,
  ): void {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    // Drop the placeholder and attach `failed-to-send` to the user message.
    const messages: Message[] = [];
    for (const m of session.messages) {
      if (m.id === placeholderId) continue;
      if (m.id === userMessageId && m.role === "user") {
        messages.push({ ...m, badge: { kind: "failed-to-send" } });
      } else {
        messages.push(m);
      }
    }
    this.putSession({ ...session, messages, updatedAt: Date.now() }, {});
    this.pushBanner({
      severity: "error",
      text: `Request failed${err.status ? ` (${err.status})` : ""}: ${err.message ?? err.kind}`,
    });
  }

  // ---- State plumbing --------------------------------------------------

  private setState(next: AppState): void {
    this.state = next;
    for (const l of this.listeners) l(this.state);
  }

  private patch(next: Partial<AppState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l(this.state);
  }

  private renderTemplateVariables(input: string): string {
    const markdown = this.state.markdownPreview?.content ?? "";
    return input.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
      if (key === "markdown") return markdown;
      return match;
    });
  }
}

/** Remove "Skip to …" lines from plain-text fallback (article.textContent). */
function stripSkipLinks(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^skip\s+to\b/i.test(line.trim()))
    .join("\n")
    .trim();
}

function deriveTitle(firstMessage: string): string {
  const oneLine = firstMessage.replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_TITLE_LENGTH) return oneLine;
  return `${oneLine.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

function healthReason(err: ApiError | undefined): Exclude<
  ConnectionStatus,
  { kind: "unknown" } | { kind: "connecting" } | { kind: "healthy"; lastCheckedAt: number }
>["reason"] {
  if (!err) return "unknown";
  if (err.kind === "timeout") return "timeout";
  if (err.kind === "unauthorized" || err.kind === "forbidden")
    return "permission-denied";
  if (err.kind === "cors") return "cors";
  if (err.kind === "network") return "network";
  if (err.status) return "http-error";
  return "unknown";
}

function isRunsFallbackStatus(status: number): boolean {
  return status === 404 || status === 405;
}

function isRunsFallbackError(err: ApiError): boolean {
  if (err.kind === "not-found") return true;
  if (err.kind === "network" && err.message === "runs stream ended before content") {
    return true;
  }
  if (typeof err.status === "number" && isRunsFallbackStatus(err.status)) {
    return true;
  }
  return false;
}

function phaseFromRunStatus(status: string): SessionPhase | null {
  if (status === "queued") return "queued";
  if (status === "waiting_for_approval") return "waiting-approval";
  if (status === "running" || status === "started" || status === "stopping") {
    return "running";
  }
  return null;
}

function toApiErrorLike(e: unknown): ApiError {
  if (e && typeof e === "object") {
    const anyE = e as { name?: string; kind?: unknown; message?: string; status?: number };
    if (anyE.name === "AbortError") return { kind: "stopped" };
    if (typeof anyE.kind === "string") {
      return {
        kind: anyE.kind as ApiError["kind"],
        ...(typeof anyE.status === "number" ? { status: anyE.status } : {}),
        ...(typeof anyE.message === "string" ? { message: anyE.message } : {}),
      };
    }
    return { kind: "network", message: anyE.message ?? String(e) };
  }
  return { kind: "network", message: String(e) };
}
