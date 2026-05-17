import type { AppController } from "../../../shared/app-state";
import type { AssistantMessage, Message, UserMessage } from "../../../shared/types/message";
import { Markdown } from "../shared/Markdown";
import { ToolProgressBlock } from "./ToolProgressBlock";

interface Props {
  sessionId: string;
  message: Message;
  controller: AppController;
}

export function MessageItem({ sessionId, message, controller }: Props) {
  const role = message.role;
  const roleLabel = role === "user" ? "You" : role === "assistant" ? "Hermes" : "System";

  return (
    <li className={`message message--${role}`}>
      <div className="message__role" aria-hidden>
        {roleLabel}
      </div>

      {role === "assistant" ? (
        <AssistantBody
          sessionId={sessionId}
          message={message as AssistantMessage}
          controller={controller}
        />
      ) : role === "user" ? (
        <UserBody
          sessionId={sessionId}
          message={message as UserMessage}
          controller={controller}
        />
      ) : (
        <div className="message__content">{message.content}</div>
      )}
    </li>
  );
}

function UserBody({
  sessionId,
  message,
  controller,
}: {
  sessionId: string;
  message: UserMessage;
  controller: AppController;
}) {
  const failed = message.badge?.kind === "failed-to-send";
  return (
    <div
      className="message__content message__content--user"
      aria-label={failed ? "Your message, failed to send" : "Your message"}
    >
      <Markdown text={message.content} />
      {failed && (
        <div className="message__footer">
          <span className="badge badge--error" role="status">
            Failed to send
          </span>
          <button
            type="button"
            className="badge-action"
            onClick={() => void controller.retry(sessionId, message.id)}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function AssistantBody({
  sessionId,
  message,
  controller,
}: {
  sessionId: string;
  message: AssistantMessage;
  controller: AppController;
}) {
  const badge = message.badge;
  const ariaLabel = badge
    ? `Hermes message, ${badge.kind === "stopped" ? "stopped" : "connection interrupted"}`
    : message.streaming
      ? "Hermes is responding"
      : "Hermes message";

  return (
    <div className="message__content message__content--assistant" aria-label={ariaLabel}>
      {message.toolProgress && message.toolProgress.length > 0 && (
        <ToolProgressBlock entries={message.toolProgress} />
      )}
      {message.content.length === 0 && message.streaming ? (
        <div className="message__placeholder" aria-live="polite">
          Hermes is responding<span className="md-caret" aria-hidden />
        </div>
      ) : (
        <Markdown text={message.content} streaming={message.streaming} />
      )}
      {badge && (
        <div className="message__footer">
          {badge.kind === "stopped" && (
            <span className="badge badge--muted" role="status">
              Stopped
            </span>
          )}
          {badge.kind === "connection-interrupted" && (
            <>
              <span className="badge badge--warning" role="status">
                Connection interrupted
              </span>
              <button
                type="button"
                className="badge-action"
                onClick={() =>
                  void controller.continueInterrupted(sessionId, message.id)
                }
              >
                Continue
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
