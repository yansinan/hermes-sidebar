import { buildPageBodySummaryPrompt, type PageBodySummaryContext } from "../shared/page-body-summary";

export interface PageBodySummaryDeps {
  queryActiveTab?: () => Promise<PageBodySummaryContext | null>;
  readPageBody?: (context: PageBodySummaryContext) => Promise<string>;
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

async function defaultReadPageBody(context: PageBodySummaryContext): Promise<string> {
  const tabsApi = typeof chrome === "undefined" ? undefined : chrome.tabs;
  const scriptingApi = typeof chrome === "undefined" ? undefined : chrome.scripting;
  if (!tabsApi || !scriptingApi?.executeScript || typeof context.tabId !== "number") return "";

  try {
    const results = await scriptingApi.executeScript({
      target: { tabId: context.tabId },
      func: () => {
        const root = document.body;
        if (!root) return "";
        return root.innerText.replace(/\n{3,}/g, "\n\n").trim();
      },
    });
    return results[0]?.result ?? "";
  } catch {
    return "";
  }
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
  const readPageBody = deps.readPageBody ?? defaultReadPageBody;
  const page = (await queryActiveTab()) ?? {};
  const bodyText = (await readPageBody(page))?.trim() ?? "";
  const prompt = buildPageBodySummaryPrompt({
    tabId: page.tabId,
    title: page.title,
    url: page.url,
    bodyText: bodyText || undefined,
  });

  const trimmed = existingDraft.trim();
  return trimmed ? `${prompt}\n\n${trimmed}` : prompt;
}
