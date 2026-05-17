import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppController, AppState, Banner } from "../../../shared/app-state";
import { MessageItem } from "./MessageItem";

interface Props {
  state: AppState;
  controller: AppController;
  onOpenSettings: () => void;
}

export function ConversationArea({ state, controller, onOpenSettings }: Props) {
  const { sessions, activeSessionId, banners, activeProfile, connectionStatus, models } =
    state;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const lastMessageCount = useRef<number>(activeSession?.messages.length ?? 0);

  // Track user scroll position to decide auto-scroll behavior (ui-spec §3.1).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setPinnedToBottom(atBottom);
      if (atBottom) setHasNewBelow(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeSessionId]);

  // After each render, if new content appeared: auto-scroll only when pinned.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const msgCount = activeSession?.messages.length ?? 0;
    const streamingContentChanged = activeSession?.messages.some(
      (m) => m.role === "assistant" && m.streaming,
    );
    if (pinnedToBottom) {
      el.scrollTop = el.scrollHeight;
      setHasNewBelow(false);
    } else if (
      msgCount !== lastMessageCount.current ||
      streamingContentChanged
    ) {
      setHasNewBelow(true);
    }
    lastMessageCount.current = msgCount;
  });

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setHasNewBelow(false);
    }
  };

  const connectionLost = connectionStatus.kind === "failed";
  const modelListEmpty =
    connectionStatus.kind === "healthy" && models.length === 0;

  return (
    <main
      className="conversation-area"
      aria-label="Conversation"
      ref={scrollRef}
    >
      <BannerStack
        banners={banners}
        onDismiss={(id) => controller.dismissBanner(id)}
      />

      {connectionLost && (
        <div className="banner banner--warning" role="status">
          <span className="banner__icon" aria-hidden>
            ⚠
          </span>
          <span className="banner__text">
            Can't reach {activeProfile.hostShort} right now. Your conversations
            are saved locally — you can keep reading them and resume sending
            once the connection is back.
          </span>
          <button
            type="button"
            className="banner__action"
            onClick={() => void controller.recheckHealth()}
          >
            Retry
          </button>
        </div>
      )}

      {modelListEmpty && (
        <div className="banner banner--warning" role="status">
          <span className="banner__icon" aria-hidden>
            ⚠
          </span>
          <span className="banner__text">
            No models available. Check that your Hermes server has at least one
            model configured.
          </span>
        </div>
      )}

      {activeSession === null ? (
        <EmptyState
          hostShort={activeProfile.hostShort}
          hasOtherSessions={sessions.length > 0}
          onFillPrompt={(prompt) => controller.setDraftInput(prompt)}
          onOpenSettings={onOpenSettings}
          isUnconfigured={connectionStatus.kind === "unknown"}
        />
      ) : (
        <ol
          className="message-list"
          aria-live="polite"
          aria-relevant="additions text"
        >
          {activeSession.messages.map((m) => (
            <MessageItem
              key={m.id}
              sessionId={activeSession.id}
              message={m}
              controller={controller}
            />
          ))}
        </ol>
      )}

      {hasNewBelow && (
        <button
          type="button"
          className="new-messages-pill"
          onClick={jumpToBottom}
          aria-label="Scroll to latest messages"
        >
          New messages ↓
        </button>
      )}
    </main>
  );
}

function BannerStack({
  banners,
  onDismiss,
}: {
  banners: Banner[];
  onDismiss: (id: string) => void;
}) {
  if (banners.length === 0) return null;
  // Stack at most two deep (ui-spec §3.5).
  const visible = banners.slice(0, 2);
  return (
    <div className="banner-stack">
      {visible.map((b) => (
        <div
          key={b.id}
          className={`banner banner--${b.severity}`}
          role={b.severity === "error" ? "alert" : "status"}
        >
          <span className="banner__icon" aria-hidden>
            {b.severity === "error" ? "✕" : b.severity === "warning" ? "⚠" : "ℹ"}
          </span>
          <span className="banner__text">{b.text}</span>
          {b.dismissable && (
            <button
              type="button"
              className="banner__close"
              onClick={() => onDismiss(b.id)}
              aria-label="Dismiss"
            >
              <span aria-hidden>×</span>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const EXAMPLE_PROMPTS: readonly string[] = [
  "Summarize this paragraph",
  "Explain this code",
  "Draft a reply to this email",
];

function EmptyState({
  hostShort,
  hasOtherSessions,
  onFillPrompt,
  onOpenSettings,
  isUnconfigured,
}: {
  hostShort: string;
  hasOtherSessions: boolean;
  onFillPrompt: (prompt: string) => void;
  onOpenSettings: () => void;
  isUnconfigured: boolean;
}) {
  return (
    <section className="empty-state">
      <h1 className="empty-state__title">Welcome to hermes-sidebar</h1>
      {isUnconfigured ? (
        <>
          <p className="empty-state__lead">
            You're not connected to a Hermes Agent yet. The default is{" "}
            <code>http://127.0.0.1:8642</code> — change it in settings to point
            at a remote Hermes.
          </p>
          <div className="empty-state__actions">
            <button
              type="button"
              className="primary-button"
              onClick={onOpenSettings}
            >
              Test connection
            </button>
          </div>
        </>
      ) : hasOtherSessions ? (
        <p className="empty-state__lead">
          New conversation with <code>{hostShort}</code>. Ask something below,
          or pick a session from the drawer.
        </p>
      ) : (
        <p className="empty-state__lead">
          No conversations yet for <code>{hostShort}</code>. Start one below.
        </p>
      )}

      <ul className="empty-state__examples" aria-label="Example prompts">
        {EXAMPLE_PROMPTS.map((p) => (
          <li key={p}>
            <button
              type="button"
              onClick={() => onFillPrompt(p)}
              aria-label={`Fill prompt: ${p}`}
            >
              {p}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
