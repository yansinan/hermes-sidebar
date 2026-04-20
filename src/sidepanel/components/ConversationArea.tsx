import type { AppState } from "../../shared/app-state";

interface Props {
  state: AppState;
}

export function ConversationArea({ state }: Props) {
  const { sessions, activeSessionId, banners, activeProfile } = state;
  const activeSession =
    sessions.find((s) => s.id === activeSessionId) ?? null;

  return (
    <main className="conversation-area" aria-label="Conversation">
      {banners.length > 0 && (
        <div className="banner-stack" role="status" aria-live="polite">
          {banners.slice(0, 2).map((b) => (
            <div
              key={b.id}
              className={`banner banner--${b.severity}`}
              role="note"
            >
              <span className="banner__text">{b.text}</span>
            </div>
          ))}
        </div>
      )}

      {activeSession === null ? (
        <EmptyState hostShort={activeProfile.hostShort} />
      ) : (
        <ol className="message-list">
          {activeSession.messages.map((m) => (
            <li
              key={m.id}
              className={`message message--${m.role}`}
              aria-label={`${m.role === "user" ? "You" : "Hermes"} message`}
            >
              <div className="message__role">
                {m.role === "user" ? "You" : "Hermes"}
              </div>
              <div className="message__content">{m.content}</div>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}

function EmptyState({ hostShort }: { hostShort: string }) {
  return (
    <section className="empty-state">
      <h1 className="empty-state__title">Welcome to hermes-sidebar</h1>
      <p className="empty-state__lead">
        This side panel will talk to your Hermes Agent API server at{" "}
        <code>{hostShort}</code>.
      </p>
      <p className="empty-state__note">
        The chat runtime is not wired up yet — this build is the shared
        scaffold. Future work will land the session manager, API client,
        streaming, and settings drawer.
      </p>
      <ul className="empty-state__examples" aria-label="Example prompts">
        <li>
          <button type="button" disabled>
            Summarize this paragraph
          </button>
        </li>
        <li>
          <button type="button" disabled>
            Explain this code
          </button>
        </li>
        <li>
          <button type="button" disabled>
            Draft a reply to this email
          </button>
        </li>
      </ul>
    </section>
  );
}
