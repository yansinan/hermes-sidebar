/**
 * Extract selected DOM content from a specific tab.
 * This function mirrors the context menu "所选内容" extraction logic.
 */
export async function extractSelectionDom(
  tabId: number,
  selectedTextFallback: string,
): Promise<{ html: string; text: string; extractStatus: "success" | "partial" | "failed" }> {
  const scriptingApi = typeof chrome === "undefined" ? undefined : chrome.scripting;
  if (!scriptingApi?.executeScript) {
    return { html: "", text: selectedTextFallback, extractStatus: "failed" };
  }

  try {
    const results = await scriptingApi.executeScript({
      target: { tabId },
      func: () => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
          return { html: "", text: "" };
        }

        const wrappers: string[] = [];
        for (let i = 0; i < selection.rangeCount; i += 1) {
          const range = selection.getRangeAt(i);
          const container = document.createElement("div");
          container.appendChild(range.cloneContents());
          wrappers.push(container.innerHTML);
        }

        return {
          html: wrappers.join("\n"),
          text: (selection.toString() || "").trim(),
        };
      },
    });

    const payload = (Array.isArray(results)
      ? results[0]?.result
      : (results as any)?.result) as { html?: string; text?: string };

    const html = (payload?.html ?? "").trim();
    const text = (payload?.text ?? "").trim() || selectedTextFallback;

    if (html) {
      return { html, text, extractStatus: "success" };
    }
    if (text) {
      return { html: "", text, extractStatus: "partial" };
    }
    return { html: "", text: selectedTextFallback, extractStatus: "failed" };
  } catch (err) {
    return {
      html: "",
      text: selectedTextFallback,
      extractStatus: selectedTextFallback ? "partial" : "failed",
    };
  }
}
