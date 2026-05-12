import { buildPageExtractionPrompt } from "./prompt-templates";

/**
 * Context for building a page extraction prompt
 * Used when extracting full page content via Readability
 */
export interface PageBodySummaryContext {
  tabId?: number;
  title?: string;
  url?: string;
  bodyText?: string;
  bodyHtml?: string; // Cleaned HTML structure for agent (preserves DOM hierarchy)
}

/**
 * Build a prompt for page content extraction and summarization
 * This is the main prompt sent to the AI when user clicks "提取页面内容（Readability）"
 * 
 * @param context Page context including title, URL, and content (HTML or plain text)
 * @returns Prompt string for the AI to summarize the page content
 */
export function buildPageBodySummaryPrompt(
  context: PageBodySummaryContext = {},
): string {
  return buildPageExtractionPrompt({
    title: context.title,
    url: context.url,
    bodyHtml: context.bodyHtml,
    bodyText: context.bodyText,
  });
}
