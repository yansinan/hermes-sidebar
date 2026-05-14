import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  linkStyle: "inlined",
  hr: "---",
});

// Strip obvious noise tags before converting Readability HTML to markdown.
turndown.remove(["script", "style", "noscript", "nav", "footer"]);

export function htmlToMarkdown(html: string): string {
  const normalized = (html ?? "").trim();
  if (!normalized) return "";
  return turndown.turndown(normalized).trim();
}
