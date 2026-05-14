import { useEffect, useRef, useState } from "react";
import type { AppController, AppState } from "../../shared/app-state";
import { buildSummaryDraft } from "../../runtime/summary-action";
import { buildPageBodySummaryDraft } from "../../runtime/page-body-summary-action";
import { QuickActionBar } from "./QuickActionBar";

interface Props {
  state: AppState;
  controller: AppController;
}

export function Composer({ state, controller }: Props) {
  const {
    draftInput,
    settings,
    connectionStatus,
    models,
    activeSessionId,
    sessionPhases,
  } = state;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [composing, setComposing] = useState(false);

  const activePhase = activeSessionId ? sessionPhases[activeSessionId] : undefined;
  const isStreaming = activePhase === "streaming";

  const connectionFailed = connectionStatus.kind === "failed";
  const noModels = models.length === 0;
  const inputDisabled = connectionFailed || noModels;
  const canSend = !inputDisabled && !composing && draftInput.trim().length > 0;

  // Autosize textarea up to the CSS max-height cap.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draftInput]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const selection = state.composerSelection;
    if (!selection) return;
    if (document.activeElement !== el) return;
    const start = Math.min(selection.start, draftInput.length);
    const end = Math.min(selection.end, draftInput.length);
    requestAnimationFrame(() => {
      try {
        el.setSelectionRange(start, end);
      } catch {
        // noop in environments where selection APIs are restricted
      }
    });
  }, [draftInput, state.composerSelection]);

  const onSend = () => {
    if (!canSend) return;
    void controller.send();
  };

  // Phase 1A: selection-aware quick summary. It keeps the original quick
  // action lightweight and only adds current-tab metadata plus selection.
  const onSummarizeSelection = async () => {
    const nextDraft = await buildSummaryDraft(draftInput);
    controller.setDraftInput(nextDraft);
  };

  // Phase 1B: page-body summary. This lives beside the quick summary button so
  // tomorrow we can test both paths independently.
  const onSummarizePageBody = async () => {
    const nextDraft = await buildPageBodySummaryDraft(draftInput);
    controller.setDraftInput(nextDraft);
  };

  const onStop = () => {
    if (!activeSessionId) return;
    controller.stop(activeSessionId);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing || e.nativeEvent.isComposing) return;

    if (e.key === "Enter") {
      const shouldSend =
        (settings.enterBehavior === "send" && !e.shiftKey) ||
        (settings.enterBehavior === "newline" && e.shiftKey);
      if (shouldSend) {
        e.preventDefault();
        onSend();
      }
    } else if (e.key === "Escape" && isStreaming) {
      e.preventDefault();
      onStop();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Strip HTML — always paste as plain text (ui-spec §4.5).
    const plain = e.clipboardData.getData("text/plain");
    if (plain) {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const next =
        draftInput.slice(0, start) + plain + draftInput.slice(end);
      controller.setDraftInput(next);
      requestAnimationFrame(() => {
        const caret = start + plain.length;
        el.setSelectionRange(caret, caret);
      });
    }
  };

  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      controller.setDraftInput(
        draftInput + (draftInput && !draftInput.endsWith("\n") ? "\n" : "") +
          "(Attachments are not supported yet.)",
      );
    }
  };

  const syncSelection = (el: HTMLTextAreaElement) => {
    controller.setComposerSelection(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  };

  // Placeholder stays constant; the disabled reason is surfaced via tooltip/title
  // per ui-spec §4.1 ("shows the same placeholder" + tooltip explains blocker).
  const disabledReason = connectionFailed
    ? `Connection to ${state.activeProfile.hostShort} failed — open settings to retry`
    : noModels
      ? "No models available on this Hermes endpoint"
      : undefined;
  const placeholder = "Ask Hermes anything…";

  const modelId =
    (activeSessionId &&
      state.sessions.find((s) => s.id === activeSessionId)?.modelId) ||
    settings.defaultModelId ||
    models[0]?.id ||
    "—";
  const charCount = draftInput.length;

  const keyShortcut =
    settings.enterBehavior === "send"
      ? "Enter"
      : "Shift+Enter";

  return (
    <footer className="composer" aria-label="Compose message">
      <QuickActionBar
        onSummarizeSelection={() => void onSummarizeSelection()}
        onSummarizePageBody={() => void onSummarizePageBody()}
      />
      <textarea
        ref={textareaRef}
        className="composer__input"
        placeholder={placeholder}
        value={draftInput}
        onChange={(e) => controller.setDraftInput(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={onDrop}
        onSelect={(e) => syncSelection(e.currentTarget)}
        onClick={(e) => syncSelection(e.currentTarget)}
        onKeyUp={(e) => syncSelection(e.currentTarget)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        rows={2}
        aria-label="Message"
        aria-keyshortcuts={keyShortcut}
        aria-disabled={inputDisabled ? "true" : undefined}
        disabled={inputDisabled}
        title={disabledReason}
      />
      <div className="composer__row">
        <span className="composer__caption" aria-live="polite">
          Model: <span className="composer__caption-model">{modelId}</span>
          {" · "}
          {charCount} chars
        </span>
        {isStreaming ? (
          <button
            type="button"
            className="composer__stop"
            onClick={onStop}
            aria-label="Stop streaming"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="composer__send"
            onClick={onSend}
            disabled={!canSend}
            aria-label="Send"
          >
            Send
          </button>
        )}
      </div>
    </footer>
  );
}
