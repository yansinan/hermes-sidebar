/**
 * Build a prompt for user-initiated text summarization
 * @returns Prompt string for summarizing arbitrary text
 */
export function buildSummaryPrompt(): string {
  return "请用中文总结下面内容，给出 3 个要点：\n\n";
}

/**
 * 将模板中的 {{var}} 占位符替换为上下文变量。
 */
export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => vars[key] ?? "");
}

/**
 * 构建与右键菜单一致的模板提示词（summary/llm-wiki/custom 菜单共用）。
 */
export function buildPromptFromTemplate(params: {
  template: string;
  title?: string;
  url?: string;
  domHtml?: string;
  text?: string;
  menuTitle?: string;
  nowIso?: string;
}): string {
  return renderPromptTemplate(params.template, {
    title: params.title ?? "Untitled",
    url: params.url ?? "about:blank",
    dom_html: params.domHtml ?? "",
    text: params.text ?? "",
    menu_title: params.menuTitle ?? "",
    now_iso: params.nowIso ?? new Date().toISOString(),
  });
}

/**
 * Build a prompt for one-line summary of selected text (for quote context)
 * Used when user selects text and wants it displayed as a conversation quote
 * @param selectedText The text selected by the user
 * @returns One-line summary suitable as a quote/reference
 */
export function buildSelectedTextQuotePrompt(selectedText: string): string {
  return `请用一句话（20 个字以内）总结下面选中的文本，作为对话引用的上下文。只返回总结内容，无需其他说明：

${selectedText}`;
}

/**
 * Build a prompt for full page content extraction
 * Used when user triggers page extraction from right-click menu
 * @param params Context for building the prompt
 * @returns Multi-line prompt for page content summarization
 */
export function buildPageExtractionPrompt(params: {
  title?: string;
  url?: string;
  bodyHtml?: string;
  bodyText?: string;
}): string {
  const lines: string[] = ["请用中文总结下面页面正文，给出 3 个要点："];

  if (params.title || params.url) {
    lines.push("", "页面信息：");
    if (params.title) lines.push(`页面标题：${params.title}`);
    if (params.url) lines.push(`页面链接：${params.url}`);
  }

  if (params.bodyHtml?.trim()) {
    lines.push("", "页面正文（HTML 结构 - 已清理噪声）：", params.bodyHtml.trim());
  } else if (params.bodyText?.trim()) {
    lines.push("", "页面正文（纯文本 - 已清理噪声）：", params.bodyText.trim());
  }

  lines.push(
    "",
    "说明：",
    "- 页面内容已通过 Readability 清理，移除了导航、脚本、样式等噪声",
    "- HTML 模式下：保留了文档结构（段落、标题、列表等），便于理解层级关系",
    "- 请直接总结主要内容，无需再去噪",
    "- 如果 HTML 结构复杂，请合理推断段落关系"
  );
  return lines.join("\n");
}

/**
 * Build a prompt for generating llm-wiki raw material from browser-selected DOM.
 * The prompt includes required metadata and asks the model to produce ingest-ready raw content.
 */
export function buildLlmWikiRawPrompt(params: {
  title?: string;
  sourceUrl?: string;
  sourceType?: string;
  extractStatus?: "success" | "partial" | "failed";
  notes?: string;
  selectedDomHtml?: string;
  selectedText?: string;
}): string {
  const title = (params.title ?? "").trim() || "Untitled";
  const sourceUrl = (params.sourceUrl ?? "").trim() || "about:blank";
  const sourceType = (params.sourceType ?? "").trim() || "doc-article";
  const extractStatus = params.extractStatus ?? "success";
  const notes =
    (params.notes ?? "").trim() ||
    "通过 browser_console 提取全文并复制到 wiki/raw；正文未改动。";

  const lines: string[] = [
    "/llm-wiki 这是从浏览器端用户抽取的DOM内容，创建llm-wiki raw素材，并ingest后同步到obsidian和notebooklm",
    "",
    `title: \"${title.replace(/\"/g, '\\\"')}\"`,
    `source_url: \"${sourceUrl.replace(/\"/g, '\\\"')}\"`,
    `source_type: \"${sourceType.replace(/\"/g, '\\\"')}\"`,
    `extract_status: \"${extractStatus}\"`,
    `notes: \"${notes.replace(/\"/g, '\\\"')}\"`,
    "---",
  ];

  if (params.selectedDomHtml?.trim()) {
    lines.push("", "selected_dom_html:", params.selectedDomHtml.trim());
  }
  if (params.selectedText?.trim()) {
    lines.push("", "selected_text:", params.selectedText.trim());
  }

  lines.push(
    "",
    "要求：",
    "- 基于提供的 metadata 和 DOM 原文，生成 llm-wiki raw 素材",
    "- 不改写事实，不补造来源",
    "- 保留原始结构语义，必要时可规范化为稳定的 markdown 分节",
    "- 输出应可直接进入 ingest 流程"
  );

  return lines.join("\n");
}
