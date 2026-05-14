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
} from "../shared/app-state";
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from "../shared/message";
import type {
  ConnectionProfile,
  ConnectionStatus,
  ProfileKey,
} from "../shared/profile";
import type { Session, SessionPhase } from "../shared/session";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import { shortId, uuid } from "../shared/ids";

import {
  HermesApiClient,
  toWireMessages,
  type ChatCompletionsRequest,
} from "../api/client";
import type { ApiError } from "../api/errors";
import { consumeChatStream } from "../api/stream";
import type { ToolProgressEntry } from "../shared/tool-progress";

import {
  createStorageGateway,
  type StorageGateway,
} from "../storage/gateway";
import { normalizeBaseUrl, toProfile } from "./profile";
import { extractPageMainContent } from "../shared/page-extractor";
import { htmlToMarkdown } from "../shared/markdown-converter";

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
    if (record.activeSessionId &&
        record.sessions.some((s) => s.id === record.activeSessionId)) {
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
    console.log("[Controller] selectModel called with:", modelId);
    const settings = { ...this.state.settings, defaultModelId: modelId };
    console.log("[Controller] Updated settings:", settings);
    this.patch({ settings });
    console.log("[Controller] State patched, saving to storage...");
    void this.gateway.saveSettings(settings).then(() => {
      console.log("[Controller] Settings saved to storage");
    });
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
  ): Promise<void> {
    const now = Date.now();
    let session = this.activeSession();
    
    if (!session) {
      // Create a new session with the user message as first message
      session = this.promoteDraft(userMessage.content, assistantMessage.modelId, now);
    }

    const modelId = assistantMessage.modelId || this.currentModelId() || session.modelId;
    
    // Add both user and assistant messages to the session
    const updatedSession: Session = {
      ...session,
      updatedAt: now,
      modelId,
      messages: [...session.messages, userMessage, assistantMessage],
    };
    
    this.putSession(updatedSession, { makeActive: true });
    this.patch({ extractionPhase: "idle" });
    await this.persist();
  }

  setExtractionPhase(phase?: "idle" | "extracting" | "processing"): void {
    this.patch({ extractionPhase: phase });
  }

  async refreshMarkdownPreview(): Promise<void> {
    const tabsApi = (globalThis as { chrome?: typeof chrome }).chrome?.tabs;
    if (!tabsApi?.query) return;

    const current = this.state.markdownPreview ?? {
      content: "",
      collapsed: true,
      status: "idle" as const,
    };
    this.patch({
      markdownPreview: {
        ...current,
        status: "loading",
        error: undefined,
      },
    });

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

      const parsed = await extractPageMainContent(tabId, { useReadability: true });
      const markdown =
        htmlToMarkdown(parsed.html ?? parsed.content ?? "") ||
        (parsed.text ?? "").trim();

      this.patch({
        markdownPreview: {
          content: markdown,
          title: parsed.title ?? tab?.title ?? "Untitled",
          sourceUrl: tab?.url,
          sourceTabId: tabId,
          collapsed: current.collapsed ?? true,
          status: markdown ? "ready" : "error",
          ...(markdown
            ? { updatedAt: Date.now(), error: undefined }
            : { error: parsed.error ?? "Markdown extraction returned empty content" }),
        },
      });
    } catch (error) {
      this.patch({
        markdownPreview: {
          ...current,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      });
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

    const apiKey = this.state.settings.apiKey || undefined;
    const streaming = this.state.settings.streamingEnabled;
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
        });
      } catch {
        // best effort only
      }
    };

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    try {
      if (!streaming) {
        const done = await this.api.completeOnce(req);
        this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
          content: done.content,
          outcome: "ok",
          ...(done.serverSessionRef ? { serverSessionRef: done.serverSessionRef } : {}),
        });
        await this.persist();
        return;
      }

      let firstActivitySeen = false;
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
      const res = await this.api.openChatStream(req);
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
            streamedContent += delta;
            this.appendStreamDelta(sessionId, assistantMessage.id, delta);
          },
          onThinkingDelta: () => {
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
              p.status === "started"
                ? `工具 ${p.tool} 调用中`
                : `工具 ${p.tool} 已完成`,
            );
          },
          onServerSessionRef: (ref) => this.attachServerSessionRef(sessionId, ref),
          onEnd: (outcome) => {
            clearInterval(heartbeatTimer);
            if (outcome.kind === "ok") {
              this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
                content: streamedContent,
                outcome: "ok",
              });
            } else if (outcome.kind === "stopped") {
              this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
                content: streamedContent,
                outcome: "stopped",
              });
            } else if (outcome.kind === "interrupted") {
              this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
                content: streamedContent,
                outcome: "interrupted",
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
      if (err.kind === "stopped") {
        // Aborted by user; the stream handler also signals this path in the
        // streaming case. Finalize as stopped.
        this.finalizeStreamingMessage(sessionId, assistantMessage.id, {
          content: "",
          outcome: "stopped",
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

  private applyToolProgress(
    prev: ToolProgressEntry[],
    payload: { tool: string; status: "started" | "finished"; callId?: string },
  ): ToolProgressEntry[] {
    if (payload.status === "started") {
      const entry: ToolProgressEntry = {
        id: payload.callId ?? shortId("tp"),
        toolName: payload.tool,
        phase: "start",
        statusText: `Calling tool ${payload.tool}…`,
        startedAt: Date.now(),
      };
      return [...prev, entry];
    }
    // finished
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

  private attachServerSessionRef(sessionId: string, ref: string): void {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session || session.serverSessionRef === ref) return;
    this.putSession({ ...session, serverSessionRef: ref }, {});
  }

  private finalizeStreamingMessage(
    sessionId: string,
    messageId: string,
    opts: {
      content: string;
      outcome: "ok" | "stopped" | "interrupted";
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
      };
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
