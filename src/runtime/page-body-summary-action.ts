import { buildPageBodySummaryPrompt, type PageBodySummaryContext } from "../shared/page-body-summary";
import { extractPageMainContent } from "../shared/page-extractor";

export interface PageBodySummaryDeps {
  queryActiveTab?: () => Promise<PageBodySummaryContext | null>;
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
  
  // Extract both text and HTML structure
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
  
  const prompt = buildPageBodySummaryPrompt({
    tabId: page.tabId,
    title: page.title,
    url: page.url,
    bodyText: bodyText.trim() || undefined,
    bodyHtml: bodyHtml.trim() || undefined,
  });

  const trimmed = existingDraft.trim();
  return trimmed ? `${prompt}\n\n${trimmed}` : prompt;
}
