// Settings shape (docs/product-design.md §6.4, §9.1; docs/architecture.md §3.6).
//
// The API key is a credential: it is passed to the API client as a `Bearer`
// token and is never logged. Where it is stored (`chrome.storage.local` vs
// `chrome.storage.session`) is product-design open question 7.

export type EnterBehavior = "send" | "newline";

// Approximate conversion used for client-side DOM size guard.
// A common rough estimate is 1 token ~= 4 characters for mixed English/code.
export const APPROX_CHARS_PER_TOKEN = 4;

export function approxTokensToChars(tokens: number): number {
  const safe = Number.isFinite(tokens) ? Math.max(1, Math.floor(tokens)) : 1;
  return safe * APPROX_CHARS_PER_TOKEN;
}

export function approxCharsToTokens(chars: number): number {
  const safe = Number.isFinite(chars) ? Math.max(0, Math.floor(chars)) : 0;
  return Math.ceil(safe / APPROX_CHARS_PER_TOKEN);
}

export type CustomMenuSource = "selection-dom" | "page-dom";

export interface ContextMenuPrompts {
  summary: string;
  llmWikiSelection: string;
  llmWikiPage: string;
}

export interface CustomContextMenuItem {
  id: string;
  title: string;
  source: CustomMenuSource;
  promptTemplate: string;
  enabled: boolean;
}

export const DEFAULT_SUMMARY_PROMPT_TEMPLATE = [
  "请用中文总结下面页面正文，给出 3 个要点：",
  "",
  "页面信息：",
  "页面标题：{{title}}",
  "页面链接：{{url}}",
  "",
  "页面正文（HTML 结构 - 已清理噪声）：",
  "{{dom_html}}",
  "",
  "说明：",
  "- 页面内容已通过 Readability 清理，移除了导航、脚本、样式等噪声",
  "- 保留了文档结构（段落、标题、列表等），便于理解层级关系",
  "- 请直接总结主要内容，无需再去噪",
].join("\n");

export const DEFAULT_LLM_WIKI_SELECTION_PROMPT_TEMPLATE = [
  "/llm-wiki 这是从浏览器端用户抽取的DOM内容，创建llm-wiki raw素材，并ingest后同步到obsidian和notebooklm",
  "",
  "title: \"{{title}}\"",
  "source_url: \"{{url}}\"",
  "source_type: \"doc-article\"",
  "extract_status: \"success\"",
  "notes: \"通过 browser_console 提取全文并复制到 wiki/raw；正文未改动。\"",
  "---",
  "",
  "selected_dom_html:",
  "{{dom_html}}",
  "",
  "要求：",
  "- 基于提供的 metadata 和 DOM 原文，生成 llm-wiki raw 素材",
  "- 不改写事实，不补造来源",
  "- 输出应可直接进入 ingest 流程",
].join("\n");

export const DEFAULT_LLM_WIKI_PAGE_PROMPT_TEMPLATE = DEFAULT_LLM_WIKI_SELECTION_PROMPT_TEMPLATE;

export const DEFAULT_CUSTOM_MENU_PROMPT_TEMPLATE = [
  "请基于下面的页面 DOM 内容完成处理：",
  "",
  "title: {{title}}",
  "url: {{url}}",
  "",
  "dom:",
  "{{dom_html}}",
].join("\n");

export interface Settings {
  /** Raw user-entered base URL. Normalization into a ProfileKey happens elsewhere. */
  apiBaseUrl: string;
  /** Empty string means "no key configured" — omit Authorization header. */
  apiKey: string;
  /** Default model id used when creating a new draft session. */
  defaultModelId: string;
  enterBehavior: EnterBehavior;
  streamingEnabled: boolean;
  /** Prefer Runs API for streaming when available; fallback to chat stream. */
  useRunsApi?: boolean;
  /** When on, attach `X-Hermes-Session-Id` if a `serverSessionRef` is recorded. */
  reuseServerSession: boolean;
  /** When on, include `Idempotency-Key` on sends (always on in v1 defaults). */
  sendIdempotencyKey: boolean;
  /** Show the Readability extract item in the page context menu */
  showReadabilityContextMenu: boolean;
  /** Prompt templates for built-in context menu actions. */
  contextMenuPrompts: ContextMenuPrompts;
  /** User-defined context menu actions that send DOM to the model. */
  customContextMenuItems: CustomContextMenuItem[];
  /** Max DOM payload size allowed for menu-driven DOM sends (in tokens). */
  maxDomInputTokens: number;
  /** Emit structured debug trace for full-page capture block matching. */
  debugPageCaptureTrace: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBaseUrl: "http://127.0.0.1:8642",
  apiKey: "",
  defaultModelId: "",
  enterBehavior: "send",
  streamingEnabled: true,
  useRunsApi: true,
  reuseServerSession: false,
  sendIdempotencyKey: true,
  showReadabilityContextMenu: true,
  contextMenuPrompts: {
    summary: DEFAULT_SUMMARY_PROMPT_TEMPLATE,
    llmWikiSelection: DEFAULT_LLM_WIKI_SELECTION_PROMPT_TEMPLATE,
    llmWikiPage: DEFAULT_LLM_WIKI_PAGE_PROMPT_TEMPLATE,
  },
  customContextMenuItems: [],
  // 60k tokens ~= 240k chars with current rough conversion.
  maxDomInputTokens: 60_000,
  debugPageCaptureTrace: false,
};
