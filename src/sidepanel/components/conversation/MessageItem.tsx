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
  const roleLabel = role === "user" ? "You" : role === "assistant" ? "Hermes" : "Activity";

  return (
    <li className={`message message--${role}`}>
      {role !== "system" ? (
        <div className="message__role" aria-hidden>
          {roleLabel}
        </div>
      ) : null}

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
        <SystemBody content={message.content} />
      )}
    </li>
  );
}

function SystemBody({ content }: { content: string }) {
  const match = content.match(/^(\d{2}:\d{2}:\d{2})\s+(.*)$/s);
  const time = match?.[1] ?? "";
  const text = match?.[2] ?? content;

  return (
    <div className="message__activity" aria-label="Activity event">
      {time ? <span className="message__activity-time">{time}</span> : null}
      <span className="message__activity-dot" aria-hidden />
      <span className="message__activity-text">{text}</span>
    </div>
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
      <div className="message__meta" aria-label="Assistant transport metadata">
        {formatAssistantMeta(message)}
      </div>
    </div>
  );
}

function formatAssistantMeta(message: AssistantMessage): string {
  const d = new Date(message.createdAt);
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const ts = `${yy}/${mm}/${dd} ${hh}:${min}`;
  if (message.responseChannel) {
    return `${ts} from ${message.responseChannel}`;
  }
  return `${ts} trying ${message.responseChannelTrying ?? "chat/run"}`;
}
