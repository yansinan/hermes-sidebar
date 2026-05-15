import { useState } from "react";
import type { MarkdownPreviewState } from "../../shared/app-state";
import { Markdown } from "./Markdown";

interface Props {
  preview?: MarkdownPreviewState;
  onToggle: () => void;
  onRefresh: () => void;
  onInsertToken: () => void;
}

export function MarkdownPreviewPanel({
  preview,
  onToggle,
  onRefresh,
  onInsertToken,
}: Props) {
  const [rawMode, setRawMode] = useState(false);

  if (!preview) return null;

  const isCollapsed = preview.collapsed;
  const statusLabel =
    preview.status === "loading"
      ? "生成中"
      : preview.status === "error"
        ? "失败"
        : "已就绪";

  return (
    <section
      className={`markdown-preview ${isCollapsed ? "markdown-preview--collapsed" : ""}`}
      aria-label="Markdown preview"
    >
      <button
        type="button"
        className="markdown-preview__head"
        onClick={onToggle}
        aria-expanded={!isCollapsed}
      >
        <span className="markdown-preview__title">捕获的 Markdown</span>
        <span className="markdown-preview__meta">{statusLabel}</span>
      </button>

      {!isCollapsed && (
        <>
          <div className="markdown-preview__toolbar">
            <span className="markdown-preview__source" title={preview.sourceUrl || ""}>
              {preview.captureSource === "selection" ? "✂ 选中内容" : (preview.title || "Untitled")}
            </span>
            <div className="markdown-preview__actions">
              <button
                type="button"
                className={`markdown-preview__view-toggle${rawMode ? " markdown-preview__view-toggle--active" : ""}`}
                onClick={() => setRawMode(v => !v)}
                title={rawMode ? "切换为渲染视图" : "切换为源码视图"}
              >
                源码
              </button>
              <button type="button" onClick={onRefresh}>刷新</button>
              <button type="button" onClick={onInsertToken}>插入 {"{{markdown}}"}</button>
            </div>
          </div>

          <div className="markdown-preview__body">
            {preview.status === "loading" && (
              <p className="markdown-preview__status">正在自动生成 markdown...</p>
            )}
            {preview.status === "error" && (
              <p className="markdown-preview__status markdown-preview__status--error">
                {preview.error || "生成失败"}
              </p>
            )}
            {preview.status !== "loading" && preview.content && (
              rawMode
                ? <pre className="markdown-preview__raw">{preview.content}</pre>
                : <Markdown text={preview.content} />
            )}
          </div>
        </>
      )}
    </section>
  );
}
