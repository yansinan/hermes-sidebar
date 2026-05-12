export interface PageBodySummaryContext {
  tabId?: number;
  title?: string;
  url?: string;
  bodyText?: string;
}

function pushLine(lines: string[], text: string | undefined): void {
  if (!text) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  lines.push(trimmed);
}

export function buildPageBodySummaryPrompt(
  context: PageBodySummaryContext = {},
): string {
  const lines: string[] = ["请用中文总结下面页面正文，给出 3 个要点："];

  if (context.title || context.url) {
    lines.push("", "页面信息：");
    pushLine(lines, context.title ? `页面标题：${context.title}` : undefined);
    pushLine(lines, context.url ? `页面链接：${context.url}` : undefined);
  }

  if (context.bodyText?.trim()) {
    lines.push("", "页面正文：", context.bodyText.trim());
  }

  lines.push("", "请只总结页面正文本身，尽量不要依赖额外上下文。");
  return lines.join("\n");
}
