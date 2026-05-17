import { useEffect, useState } from "react";
import type { AppController } from "../shared/types";
import { TopBar } from "./components/topbar/TopBar";
import { ConversationArea } from "./components/conversation/ConversationArea";
import { Composer } from "./components/composer/Composer";
import { MarkdownPreviewPanel } from "./components/composer/MarkdownPreviewPanel";
import { QuickActionBar } from "./components/composer/QuickActionBar";
import { SessionDrawer } from "./components/overlay/SessionDrawer";
import { SettingsDrawer } from "./components/overlay/SettingsDrawer";
import { buildSelectionSummaryDraft, buildPageBodySummaryDraft } from "../runtime";
import { useAppState } from "./useAppState";

interface Props {
  controller: AppController;
}

type OpenOverlay = "none" | "sessions" | "settings";

export function App({ controller }: Props) {
  const state = useAppState(controller);
  const [overlay, setOverlay] = useState<OpenOverlay>("none");
  const [extractionStatusText, setExtractionStatusText] = useState<string>("");

  const openSessions = () => setOverlay("sessions");
  const openSettings = () => setOverlay("settings");
  const closeOverlay = () => setOverlay("none");

  // 快速动作：生成选区总结草稿
  const handleSummarizeSelection = async () => {
    const nextDraft = await buildSelectionSummaryDraft(state.draftInput);
    controller.setDraftInput(nextDraft);
  };

  // 快速动作：生成页面正文总结草稿（复用右键“总结”模板）
  const handleSummarizePageBody = async () => {
    const nextDraft = await buildPageBodySummaryDraft(state.draftInput, {
      summaryTemplate: state.settings.contextMenuPrompts.summary,
    });
    controller.setDraftInput(nextDraft);
  };

  /**
   * Listen for messages from service-worker
   * 
   * Message types:
   *   - "extraction-start": User triggered extraction, show loading UI
   *   - "extraction-processing": API is being called, show processing UI
   *   - "add-extraction-result": Service-worker completed, add messages to conversation
   *   - "extraction-error": Something failed, show error and reset UI
   *   - "open-with-draft": Service-worker prepared a draft message for user (future use)
   * 
   * This listener stays active for the lifetime of the sidepanel and handles
   * all communication from the background service worker.
   */
  useEffect(() => {
    const handler = (message: any, sender: any, sendResponse: (response?: any) => void) => {
      console.log("[App] Received message from service-worker:", message?.type, message);
      
      // ===== extraction-start: User clicked right-click menu =====
      if (message?.type === "extraction-start") {
        console.log("[App] Extraction starting, showing loading spinner...");
        controller.setExtractionPhase("extracting");
        setExtractionStatusText("提取页面内容中...");
        sendResponse({ ok: true });
      } 
      
      // ===== extraction-processing: API call in progress (reserved for future use) =====
      else if (message?.type === "extraction-processing") {
        console.log("[App] Now processing with AI...");
        controller.setExtractionPhase("processing");
        if (typeof message.statusText === "string" && message.statusText.trim()) {
          setExtractionStatusText(message.statusText.trim());
        } else {
          setExtractionStatusText("处理中...");
        }
        sendResponse({ ok: true });
      } 
      
      // ===== open-with-draft: (reserved) Prepare draft message =====
      else if (message?.type === "open-with-draft" && typeof message.draft === "string") {
        console.log("[App] Draft prepared, filling composer input...");
        controller.setDraftInput(message.draft);
        sendResponse({ ok: true });
      } 
      
      // ===== add-extraction-result: Complete! Add messages to conversation =====
      else if (message?.type === "add-extraction-result") {
        console.log("[App] Extraction complete, adding results to conversation...");
        const { userMessage, assistantMessage } = message;
        if (userMessage && assistantMessage) {
          console.log("[App] User message preview:", userMessage?.content?.slice?.(0, 50), "...");
          console.log("[App] Assistant message preview:", assistantMessage?.content?.slice?.(0, 50), "...");
          
          // Add both messages to the active conversation asynchronously
          void controller.addExtractionResult(userMessage, assistantMessage).then(() => {
            console.log("[App] ✓ Extraction result added successfully, resetting UI...");
            controller.setExtractionPhase("idle");
            setExtractionStatusText("");
            sendResponse({ ok: true });
          });
          return true; // Tell Chrome we will respond asynchronously
        }
        
        console.warn("[App] Missing userMessage or assistantMessage in payload");
        sendResponse({ ok: false, reason: "Missing messages" });
      } 
      
      // ===== extraction-error: Something went wrong =====
      else if (message?.type === "extraction-error") {
        console.error("[App] Extraction error:", message.message);
        controller.setExtractionPhase("idle"); // Reset loading UI
        setExtractionStatusText("");
        sendResponse({ ok: true });
      }

      // ===== page-selection-changed: user selected text on the active tab =====
      else if (message?.type === "page-selection-changed") {
        // sender.tab.id is set for injected content scripts; use sourceTabId as fallback.
        const tabId: number =
          sender?.tab?.id ??
          controller.getState().markdownPreview?.sourceTabId ??
          0;
        if (typeof message.markdown === "string" && message.markdown.trim()) {
          // Pre-converted by the in-page watcher — no extra executeScript needed.
          void controller.captureSelectionMarkdown("", tabId, message.markdown);
        } else if (typeof message.html === "string" && message.html.trim()) {
          void controller.captureSelectionMarkdown(message.html, tabId);
        }
        sendResponse({ ok: true });
      }

      // ===== page-selection-cleared: user deselected text =====
      else if (message?.type === "page-selection-cleared") {
        controller.revertToPageCapture();
        sendResponse({ ok: true });
      }
      
      return true; // Keep handler for async processing
    };
    
    try {
      chrome.runtime.onMessage.addListener(handler);
    } catch {
      // non-browser/test environments don't have chrome.runtime
    }
    
    // Cleanup: Remove listener when component unmounts
    return () => {
      try {
        chrome.runtime.onMessage.removeListener(handler);
      } catch {
        // noop
      }
    };
  }, [controller]);

  useEffect(() => {
    void controller.refreshMarkdownPreview();

    const tabsApi = (globalThis as { chrome?: typeof chrome }).chrome?.tabs;
    if (!tabsApi?.onUpdated || !tabsApi?.onActivated) return;

    let lastRefreshAt = 0;
    const refreshWithThrottle = () => {
      const now = Date.now();
      if (now - lastRefreshAt < 800) return;
      lastRefreshAt = now;
      void controller.refreshMarkdownPreview();
    };

    const onUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (changeInfo.status === "complete" && tab.active) refreshWithThrottle();
    };
    const onActivated = () => refreshWithThrottle();

    tabsApi.onUpdated.addListener(onUpdated);
    tabsApi.onActivated.addListener(onActivated);

    return () => {
      tabsApi.onUpdated.removeListener(onUpdated);
      tabsApi.onActivated.removeListener(onActivated);
    };
  }, [controller]);

  return (
    <div className="app-shell">
      {/* 顶部导航分支：状态、模型、会话入口 */}
      <TopBar
        state={state}
        controller={controller}
        onOpenSessions={openSessions}
        onOpenSettings={openSettings}
      />
      {/* 对话展示分支：消息流、Banner、空状态 */}
      <ConversationArea
        state={state}
        controller={controller}
        onOpenSettings={openSettings}
      />
      {state.extractionPhase && state.extractionPhase !== "idle" && (
        <div style={{
          padding: "8px 12px",
          backgroundColor: "#f0f8ff",
          borderTop: "1px solid #d0e8ff",
          fontSize: "12px",
          color: "#0066cc",
          textAlign: "center",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "8px",
        }}>
          <div style={{
            width: "12px",
            height: "12px",
            border: "2px solid #0066cc",
            borderTop: "2px solid transparent",
            borderRadius: "50%",
            animation: "spin 0.8s linear infinite",
          }} />
          {extractionStatusText || (state.extractionPhase === "extracting" ? "提取页面内容中..." : "处理中...")}
        </div>
      )}
      {/* 输入分支：预览面板 + 快速动作 + 输入框 */}
      <div className="composer-stack">
        <MarkdownPreviewPanel
          preview={state.markdownPreview}
          onToggle={() => controller.toggleMarkdownPreview()}
          onRefresh={() => void controller.refreshMarkdownPreview()}
          onInsertToken={() => controller.insertMarkdownTokenAtCaret("{{markdown}}")}
        />
        {/* 快速动作栏：选区总结、正文总结（现已独立于 Composer，基于全局 draft） */}
        <QuickActionBar
          onSummarizeSelection={() => void handleSummarizeSelection()}
          onSummarizePageBody={() => void handleSummarizePageBody()}
        />
        <Composer state={state} controller={controller} />
      </div>

      {/* 弹层分支：会话管理与设置 */}
      {overlay === "sessions" && (
        <SessionDrawer
          state={state}
          controller={controller}
          onClose={closeOverlay}
        />
      )}
      {overlay === "settings" && (
        <SettingsDrawer
          state={state}
          controller={controller}
          onClose={closeOverlay}
        />
      )}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
