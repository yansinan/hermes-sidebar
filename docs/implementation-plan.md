# 实现计划：用户选中文本提取 + 一句话摘要

## 功能概述

用户在网页上选中文本 → 右键菜单出现新选项 → 发送选中文本给 AI → 获取一句话摘要 → 显示在对话框上方作为"引用上下文"

---

## 实现步骤

### 第一步：在 manifest 中添加 content_scripts

**文件**: `manifest.config.ts`

```typescript
// 添加到 manifest 配置中
content_scripts: [
  {
    matches: ["<all_urls>"],
    js: ["src/content/content-script.ts"],
    run_at: "document_end",
  }
],

// 保证 permissions 包含
permissions: [
  "scripting",
  "storage",
  "tabs",
  "contextMenus",  // 已有
  "runtime",       // 已有
]
```

### 第二步：创建 content script

**文件**: `src/content/content-script.ts`（新建）

```typescript
/**
 * Content script injected into every web page
 * Detects user text selection and enables context menu
 */

// Listen for text selection on the page
document.addEventListener("selectionchange", () => {
  const selectedText = window.getSelection()?.toString().trim() || "";
  
  if (selectedText && selectedText.length > 0) {
    // Notify service worker that text is selected
    // This enables the context menu item
    chrome.runtime.sendMessage({
      type: "selection-available",
      text: selectedText,
    }).catch(() => {
      // Extension context might not be available
    });
  }
});

// Also handle right-click selection
document.addEventListener("contextmenu", () => {
  const selectedText = window.getSelection()?.toString().trim() || "";
  console.log("[ContentScript] Context menu on selection:", selectedText.slice(0, 50));
});
```

### 第三步：更新 service-worker

**文件**: `src/background/service-worker.ts`

在 `ensureContextMenu()` 函数中添加第二个菜单项：

```typescript
async function ensureContextMenu() {
  try {
    // 现有的页面提取菜单
    chrome.contextMenus.create({
      id: "hermes_extract_readability",
      title: "提取页面内容（Readability）",
      contexts: ["page"],
    });
    
    // 新增：选中文本摘要菜单
    chrome.contextMenus.create({
      id: "hermes_extract_selection",
      title: "用选中文本生成一句话摘要",
      contexts: ["selection"],  // 仅在有选中文本时显示
    });
  } catch (e) {
    console.error("[hermes-sidebar] contextMenus.create failed", e);
  }
}
```

在 `chrome.contextMenus.onClicked.addListener` 中添加处理：

```typescript
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // 现有处理：页面提取
  if (info.menuItemId === "hermes_extract_readability") {
    // ... existing code ...
  }
  
  // 新增处理：选中文本摘要
  else if (info.menuItemId === "hermes_extract_selection") {
    if (!info.selectionText) return;
    
    console.log("[hermes-sidebar] Context menu (selection) clicked");
    console.log("[hermes-sidebar] Selected text:", info.selectionText.slice(0, 100));
    
    await handleSelectionExtraction(info.selectionText, tab);
  }
});

/**
 * Handle extraction of selected text
 * Generate one-line quote/summary
 */
async function handleSelectionExtraction(selectedText: string, tab?: chrome.tabs.Tab) {
  const tabId = tab?.id;
  if (typeof tabId !== "number") return;

  console.log("[hermes-sidebar] Starting selection extraction workflow...");

  try {
    // Load settings
    const gateway = createStorageGateway();
    const settings = await gateway.loadSettings();

    // Build one-line summary prompt
    const userPrompt = buildSelectedTextQuotePrompt(selectedText);
    console.log("[hermes-sidebar] Built selection prompt, length:", userPrompt.length);

    // Ensure model ID
    const modelId = await ensureModelId(
      settings.apiKey,
      settings.apiBaseUrl,
      settings.defaultModelId
    );

    // Open side panel
    try {
      await (chrome.sidePanel as any).open?.({ tabId });
    } catch (err) {
      console.warn("[hermes-sidebar] Failed to open sidepanel", err);
    }

    // Create user message
    const now = Date.now();
    const userMessage: UserMessage = {
      id: shortId("um"),
      role: "user",
      content: userPrompt,
      createdAt: now,
      idempotencyKey: crypto.randomUUID?.() || `${now}-${Math.random()}`,
    };

    // Call API and get one-line summary
    console.log("[hermes-sidebar] Getting one-line summary from AI...");
    let quoteContent = "";
    try {
      quoteContent = await streamAiResponse(
        settings.apiKey,
        modelId,
        userPrompt
      );
      // Clean up: take first line only
      quoteContent = quoteContent.split("\n")[0].trim();
      console.log("[hermes-sidebar] Quote summary:", quoteContent);
    } catch (apiError) {
      console.error("[hermes-sidebar] Quote generation failed", apiError);
      quoteContent = `(摘要失败: ${apiError instanceof Error ? apiError.message : String(apiError)})`;
    }

    // Send selection quote to sidepanel
    // Special format: include full text + one-line summary
    console.log("[hermes-sidebar] Broadcasting selection-quote-result...");
    await chrome.runtime.sendMessage({
      type: "add-selection-quote-result",
      selectedText,  // Original selected text
      quoteSummary: quoteContent,  // One-line AI-generated summary
      timestamp: Date.now(),
    }).catch((err) => {
      console.error("[hermes-sidebar] Failed to send quote result", err);
    });

    console.log("[hermes-sidebar] ✓ Selection extraction workflow complete!");

  } catch (e) {
    console.error("[hermes-sidebar] Selection extraction failed", e);
    const errorMsg = e instanceof Error ? e.message : String(e);
    
    try {
      await chrome.runtime.sendMessage({
        type: "extraction-error",
        message: `选中文本摘要失败: ${errorMsg}`,
      });
    } catch (sendErr) {
      console.warn("[hermes-sidebar] Failed to send error", sendErr);
    }
  }
}
```

### 第四步：在 App.tsx 中处理新消息

**文件**: `src/sidepanel/App.tsx`

```typescript
// 在消息处理器中添加
else if (message?.type === "add-selection-quote-result") {
  console.log("[App] Processing selection quote...");
  const { selectedText, quoteSummary } = message;
  
  console.log("[App] Selected text:", selectedText.slice(0, 50), "...");
  console.log("[App] Quote summary:", quoteSummary);
  
  // Store the quote for display above composer
  // This will be shown as a reference context above the message input
  controller.setSelectionQuote({
    text: selectedText,
    summary: quoteSummary,
    timestamp: message.timestamp,
  });
  
  controller.setExtractionPhase("idle");
  sendResponse({ ok: true });
}
```

### 第五步：扩展 Controller 和 AppState

**文件**: `src/shared/app-state.ts`

```typescript
export interface SelectionQuote {
  text: string;           // Original selected text
  summary: string;        // One-line AI summary
  timestamp: number;      // When it was generated
}

export interface AppState {
  // ... existing fields ...
  selectionQuote?: SelectionQuote;  // Current quote context
}

export interface AppController {
  // ... existing methods ...
  setSelectionQuote(quote: SelectionQuote | undefined): void;
}
```

### 第六步：UI 组件 - 显示引用上下文

**文件**: `src/sidepanel/components/SelectionQuoteDisplay.tsx`（新建）

```typescript
import type { SelectionQuote } from "../../shared/app-state";

interface Props {
  quote?: SelectionQuote;
  onClear: () => void;
}

export function SelectionQuoteDisplay({ quote, onClear }: Props) {
  if (!quote) return null;

  return (
    <div style={{
      borderLeft: "3px solid #4f46e5",
      paddingLeft: "12px",
      marginBottom: "12px",
      color: "#666",
      fontSize: "13px",
    }}>
      <div style={{ fontWeight: 500, marginBottom: "4px" }}>引用</div>
      <div style={{ color: "#999", marginBottom: "6px" }}>
        {quote.text.slice(0, 100)}{quote.text.length > 100 ? "..." : ""}
      </div>
      <div style={{ marginBottom: "6px" }}>
        <strong>摘要:</strong> {quote.summary}
      </div>
      <button
        onClick={onClear}
        style={{
          fontSize: "12px",
          color: "#4f46e5",
          cursor: "pointer",
          border: "none",
          background: "none",
          textDecoration: "underline",
        }}
      >
        清除
      </button>
    </div>
  );
}
```

### 第七步：在 Composer 中集成

**文件**: `src/sidepanel/components/Composer.tsx`

```typescript
// 在 input 上方添加
<SelectionQuoteDisplay 
  quote={state.selectionQuote}
  onClear={() => controller.setSelectionQuote(undefined)}
/>
```

---

## 消息流总结

### 整页提取（已实现）
```
右键 → page context menu → service-worker
→ extractPageMainContent → buildPageBodySummaryPrompt
→ streamAiResponse → add-extraction-result
→ App.tsx → 添加到对话
```

### 选中文本提取（待实现）
```
选中文本 → content-script (enables context menu)
→ 右键 → selection context menu → service-worker
→ buildSelectedTextQuotePrompt → streamAiResponse
→ add-selection-quote-result → App.tsx
→ setSelectionQuote → UI 显示在 Composer 上方
```

---

## 环境变量和配置

需要在 `manifest.config.ts` 中调整的地方：

```typescript
export const manifest = {
  // ... existing ...
  
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/content-script.ts"],
      run_at: "document_end",
      all_frames: true,  // Run in all frames
    }
  ],
};
```

---

## 验证清单

完成后需要验证：
- [ ] 菜单项在有选中文本时出现
- [ ] 选中文本正确传递到 service-worker
- [ ] AI 摘要生成正确（一句话）
- [ ] 引用上下文显示在 Composer 上方
- [ ] 可以清除引用继续编写消息
- [ ] 支持多次选择/摘要

---

## 预期时间投入
- 第 1-3 步（manifest + content-script + service-worker）：30 分钟
- 第 4-5 步（App.tsx + controller）：20 分钟
- 第 6-7 步（UI 组件）：30 分钟
- 测试和调试：20 分钟

**总计**：约 2 小时
