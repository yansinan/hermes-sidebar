import { buildPromptFromTemplate } from "../shared/domain";
import type { PageBodySummaryContext } from "../shared/types/page-context";

export interface SummaryDraftDeps {
  queryActiveTab?: () => Promise<PageBodySummaryContext | null>;
  readSelection?: (context: PageBodySummaryContext) => Promise<string>;
}

async function defaultQueryActiveTab(): Promise<PageBodySummaryContext | null> {
  const tabsApi = typeof chrome === "undefined" ? undefined : chrome.tabs;
  if (!tabsApi?.query) return null;

  const [tab] = await tabsApi.query({ active: true, currentWindow: true });
  if (!tab) return null;

  return {
    title: tab.title ?? undefined,
    url: tab.url ?? undefined,
  };
}

async function defaultReadSelection(): Promise<string> {
  const tabsApi = typeof chrome === "undefined" ? undefined : chrome.tabs;
  const scriptingApi = typeof chrome === "undefined" ? undefined : chrome.scripting;
  if (!tabsApi || !scriptingApi?.executeScript) return "";

  const [tab] = await tabsApi.query({ active: true, currentWindow: true });
  if (!tab?.id) return "";

  try {
    const results = await scriptingApi.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString() ?? "",
    });
    return results[0]?.result ?? "";
  } catch {
    return "";
  }
}

/**
 * Phase 1A summary flow: preserve the original quick action, but enrich the
 * prompt with the active tab title/url and any currently selected text.
 */
export async function buildSummaryDraft(
  existingDraft: string,
  deps: SummaryDraftDeps = {},
): Promise<string> {
  const queryActiveTab = deps.queryActiveTab ?? defaultQueryActiveTab;
  const readSelection = deps.readSelection ?? defaultReadSelection;
  const page = (await queryActiveTab()) ?? {};
  const selectedText = (await readSelection(page))?.trim() ?? "";
  const prompt = buildPromptFromTemplate({
    template: "请用中文总结下面内容，给出 3 个要点：\n\n{{text}}",
    title: page.title,
    url: page.url,
    text: selectedText || undefined,
  });

  const trimmed = existingDraft.trim();
  return trimmed ? `${prompt}\n\n${trimmed}` : prompt;
}
