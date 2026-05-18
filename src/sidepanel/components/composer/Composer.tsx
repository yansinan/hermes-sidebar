import { useEffect, useRef, useState } from "react";
import type { AppController, AppState } from "../../../shared/app-state";

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
  // 本地输入内容
  const [localDraft, setLocalDraft] = useState("");

  // 跟随全局 draftInput 初始化和外部变化
  useEffect(() => {
    setLocalDraft(draftInput);
  }, [draftInput]);

  const activePhase = activeSessionId ? sessionPhases[activeSessionId] : undefined;
  const isStreaming = activePhase === "streaming";

  const connectionFailed = connectionStatus.kind === "failed";
  const noModels = models.length === 0;
  const inputDisabled = connectionFailed || noModels;
  const canSend = !inputDisabled && !composing && localDraft.trim().length > 0;

  // Textarea 自动高度调整，不超过 CSS 设定的最大高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [localDraft]);

  // 发送时同步本地内容到全局
  const syncDraftToGlobal = () => {
    if (localDraft !== draftInput) {
      controller.setDraftInput(localDraft);
    }
  };

  const syncSelectionToGlobal = (el: HTMLTextAreaElement) => {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    controller.setComposerSelection(start, end);
  };

  const onSend = () => {
    if (!canSend) return;
    syncDraftToGlobal();
    void controller.send();
    setLocalDraft("");
  };

  const onStop = () => {
    if (!activeSessionId) return;
    controller.stop(activeSessionId);
  };

  // 快捷键处理：Enter 发送，Ctrl+Enter/Shift+Enter 换行，Escape 停止流
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing || e.nativeEvent.isComposing) return;

    // Enter 发送消息（不带 Ctrl/Shift/Meta）
    if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      onSend();
    }
    // Ctrl+Enter（或 Cmd+Enter 在 Mac）或 Shift+Enter 插入换行
    else if ((e.ctrlKey || e.metaKey || e.shiftKey) && e.key === "Enter") {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const next = localDraft.slice(0, start) + "\n" + localDraft.slice(end);
      setLocalDraft(next);
      // 异步更新光标位置
      setTimeout(() => {
        el.selectionStart = el.selectionEnd = start + 1;
        el.focus();
      }, 0);
    }
    // Escape 在流式响应时停止
    else if (e.key === "Escape" && isStreaming) {
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
        localDraft.slice(0, start) + plain + localDraft.slice(end);
      setLocalDraft(next);
      requestAnimationFrame(() => {
        const caret = start + plain.length;
        el.setSelectionRange(caret, caret);
      });
    }
  };

  // 拖拽上传暂不支持，onDrop 已注释
  // const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
  //   if (e.dataTransfer.types.includes("Files")) {
  //     e.preventDefault();
  //     const next =
  //       localDraft + (localDraft && !localDraft.endsWith("\n") ? "\n" : "") +
  //       "(Attachments are not supported yet.)";
  //     setLocalDraft(next);
  //     controller.setDraftInput(next);
  //   }
  // };

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
  const charCount = localDraft.length;
  const keyShortcut = "Enter";

  return (
    <footer className="composer" aria-label="Compose message">
      <textarea
        ref={textareaRef}
        className="composer__input"
        placeholder={placeholder}
        value={localDraft}
        onChange={(e) => {
          const next = e.currentTarget.value;
          setLocalDraft(next);
          controller.setDraftInput(next);
          syncSelectionToGlobal(e.currentTarget);
        }}
        onSelect={(e) => syncSelectionToGlobal(e.currentTarget)}
        onKeyUp={(e) => syncSelectionToGlobal(e.currentTarget)}
        onBlur={syncDraftToGlobal}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        // onDrop 暂注释，待后续恢复或删除
        // onDrop={onDrop}
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
