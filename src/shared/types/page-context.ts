/**
 * Context types for page extraction and summarization flows.
 */

export interface PageBodySummaryContext {
  tabId?: number;
  title?: string;
  url?: string;
  bodyText?: string;
  bodyHtml?: string; // Cleaned HTML structure for agent (preserves DOM hierarchy)
}
