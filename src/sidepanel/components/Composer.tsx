import { useRef } from "react";
import type { AppController, AppState } from "../../shared/app-state";

interface Props {
  state: AppState;
  controller: AppController;
}

export function Composer({ state, controller }: Props) {
  const { draftInput, settings, connectionStatus, models } = state;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const disabled =
    connectionStatus.kind === "failed" ||
    models.length === 0 ||
    draftInput.trim().length === 0;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && settings.enterBehavior === "send") {
      e.preventDefault();
      if (!disabled) void controller.send();
    }
  };

  const captionBits: string[] = [];
  if (settings.defaultModelId) captionBits.push(settings.defaultModelId);
  captionBits.push(
    settings.enterBehavior === "send"
      ? "Enter to send • Shift+Enter for newline"
      : "Ctrl+Enter to send",
  );

  return (
    <footer className="composer" aria-label="Compose message">
      <textarea
        ref={textareaRef}
        className="composer__input"
        placeholder="Ask Hermes anything…"
        value={draftInput}
        onChange={(e) => controller.setDraftInput(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        rows={2}
        aria-label="Message"
      />
      <div className="composer__row">
        <span className="composer__caption" aria-live="polite">
          {captionBits.join(" · ")}
        </span>
        <button
          type="button"
          className="composer__send"
          onClick={() => void controller.send()}
          disabled={disabled}
          aria-label="Send"
        >
          Send
        </button>
      </div>
    </footer>
  );
}
