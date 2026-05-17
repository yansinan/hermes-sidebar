import {
  buildPromptFromTemplate,
  type PageBodySummaryContext,
} from "../shared/domain";
import { DEFAULT_SETTINGS } from "../shared/types/settings";
import { extractPageMainContent } from "../shared/utils";

export interface PageBodySummaryDeps {
  queryActiveTab?: () => Promise<PageBodySummaryContext | null>;
  // 允许调用方注入模板，默认复用右键菜单的 summary 模板。
  summaryTemplate?: string;
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
 * Phase 1B summary flow: read page body text from the active tab only when the
 * user explicitly asks for the body-summary button. This keeps the new path
 * isolated from the original quick summary action.
 */
export async function buildPageBodySummaryDraft(
  existingDraft: string,
  deps: PageBodySummaryDeps = {},
): Promise<string> {
  const queryActiveTab = deps.queryActiveTab ?? defaultQueryActiveTab;
  const page = (await queryActiveTab()) ?? {};
  const summaryTemplate = deps.summaryTemplate ?? DEFAULT_SETTINGS.contextMenuPrompts.summary;

  // 抽取正文内容（HTML + 纯文本），用于填充与右键“总结”同款模板变量。
  let bodyText = "";
  let bodyHtml = "";

  if (typeof page.tabId === "number") {
    try {
      const parsed = await extractPageMainContent(page.tabId, {
        useReadability: true,
      });
      bodyText = parsed.text ?? "";
      bodyHtml = parsed.html ?? "";
    } catch {
      bodyText = "";
      bodyHtml = "";
    }
  }

  // 与右键菜单“总结”统一：同模板、同变量（title/url/dom_html/text/menu_title/now_iso）。
  const prompt = buildPromptFromTemplate({
    template: summaryTemplate,
    title: page.title,
    url: page.url,
    domHtml: bodyHtml.trim(),
    text: bodyText.trim(),
    menuTitle: "总结",
  });

  const trimmed = existingDraft.trim();
  return trimmed ? `${prompt}\n\n${trimmed}` : prompt;
}
