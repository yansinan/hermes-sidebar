/** Plain-text + structured HTML extracted from a browser tab. */
export interface PageExtractionResult {
  /** Plain text of the article (Readability's textContent, or body.innerText fallback). */
  text: string;
  /** Markdown converted in-page by Turndown (when available). Takes priority over html. */
  markdown?: string;
  /** Cleaned article HTML from Readability (article.content), or raw outerHTML on fallback. */
  html?: string;
  /** Page title from Readability or document.title. */
  title?: string;
  /** Author / byline from Readability, if available. */
  byline?: string;
  /** Text direction (ltr/rtl) from Readability or the document element. */
  dir?: string;
  /** Approximate character length of the extracted article. */
  length?: number;
  /** Page language from <html lang>. */
  lang?: string;
  /** Non-empty when something went wrong during extraction (does not block the result). */
  error?: string;
}

export interface ExtractOptions {
  /**
   * When true (default), inject Readability and run a full parse before
   * falling back to body.innerText.
   * When false, skip straight to the plain body.innerText fallback.
   */
  useReadability?: boolean;
  /** Enable diagnostic logging for full-page capture and Readability parse. */
  debugTrace?: boolean;
}

/**
 * Race an async call against a deadline.  If the call does not settle in `ms`
 * milliseconds, the returned promise resolves with `fallback` instead.
 * This is the only reliable way to bound chrome.scripting.executeScript, which
 * can silently hang on heavy SPAs, restricted pages, and reloaded extension
 * contexts.
 */
function withExecTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * Extract the main content of the currently active browser tab.
 *
 * Flow:
 *   1. If `useReadability` is true, inject `readability.bundle.js` into the tab
 *      then run `Readability.parse()` inside the page context.
 *   2. If that succeeds, return article.textContent + article.content (cleaned HTML).
 *   3. On any failure (injection blocked, parse returns null, exception), fall back
 *      to a second executeScript that reads document.body.innerText.
 *
 * Note: injection (`files`) and the extraction function (`func`) must be
 * separate executeScript calls — Chrome does not allow mixing both in one call.
 *
 * Each executeScript call is individually bounded by withExecTimeout so that a
 * hanging scripting API (e.g. Extension context invalidated, restricted origin)
 * does not block the outer Promise.race in the controller indefinitely.
 */
export async function extractPageMainContent(
  tabId?: number,
  opts: ExtractOptions = {},
): Promise<PageExtractionResult> {
  const { useReadability = true, debugTrace = false } = opts;
  const scriptingApi = typeof chrome === "undefined" ? undefined : (chrome as any).scripting;

  // Outside a Chrome extension context (e.g. unit tests) return an empty result.
  if (!scriptingApi?.executeScript || typeof tabId !== "number") {
    return { text: "" };
  }

  // When Readability is skipped, return a cloned main/article snapshot.
  if (!useReadability) {
    try {
      const fallback = await withExecTimeout(
        scriptingApi.executeScript({
          target: { tabId },
          func: () => ({
            html: document.documentElement.outerHTML || "",
            text: document.body.innerText || "",
            title: document.title,
          }),
        }) as Promise<any[] | null>,
        5_000,
        null,
      );
      const f = fallback && (Array.isArray(fallback) ? fallback[0]?.result : (fallback as any)?.result);
      return {
        html: f?.html || "",
        text: f?.text || "",
        title: f?.title,
      };
    } catch (err) {
      return { text: "", error: "raw-html-fallback-failed: " + String(err) };
    }
  }

  // --- Path 1: Readability extraction ---
  if (useReadability) {
    try {
      // Step 1: inject the pre-bundled Readability IIFE so window.Readability
      // becomes available inside the page. Failures here are non-fatal.
      // NOTE: do NOT wrap with withExecTimeout here — resolving early causes
      // Step 2 to run before window.Readability is available, returning
      // "no-readability-on-window" and losing all HTML structure.
      // The outer EXTRACT_TIMEOUT_MS race in the controller acts as safety net.
      await withExecTimeout(
        scriptingApi
          .executeScript({ target: { tabId }, files: ["readability.bundle.js"] })
          .then(() => true)
          .catch(() => false),
        4_000,
        false,
      );

      // Step 2: snapshot a likely content root from live DOM, then run Readability
      // on a detached document built from that snapshot.
      const results = await withExecTimeout(
        scriptingApi.executeScript({
        target: { tabId },
        func: (trace: boolean) => {
          try {
            const R = (window as any).Readability;
            const ReadabilityCtor =
              typeof R === "function"
                ? R
                : typeof R?.Readability === "function"
                  ? R.Readability
                  : null;
            if (!ReadabilityCtor) {              
              return {
                text: document.body.innerText || "",
                html: document.documentElement.outerHTML,
                title: document.title,
                error: "no-readability-on-window",
              };
            }
            // // Clone the document so Readability's DOM mutations don't affect the live page.
            // const docClone = document.cloneNode(true) as Document;

            // // ── Step A: Shrink to <main> / [role=main] if available ───────────────
            // // Most modern sites (GitHub, Docusaurus, MDN, etc.) have a single <main>
            // // that contains only the article content.  Passing the full document to
            // // Readability lets it accidentally score sidebars and nav tabs as content.
            // // By replacing <body> with just the <main> subtree we eliminate the vast
            // // majority of navigation noise before any selector matching is needed.
            // const mainEl =
            //   (docClone as Document).querySelector('main') ||
            //   (docClone as Document).querySelector('[role="main"]');
            // if (mainEl) {
            //   // Keep only the main element; preserve <head> for metadata.
            //   (docClone as Document).body.innerHTML = "";
            //   (docClone as Document).body.appendChild(mainEl);
            // }

            // // ── Step B: Remove residual noise inside (or alongside) <main> ───────
            // const noiseSelectors = [
            //   // Semantic HTML5
            //   "script", "style", "noscript",
            //   "nav", "header", "footer", "aside", "dialog",
            //   // ARIA roles
            //   "[role='navigation']", "[role='banner']", "[role='complementary']",
            //   "[role='search']", "[role='menubar']", "[role='toolbar']",
            //   "[role='dialog']", "[role='tab']", "[role='tablist']",
            //   // aria-label substring matches
            //   "[aria-label*='navigation' i]", "[aria-label*='sidebar' i]",
            //   "[aria-label*='breadcrumb' i]", "[aria-label*='table of contents' i]",
            //   "[aria-label*='on this page' i]", "[aria-label*='skip' i]",
            //   "[aria-label*='menu' i]", "[aria-label*='pagination' i]",
            //   // data-* attributes (VitePress, Starlight, Nextra, Pagefind)
            //   "[data-sidebar]", "[data-pagefind-ignore]", "[data-nosnippet]",
            //   // ── Extra: class/ID based noise (safe substring patterns) ─────────
            //   // Sidebars surviving main-shrink (GitHub, GitLab, MkDocs, etc.)
            //   "[class*='-sidebar']", "[class*='sidebar-']", "[id*='sidebar']",
            //   // Table-of-contents widgets (Docusaurus, VitePress, Sphinx)
            //   ".table-of-contents", ".toc", "#toc",
            //   "[class*='-toc']", "[class*='toc-']", "[id*='-toc']",
            //   "[class*='TableOfContents']",
            //   // Breadcrumb nav
            //   ".breadcrumbs", ".breadcrumb", "[class*='breadcrumb']",
            //   // Framework-specific outline / "On this page" sidebars
            //   ".VPDocAsideOutline", ".DocSidebar", ".theme-doc-sidebar-container",
            //   "[class*='outline']",
            //   // Skip-link anchors (often inside <main>)
            //   "[class*='skip']",
            // ];
            // noiseSelectors.forEach((sel) => {
            //   try {
            //     (docClone as Document).querySelectorAll(sel).forEach((el) => el.remove());
            //   } catch {
            //     // Some selectors may not be supported in all browsers — skip silently.
            //   }
            // });

            const wrap = document.createElement("div");
            wrap.appendChild(document.body.cloneNode(true));
            const snapshotHtml = wrap.innerHTML;

            // Build a detached doc from the snapshot, not full-page outerHTML.
            const readDoc = document.implementation.createHTMLDocument(document.title || "");
            if (document.documentElement.lang) readDoc.documentElement.lang = document.documentElement.lang;
            if (document.documentElement.dir) readDoc.documentElement.dir = document.documentElement.dir;
            readDoc.body.innerHTML = snapshotHtml;
            const elemCount = readDoc.getElementsByTagName("*").length;
            // if (elemCount > 20_000) {
            //   return {
            //     text: document.body.innerText || "",
            //     html: snapshotHtml,
            //     title: document.title,
            //     error: "readability-skipped-too-large:" + String(elemCount),
            //   };
            // }

            const isProbably = (window as any).isProbablyReaderable;
            if (typeof isProbably === "function") {
              let probable = true;
              try {
                probable = Boolean(
                  isProbably(readDoc, {
                    minContentLength: 140,
                    minScore: 20,
                  }),
                );
              } catch {
                probable = true;
              }
              if (!probable) {
                return {
                  text: document.body.innerText || "",
                  html: readDoc.body,
                  title: document.title,
                  error: "readability-skipped-not-probable",
                };
              }
            }

            const optionsReadability = {
              debug: trace,
              // Guard against very large documents that can stall parsing.
              maxElemsToParse: 12_000,
              // Allow shorter technical pages while still filtering noise.
              charThreshold: 140,
              keepClasses: false,
            };
            // const rawDoc = document.cloneNode(true) as Document;
            const article = new ReadabilityCtor(readDoc, optionsReadability).parse();
            const sourceHtml = article?.content || readDoc.body || "";

            if (trace) {
              console.log("[hermes-sidebar][extract]", {
                elemCount,
                articleFound: Boolean(article),
                articleTextLen: (article?.textContent || "").length,
                articleHtmlLen: (article?.content || "").length,
                returnedHtmlLen: sourceHtml.length,
                rootTag: sourceHtml.tagName,
                rootId: sourceHtml.id || "",
                rootClass: (sourceHtml.className || "").toString().slice(0, 120),
                title: article?.title || document.title,
              });
            }

            return {
              text: article?.textContent || sourceHtml?.innerText || document.body.innerText || "",
              html: sourceHtml,
              title: article?.title || document.title,
              byline: article?.byline || undefined,
              dir: article?.dir || document.documentElement.dir || undefined,
              length: article?.length,
              lang: document.documentElement.lang || undefined,
              error: article ? undefined : "parse-returned-null",
            };
          } catch (e: any) {
            return {
              text: document.body.innerText,
              html: document.body.innerHTML,
              error: "readability-exception: " + String(e),
            };
          }
        },
        args: [debugTrace],
        }),
        10_000,
        [] as any[],
      );

      const r = Array.isArray(results) ? results[0]?.result : (results as any)?.result;
      if (r && (r.text || r.html)) {
        return {
          text: r.text || "",
          html: r.html || "",
          title: r.title,
          byline: r.byline,
          dir: r.dir,
          length: r.length,
          lang: r.lang,
          error: r.error,
        };
      }
    } catch {
      // Outer try failed (e.g. scripting API threw) — fall through to plain fallback.
    }
  }

  // --- Path 2: plain body.innerText fallback (5 s per-call timeout) ---
  try {
    const fallback = await withExecTimeout(
      scriptingApi.executeScript({
        target: { tabId },
        func: () => ({
          text: document.body.innerText || "",
          title: document.title,
          html: document.documentElement.outerHTML,

        }),
      }) as Promise<any[] | null>,
      5_000,
      null,
    );
    const f = fallback && (Array.isArray(fallback) ? fallback[0]?.result : (fallback as any)?.result);
    return {
      text: f?.text || "",
      title: f?.title,
      html: f?.html || document.documentElement.outerHTML,

    };
  } catch (err) {
    return { text: "", error: "fallback-failed: " + String(err) };
  }
}
