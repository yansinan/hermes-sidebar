/**
 * Selection-based summary: handles user-selected text summarization.
 * This flow mirrors the context menu "所选内容" implementation,
 * reusing extractSelectionDom + buildPromptFromTemplate.
 */

import {
  buildPromptFromTemplate,
  type PageBodySummaryContext,
} from "../shared/domain";
import { DEFAULT_SETTINGS } from "../shared/types/settings";
import { extractSelectionDom } from "../shared/utils";

export interface SelectionSummaryDeps {
  queryActiveTab?: () => Promise<PageBodySummaryContext | null>;
  extractSelection?: (tabId: number, fallback: string) => Promise<{ html: string; text: string; extractStatus: "success" | "partial" | "failed" }>;
  // 允许调用方注入模板，默认复用右键菜单的 llmWikiSelection 模板。
  selectionTemplate?: string;
}

async function defaultQueryActiveTab(): Promise<PageBodySummaryContext | null> {
  const tabsApi = typeof chrome === "undefined" ? undefined : chrome.tabs;
  if (!tabsApi?.query) return null;

  const [tab] = await tabsApi.query({ active: true, currentWindow: true });
  if (!tab) return null;

  return {
    tabId: tab.id ?? undefined,
    title: tab.title ?? undefined,
    url: tab.url ?? undefined,
  };
}

/**
 * Phase 1A summary flow: user-selected text summarization.
 * Extracts both HTML and plain text from the user's selection,
 * then builds prompt using the configurable template (default: llmWikiSelection).
 */
export async function buildSelectionSummaryDraft(
  existingDraft: string,
  deps: SelectionSummaryDeps = {},
): Promise<string> {
  const queryActiveTab = deps.queryActiveTab ?? defaultQueryActiveTab;
  const extractSelection = deps.extractSelection ?? extractSelectionDom;
  const page = (await queryActiveTab()) ?? {};
  const selectionTemplate = deps.selectionTemplate ?? DEFAULT_SETTINGS.contextMenuPrompts.llmWikiSelection;

  // 获取当前选中文本作为后备方案
  const selectedTextFallback = "";

  // 复用右键菜单的提取逻辑：获取选中文本的 HTML + 纯文本
  const selected = await extractSelection(
    typeof page.tabId === "number" ? page.tabId : 0,
    selectedTextFallback
  );

  // 与右键菜单"所选内容"统一：同模板、同变量（title/url/dom_html/text/menu_title/now_iso）。
  const prompt = buildPromptFromTemplate({
    template: selectionTemplate,
    title: page.title,
    url: page.url,
    domHtml: selected.html,
    text: selected.text,
    menuTitle: "所选内容",
  });

  const trimmed = existingDraft.trim();
  return trimmed ? `${prompt}\n\n${trimmed}` : prompt;
}
