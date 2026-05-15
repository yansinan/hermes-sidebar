/** Race a promise against a per-call deadline to prevent executeScript from hanging. */
function withExecTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export async function htmlToMarkdown(html: string, tabId?: number): Promise<string> {
  const normalized = (html ?? "").trim();
  if (!normalized) return "";

  if (typeof tabId === "number") {
    try {
      const scriptingApi = typeof chrome === "undefined" ? undefined : chrome.scripting;
      if (!scriptingApi?.executeScript) {
        return fallbackHtmlToMarkdown(normalized);
      }

      // Wait for bundle injection to fully complete before running conversion.
      // withExecTimeout was removed here because resolving early caused the
      // conversion executeScript to run before createTurndownService was on window.
      // The outer MARKDOWN_TIMEOUT_MS race in the controller is the safety net.
      await scriptingApi
        .executeScript({ target: { tabId }, files: ["turndown.bundle.js"] })
        .catch(() => {});

      // 7 s timeout for the actual conversion (Turndown on large HTML can be slow).
      const results = await withExecTimeout(
        (scriptingApi as any).executeScript({
        target: { tabId },
        func: (text: string) => {
          try {
            const createTurndown = (window as any).createTurndownService;
            if (!createTurndown) {
              return { text: "TurndownService unavailable", error: "TurndownService unavailable" };
            }

            const turndown = createTurndown({
              headingStyle: "atx",
              codeBlockStyle: "fenced",
              bulletListMarker: "-",
              linkStyle: "inlined",
              hr: "---",
            });
            // Strip obvious noise tags before converting Readability HTML to markdown.
            turndown.remove(["script", "style", "noscript", "nav", "footer","iframe"]);

            const parser = new DOMParser();
            const doc = parser.parseFromString(text, "text/html");
            // // Remove "skip to content" accessibility anchor links before conversion
            // doc.querySelectorAll('a[href^="#"]').forEach((el) => {
            //   if (/^skip\b/i.test((el.textContent ?? "").trim())) el.remove();
            // });

            // // Normalize <pre> blocks so Turndown's fenced-code rule fires.
            // // Readability (and some site renderers) leave whitespace text nodes
            // // before <code> inside <pre>, causing pre.firstChild !== CODE.
            // doc.querySelectorAll('pre').forEach((pre) => {
            //   // Strip leading whitespace-only text nodes.
            //   while (
            //     pre.firstChild &&
            //     pre.firstChild.nodeType === Node.TEXT_NODE &&
            //     (pre.firstChild as Text).data.trim() === ''
            //   ) {
            //     pre.removeChild(pre.firstChild);
            //   }
            //   // If still no <code> as first child, wrap all content in one.
            //   if (pre.firstChild && pre.firstChild.nodeName !== 'CODE') {
            //     const code = doc.createElement('code');
            //     while (pre.firstChild) code.appendChild(pre.firstChild);
            //     pre.appendChild(code);
            //   }
            // });

            // // Normalize tables so Turndown's GFM table rule fires.
            // // The rule requires a <thead> row OR a first <tr> whose every cell
            // // is <th>.  Readability sometimes loses <thead> or uses <td> in
            // // the header row — convert it back so the table is recognised.
            // doc.querySelectorAll('table').forEach((table) => {
            //   if (table.querySelector('thead')) return; // already has thead
            //   const container = table.querySelector('tbody') ?? table;
            //   const firstRow = container.querySelector(':scope > tr');
            //   if (!firstRow) return;
            //   const cells = Array.from(firstRow.querySelectorAll(':scope > td, :scope > th')) as HTMLElement[];
            //   if (cells.length === 0) return;
            //   // If first row has all <th> → wrap in <thead>
            //   if (cells.every((c) => c.tagName === 'TH')) {
            //     const thead = doc.createElement('thead');
            //     firstRow.parentElement!.insertBefore(thead, firstRow);
            //     thead.appendChild(firstRow);
            //   } else {
            //     // Promote first row's <td> to <th> and wrap in <thead>
            //     cells.forEach((td) => {
            //       const th = doc.createElement('th');
            //       th.innerHTML = td.innerHTML;
            //       td.replaceWith(th);
            //     });
            //     const thead = doc.createElement('thead');
            //     firstRow.parentElement!.insertBefore(thead, firstRow);
            //     thead.appendChild(firstRow);
            //   }
            // });

            let md = text;
            try {
              md = turndown.turndown(doc.body.innerHTML).trim();
            } catch (e) {
              return { text: "[markdown-converter] Turndown conversion error:" + String(e) + "\n md=="+ doc.body.innerText, error: String(e) };
            }
            // // Strip any remaining leading "Skip to X" link lines
            // md = md.replace(/^(\[Skip[^\]]*\]\([^)]*\)\s*\n*)+/gi, "").trimStart();
            return { text: md };
          } catch (e) {
            return { text: "htmlToMarkdown() error:" + String(e) + "\n text=="+ text, error: String(e) };
          }
        },
        args: [normalized],
        }),
        7_000,
        [] as any[],
      );

      const result = Array.isArray(results)
        ? (results[0] as any)?.result
        : (results as any)?.result;
      if (result?.error) {
        console.warn("[markdown-converter] Turndown error:", result.error);
      }
      return result?.text || fallbackHtmlToMarkdown(normalized);
    } catch (err) {
      console.warn("[markdown-converter] Unexpected error, using fallback:", err);
      return fallbackHtmlToMarkdown(normalized);
    }
  }

  return fallbackHtmlToMarkdown(normalized);
}

function fallbackHtmlToMarkdown(html: string): string {
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    // Strip skip-to-content anchor links before other processing
    .replace(/<a[^>]*href="#[^"]*"[^>]*>(?:skip[^<]*)<\/a>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) =>
      "\n" + "#".repeat(parseInt(n)) + " " + t.replace(/<[^>]*>/g, "").trim() + "\n",
    )
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "_$1_")
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "_$1_")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "```$1```")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<[^>]*>/g, "");

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

