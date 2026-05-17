/// <reference types="chrome" />

import { extractPageMainContent } from "../shared/extractPageMainContent";
import { HermesApiClient, toWireMessages } from "../api/client";
import { consumeChatStream } from "../api/stream";
import { createStorageGateway } from "../storage/gateway";
import { shortId } from "../shared/utils/ids";
import type { AssistantMessage, UserMessage } from "../shared/types/message";
import {
  DEFAULT_CUSTOM_MENU_PROMPT_TEMPLATE,
  DEFAULT_SETTINGS,
  approxCharsToTokens,
  approxTokensToChars,
  type CustomContextMenuItem,
  type Settings,
} from "../shared/types/settings";
import { buildPromptFromTemplate } from "../shared/domain";

const MAX_LLM_WIKI_PROMPT_TOKENS = 80_000;
const CUSTOM_MENU_ID_PREFIX = "hermes_custom_";

function ts(): string {
  return new Date().toISOString();
}

function logInfo(message: string, ...args: unknown[]): void {
  console.log(`[${ts()}] [hermes-sidebar] ${message}`, ...args);
}

function logWarn(message: string, ...args: unknown[]): void {
  console.warn(`[${ts()}] [hermes-sidebar] ${message}`, ...args);
}

function logError(message: string, ...args: unknown[]): void {
  console.error(`[${ts()}] [hermes-sidebar] ${message}`, ...args);
}

function safeMenuId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function customMenuRuntimeId(id: string): string {
  return `${CUSTOM_MENU_ID_PREFIX}${safeMenuId(id)}`;
}

function getPromptTemplates(settings: Settings) {
  return {
    summary:
      settings.contextMenuPrompts?.summary ||
      DEFAULT_SETTINGS.contextMenuPrompts.summary,
    llmWikiSelection:
      settings.contextMenuPrompts?.llmWikiSelection ||
      DEFAULT_SETTINGS.contextMenuPrompts.llmWikiSelection,
    llmWikiPage:
      settings.contextMenuPrompts?.llmWikiPage ||
      DEFAULT_SETTINGS.contextMenuPrompts.llmWikiPage,
  };
}

function validateLlmWikiPromptLength(params: {
  settings: Settings;
  domHtml: string;
  prompt: string;
  modeLabel: string;
}): { ok: true } | { ok: false; reason: string } {
  const domLimitTokens = Math.max(
    1,
    Math.floor(
      Number.isFinite(params.settings.maxDomInputTokens)
        ? params.settings.maxDomInputTokens
        : DEFAULT_SETTINGS.maxDomInputTokens,
    ),
  );
  const domLimitCharsApprox = approxTokensToChars(domLimitTokens);
  const domTokens = approxCharsToTokens(params.domHtml.length);
  const promptTokens = approxCharsToTokens(params.prompt.length);

  if (!params.domHtml.trim()) {
    return {
      ok: false,
      reason: `${params.modeLabel}：未提取到DOM主体内容，已阻止发送（纯文本不会发送给Agent）`,
    };
  }
  if (domTokens > domLimitTokens) {
    return {
      ok: false,
      reason: `${params.modeLabel}：DOM 约 ${domTokens} tokens，超过上限 ${domLimitTokens} tokens（约 ${domLimitCharsApprox} chars），已阻止发送`,
    };
  }
  if (promptTokens > MAX_LLM_WIKI_PROMPT_TOKENS) {
    return {
      ok: false,
      reason: `${params.modeLabel}：请求约 ${promptTokens} tokens，超过上限 ${MAX_LLM_WIKI_PROMPT_TOKENS} tokens，已阻止发送`,
    };
  }
  return { ok: true };
}

function findCustomMenuItemByRuntimeId(
  settings: Settings,
  menuItemId: string,
): CustomContextMenuItem | undefined {
  const customItems = settings.customContextMenuItems ?? [];
  return customItems.find((item) => customMenuRuntimeId(item.id) === menuItemId);
}

async function notifyUiError(message: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "extraction-error", message });
  } catch (sendErr) {
    logWarn("Failed to send extraction-error", sendErr);
  }
}

async function notifyUiProcessing(statusText: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "extraction-processing", statusText });
  } catch (sendErr) {
    logWarn("Failed to send extraction-processing", sendErr);
  }
}

async function extractSelectionDom(
  tabId: number,
  selectedTextFallback: string,
): Promise<{ html: string; text: string; extractStatus: "success" | "partial" | "failed" }> {
  const scriptingApi = typeof chrome === "undefined" ? undefined : chrome.scripting;
  if (!scriptingApi?.executeScript) {
    return { html: "", text: selectedTextFallback, extractStatus: "failed" };
  }

  try {
    const results = await scriptingApi.executeScript({
      target: { tabId },
      func: () => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
          return { html: "", text: "" };
        }

        const wrappers: string[] = [];
        for (let i = 0; i < selection.rangeCount; i += 1) {
          const range = selection.getRangeAt(i);
          const container = document.createElement("div");
          container.appendChild(range.cloneContents());
          wrappers.push(container.innerHTML);
        }

        return {
          html: wrappers.join("\n"),
          text: (selection.toString() || "").trim(),
        };
      },
    });

    const payload = (Array.isArray(results)
      ? results[0]?.result
      : (results as any)?.result) as { html?: string; text?: string };

    const html = (payload?.html ?? "").trim();
    const text = (payload?.text ?? "").trim() || selectedTextFallback;

    if (html) {
      return { html, text, extractStatus: "success" };
    }
    if (text) {
      return { html: "", text, extractStatus: "partial" };
    }
    return { html: "", text: selectedTextFallback, extractStatus: "failed" };
  } catch (err) {
    logWarn("extractSelectionDom failed:", err);
    return {
      html: "",
      text: selectedTextFallback,
      extractStatus: selectedTextFallback ? "partial" : "failed",
    };
  }
}

async function ensureContextMenu(): Promise<void> {
  const settings = await createStorageGateway().loadSettings();

  try {
    await chrome.contextMenus.removeAll();
  } catch (err) {
    logWarn("contextMenus.removeAll failed", err);
  }

  try {
    chrome.contextMenus.create({
      id: "hermes_send_root",
      title: "发送Hermes",
      contexts: ["page", "selection"],
    });

    if (settings.showReadabilityContextMenu ?? true) {
      chrome.contextMenus.create({
        id: "hermes_send_summary",
        parentId: "hermes_send_root",
        title: "总结",
        contexts: ["page", "selection"],
      });
    }

    chrome.contextMenus.create({
      id: "hermes_send_llm_wiki_page",
      parentId: "hermes_send_root",
      title: "整页",
      contexts: ["page"],
    });

    chrome.contextMenus.create({
      id: "hermes_send_llm_wiki_selection",
      parentId: "hermes_send_root",
      title: "所选内容",
      contexts: ["selection"],
    });

    for (const item of settings.customContextMenuItems ?? []) {
      if (!item.enabled) continue;
      const title = (item.title ?? "").trim();
      if (!title) continue;
      chrome.contextMenus.create({
        id: customMenuRuntimeId(item.id),
        parentId: "hermes_send_root",
        title,
        contexts: item.source === "selection-dom" ? ["selection"] : ["page", "selection"],
      });
    }
  } catch (err) {
    logError("contextMenus.create failed", err);
  }
}

async function streamAiResponse(
  apiKey: string,
  modelId: string,
  prompt: string,
  apiBaseUrl: string,
): Promise<string> {
  const api = new HermesApiClient({ baseUrl: apiBaseUrl });

  const now = Date.now();
  const userMessage: UserMessage = {
    id: shortId("um"),
    role: "user",
    content: prompt,
    createdAt: now,
    idempotencyKey: crypto.randomUUID?.() || `${now}-${Math.random()}`,
  };

  logInfo("Opening chat stream...");
  let assistantContent = "";
  let thinkingAnnounced = false;

  await notifyUiProcessing("请求已发送，等待模型响应...");
  const res = await api.openChatStream({
    model: modelId,
    messages: toWireMessages([userMessage]),
    stream: true,
    apiKey,
  });

  logInfo("Consuming stream...");
  await notifyUiProcessing("正在接收模型流式响应...");

  await consumeChatStream(res, {
    onTextDelta: (delta) => {
      assistantContent += delta;
      logInfo("Stream delta, total length:", assistantContent.length);
    },
    onThinkingDelta: (_delta) => {
      if (!thinkingAnnounced) {
        thinkingAnnounced = true;
        void notifyUiProcessing("模型思考中...");
      }
    },
    onToolProgress: (payload) => {
      const status = payload.status === "started" ? "调用中" : "已完成";
      void notifyUiProcessing(`工具 ${payload.tool} ${status}`);
    },
  });

  logInfo("Stream complete, total content length:", assistantContent.length);
  return assistantContent;
}

async function ensureModelId(
  apiKey: string,
  apiUrl: string,
  currentModelId: string | undefined,
): Promise<string> {
  if (currentModelId) {
    logInfo("Using model from settings:", currentModelId);
    return currentModelId;
  }

  logWarn("No default model in settings, fetching model list...");
  const api = new HermesApiClient({ baseUrl: apiUrl });
  const models = await api.listModels(apiKey);

  if (models.length === 0) {
    throw new Error("No models available from API");
  }

  const modelId = models[0];
  logInfo("Auto-selected first available model:", modelId);
  return modelId;
}

async function runPromptWorkflow(prompt: string, settings: Settings): Promise<void> {
  const modelId = await ensureModelId(
    settings.apiKey,
    settings.apiBaseUrl,
    settings.defaultModelId,
  );

  const now = Date.now();
  const userMessage: UserMessage = {
    id: shortId("um"),
    role: "user",
    content: prompt,
    createdAt: now,
    idempotencyKey: crypto.randomUUID?.() || `${now}-${Math.random()}`,
  };

  try {
    await chrome.runtime.sendMessage({ type: "extraction-start" });
  } catch (err) {
    logWarn("Failed to send extraction-start:", err);
  }

  let assistantContent = "";
  try {
    assistantContent = await streamAiResponse(
      settings.apiKey,
      modelId,
      prompt,
      settings.apiBaseUrl,
    );
  } catch (apiError) {
    logError("API call failed:", apiError);
    assistantContent = `(整理失败: ${apiError instanceof Error ? apiError.message : String(apiError)})`;
  }

  const assistantMessage: AssistantMessage = {
    id: shortId("am"),
    role: "assistant",
    content: assistantContent,
    createdAt: Date.now(),
    modelId,
    streaming: false,
  };

  try {
    await chrome.runtime.sendMessage({
      type: "add-extraction-result",
      userMessage,
      assistantMessage,
    });
  } catch (err) {
    logError("Failed to broadcast extraction result:", err);
    await notifyUiError("结果回传到侧边栏失败");
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuItemId = String(info.menuItemId ?? "");
  const isCustomItem = menuItemId.startsWith(CUSTOM_MENU_ID_PREFIX);

  if (
    menuItemId !== "hermes_send_summary" &&
    menuItemId !== "hermes_send_llm_wiki_page" &&
    menuItemId !== "hermes_send_llm_wiki_selection" &&
    !isCustomItem
  ) {
    return;
  }

  const tabId = tab?.id;
  if (typeof tabId !== "number") return;

  try {
    await (chrome.sidePanel as any).open?.({ tabId });
  } catch (err) {
    logWarn("Side panel open failed:", err);
  }

  const gateway = createStorageGateway();
  const settings = await gateway.loadSettings();
  const promptTemplates = getPromptTemplates(settings);

  if (isCustomItem) {
    const customItem = findCustomMenuItemByRuntimeId(settings, menuItemId);
    if (!customItem || !customItem.enabled) {
      await notifyUiError("自定义菜单项不存在或已禁用");
      return;
    }

    logInfo("Context menu clicked: custom item", {
      id: customItem.id,
      title: customItem.title,
      source: customItem.source,
    });

    try {
      let domHtml = "";
      let text = "";
      let title = tab?.title ?? "Untitled";
      const sourceUrl = tab?.url ?? "about:blank";

      if (customItem.source === "selection-dom") {
        const selected = await extractSelectionDom(tabId, (info.selectionText ?? "").trim());
        domHtml = selected.html;
        text = selected.text;
      } else {
        const parsed = await extractPageMainContent(tabId, { useReadability: true });
        domHtml = parsed.html ?? "";
        text = parsed.text ?? "";
        title = parsed.title ?? title;
      }

      const prompt = buildPromptFromTemplate({
        template: customItem.promptTemplate || DEFAULT_CUSTOM_MENU_PROMPT_TEMPLATE,
        title,
        url: sourceUrl,
        domHtml,
        text,
        menuTitle: customItem.title,
      });

      const validation = validateLlmWikiPromptLength({
        settings,
        domHtml,
        prompt,
        modeLabel: customItem.title || "自定义菜单",
      });
      if (!validation.ok) {
        logWarn("Custom menu blocked by guard:", validation.reason);
        await notifyUiError(validation.reason);
        return;
      }

      logInfo("Custom prompt built:", {
        id: customItem.id,
        title: customItem.title,
        promptLength: prompt.length,
        htmlLength: domHtml.length,
        textLength: text.length,
      });

      await runPromptWorkflow(prompt, settings);
      logInfo("✓ custom menu workflow complete", { id: customItem.id });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      logError("✗ custom menu workflow failed:", e);
      await notifyUiError(`自定义菜单执行失败: ${errorMsg}`);
    }
    return;
  }

  if (menuItemId === "hermes_send_llm_wiki_selection") {
    logInfo("Context menu clicked: 所选内容");
    try {
      const selectionFallback = (info.selectionText ?? "").trim();
      const selected = await extractSelectionDom(tabId, selectionFallback);
      const prompt = buildPromptFromTemplate({
        template: promptTemplates.llmWikiSelection,
        title: tab?.title ?? undefined,
        url: tab?.url ?? undefined,
        domHtml: selected.html,
        text: selected.text,
        menuTitle: "所选内容",
      });

      const validation = validateLlmWikiPromptLength({
        settings,
        domHtml: selected.html,
        prompt,
        modeLabel: "所选内容",
      });
      if (!validation.ok) {
        logWarn("Selection send blocked by guard:", validation.reason);
        await notifyUiError(validation.reason);
        return;
      }

      logInfo("Selection prompt built:", {
        promptLength: prompt.length,
        htmlLength: selected.html.length,
        textLength: selected.text.length,
        extractStatus: selected.extractStatus,
      });

      await runPromptWorkflow(prompt, settings);
      logInfo("✓ 所选内容 workflow complete");
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      logError("✗ 所选内容 workflow failed:", e);
      await notifyUiError(`所选内容发送失败: ${errorMsg}`);
    }
    return;
  }

  if (menuItemId === "hermes_send_llm_wiki_page") {
    logInfo("Context menu clicked: 整页");
    try {
      await notifyUiProcessing("正在提取页面 DOM 主体...");
      const parsed = await extractPageMainContent(tabId, { useReadability: true });

      const extractStatus: "success" | "partial" | "failed" = parsed.html
        ? "success"
        : parsed.text
          ? "partial"
          : "failed";

      const prompt = buildPromptFromTemplate({
        template: promptTemplates.llmWikiPage,
        title: parsed.title ?? tab?.title ?? undefined,
        url: tab?.url ?? undefined,
        domHtml: parsed.html,
        text: parsed.text,
        menuTitle: "整页",
      });

      await notifyUiProcessing("已提取 DOM，正在构建请求...");

      const validation = validateLlmWikiPromptLength({
        settings,
        domHtml: parsed.html ?? "",
        prompt,
        modeLabel: "整页",
      });
      if (!validation.ok) {
        logWarn("Full-page send blocked by guard:", validation.reason);
        await notifyUiError(validation.reason);
        return;
      }

      logInfo("Full-page prompt built:", {
        promptLength: prompt.length,
        htmlLength: parsed.html?.length ?? 0,
        textLength: parsed.text?.length ?? 0,
        extractStatus,
      });

      await runPromptWorkflow(prompt, settings);
      logInfo("✓ 整页 workflow complete");
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      logError("✗ 整页 workflow failed:", e);
      await notifyUiError(`整页内容发送失败: ${errorMsg}`);
    }
    return;
  }

  logInfo("Context menu clicked: 总结");

  try {
    await notifyUiProcessing("正在提取页面内容...");
    const parsed = await extractPageMainContent(tabId, { useReadability: true });

    const userPrompt = buildPromptFromTemplate({
      template: promptTemplates.summary,
      title: parsed.title ?? tab?.title ?? undefined,
      url: tab?.url ?? undefined,
      domHtml: parsed.html,
      text: parsed.text,
      menuTitle: "总结",
    });

    await notifyUiProcessing("已提取内容，正在请求模型...");
    await runPromptWorkflow(userPrompt, settings);
    logInfo("✓ Extraction workflow complete!");
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    logError("✗ Extraction workflow failed:", e);
    await notifyUiError(`页面内容提取失败: ${errorMsg}`);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  logInfo("Extension installed, setting up...");
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => {
      logError("setPanelBehavior failed", err);
    });

  void ensureContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  logInfo("Browser started, ensuring context menu...");
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => {
      logError("setPanelBehavior failed", err);
    });

  void ensureContextMenu();
});

chrome.storage?.onChanged?.addListener((_changes, areaName) => {
  if (areaName !== "local") return;
  logInfo("Storage changed, refreshing context menus...");
  void ensureContextMenu();
});

export {};
