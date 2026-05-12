export interface PageExtractionResult {
  text: string; // Plain text for UI display
  html?: string; // Cleaned HTML structure for AI agent (preserves DOM hierarchy)
  content?: string; // Original cleaned content from Readability
  title?: string;
  byline?: string;
  dir?: string;
  length?: number;
  lang?: string;
  selectorsTried?: string[];
  error?: string;
}

export interface ExtractOptions {
  useReadability?: boolean;
  allFrames?: boolean;
}

/**
 * Extract main content from the given tab. Tries Readability (if requested)
 * and falls back to lightweight heuristics.
 */
export async function extractPageMainContent(
  tabId?: number,
  opts: ExtractOptions = {},
): Promise<PageExtractionResult> {
  const { useReadability = false } = opts;
  const scriptingApi = typeof chrome === "undefined" ? undefined : chrome.scripting;
  if (!scriptingApi?.executeScript || typeof tabId !== "number") {
    return { text: "" };
  }

  // Helper to pick the longest text result among frames
  const pickLongest = (arr: any[]): PageExtractionResult => {
    let best: PageExtractionResult = { text: "" };
    for (const item of arr) {
      const r = item?.result ?? item;
      if (!r) continue;
      const text = (r.text ?? "") as string;
      if (text.length > (best.text?.length ?? 0)) {
        best = {
          text,
          html: r.html ?? r.content,
          content: r.content,
          title: r.title,
          byline: r.byline,
          dir: r.dir,
          length: r.length,
          lang: r.lang,
          selectorsTried: r.selectorsTried,
          error: r.error,
        };
      }
    }
    return best;
  };

  // 1) Try Readability (inject bundle then run parse in page)
  if (useReadability) {
    try {
      // Inject the bundled Readability file (public/readability.bundle.js)
      try {
        await scriptingApi.executeScript({
          target: { tabId },
          files: ["readability.bundle.js"],
        });
      } catch {
        // injection may fail in tests or restricted contexts; continue
      }

      const results = await scriptingApi.executeScript({
        target: { tabId },
        func: () => {
          try {
            const R = (window as any).Readability;
            if (!R) return { text: "", error: "Readability unavailable" };
            const article = new (window as any).Readability(document).parse();
            if (!article) return { text: "", error: "no-article" };
            
            // Keep Readability's cleaned HTML for structure preservation
            let cleanedHtml = article.content ?? "";
            
            // Further clean HTML: remove scripts, styles, and excess whitespace
            if (cleanedHtml) {
              const tmp = document.createElement("div");
              tmp.innerHTML = cleanedHtml;
              // Remove script and style tags
              tmp.querySelectorAll("script, style, nav, footer").forEach((el) => el.remove());
              // Remove empty divs and very small elements (< 10 chars of text)
              tmp.querySelectorAll("div, span, p, section, article").forEach((el) => {
                const text = el.textContent?.trim() ?? "";
                if (text.length === 0 || (el.tagName !== "P" && text.length < 10)) {
                  if (!el.querySelector("img") && el.children.length === 0) {
                    el.remove();
                  }
                }
              });
              cleanedHtml = tmp.innerHTML;
            }
            
            // Convert HTML to plain text for UI display
            const textDiv = document.createElement("div");
            textDiv.innerHTML = cleanedHtml;
            const plainText = textDiv.innerText
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .join("\n");
            
            return {
              text: plainText,
              html: cleanedHtml, // Preserve structure for agent
              content: article.content ?? undefined,
              title: article.title ?? document.title,
              byline: article.byline ?? undefined,
              dir: article.dir ?? document.documentElement.dir ?? undefined,
              length: article.length ?? undefined,
              lang: document.documentElement.lang ?? undefined,
            };
          } catch (e) {
            return { text: "", error: String(e) };
          }
        },
      });

      const picked = pickLongest(Array.isArray(results) ? results : [results]);
      if (picked.text && picked.text.length > 0) return picked;
    } catch {
      // continue to heuristics
    }
  }

  // 2) Fallback heuristics (selectors -> largest visible block -> body)
  try {
    const results = await scriptingApi.executeScript({
      target: { tabId },
      func: () => {
        // Helper to normalize extracted text: remove noise lines, collapse whitespace
        const normalizeText = (raw: string): string => {
          const lines = raw
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .filter((line) => {
              if (line.length < 3) return false;
              if (/^(首页|导航|返回|上一页|下一页|分享|下载|打开|关闭|Nav|Home|Back|\||-|•|·)$/.test(line))
                return false;
              return true;
            });
          return lines.join("\n");
        };

        try {
          const selectors = ["main", "article", '[role="main"]'];
          const tried: string[] = [];
          for (const s of selectors) {
            tried.push(s);
            const el = document.querySelector(s) as HTMLElement | null;
            if (el && el.innerText && el.innerText.trim().length > 0) {
              return {
                text: normalizeText(el.innerText),
                html: el.outerHTML ?? "",
                selectorsTried: tried,
              };
            }
          }

          // pick largest visible block among candidates
          const candidates = Array.from(
            document.querySelectorAll("article, main, section, div"),
          ) as HTMLElement[];
          let bestText = "";
          let bestHtml = "";
          let bestTag = "body";
          for (const c of candidates) {
            try {
              const style = window.getComputedStyle(c);
              if (style && style.display === "none") continue;
              if (!c.isConnected) continue;
              const text = (c as HTMLElement).innerText || "";
              if (text.length > bestText.length) {
                bestText = text;
                bestHtml = (c as HTMLElement).outerHTML || "";
                bestTag = (c.tagName || "div").toLowerCase();
              }
            } catch {
              // ignore element access errors
            }
          }

          if (!bestText && document.body) {
            bestText = document.body.innerText || "";
            bestHtml = document.body.outerHTML || document.body.innerHTML || "";
          }

          return {
            text: normalizeText(bestText),
            html: bestHtml,
            selectorsTried: tried.concat([bestTag]),
          };
        } catch {
          return { text: "" };
        }
      },
    });

    const picked = pickLongest(Array.isArray(results) ? results : [results]);
    return picked;
  } catch {
    return { text: "" };
  }
}
