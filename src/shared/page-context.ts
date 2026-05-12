export interface PageContext {
  title?: string;
  url?: string;
  selectedText?: string;
}

function pushLine(lines: string[], text: string | undefined): void {
  if (!text) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  lines.push(trimmed);
}

export function buildSummaryPrompt(context: PageContext = {}): string {
  const lines: string[] = ["请用中文总结下面内容，给出 3 个要点："];

  if (context.title || context.url) {
    lines.push("", "页面信息：");
    pushLine(lines, context.title ? `页面标题：${context.title}` : undefined);
    pushLine(lines, context.url ? `页面链接：${context.url}` : undefined);
  }

  if (context.selectedText?.trim()) {
    lines.push("", "选中文本：", context.selectedText.trim());
  }

  lines.push("", "请直接基于上面的页面信息与内容来总结，不要脱离页面上下文。");
  return lines.join("\n");
}
