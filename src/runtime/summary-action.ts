import { buildSummaryPrompt, type PageContext } from "../shared/page-context";

export interface SummaryDraftDeps {
  queryActiveTab?: () => Promise<PageContext | null>;
  readSelection?: (context: PageContext) => Promise<string>;
}

async function defaultQueryActiveTab(): Promise<PageContext | null> {
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
  const prompt = buildSummaryPrompt({
    title: page.title,
    url: page.url,
    selectedText: selectedText || undefined,
  });

  const trimmed = existingDraft.trim();
  return trimmed ? `${prompt}\n\n${trimmed}` : prompt;
}
