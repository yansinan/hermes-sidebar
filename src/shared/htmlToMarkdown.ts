
function fallbackHtmlToMarkdown(html: string): string {
	let text = html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
		.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
		.replace(/<a[^>]*href="#\w*"[^>]*>(?:skip[^<]*)<\/a>/gi, "")
		.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) =>
			"\n" + "#".repeat(parseInt(n)) + " " + t.replace(/<[^>]*>/g, "").trim() + "\n",
		)
		.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
		.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
		.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "_$1_")
		.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "_$1_")
		.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "```$1```")
		.replace(/<a[^>]*href=\"([^\"]*)\"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
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

export async function htmlToMarkdown(html: string, tabId?: number): Promise<string> {
	const normalized = (html ?? "").trim();
	if (!normalized) return "";

	if (typeof tabId === "number") {
		try {
			const scriptingApi = typeof chrome === "undefined" ? undefined : chrome.scripting;
			if (!scriptingApi?.executeScript) {
				return fallbackHtmlToMarkdown(normalized);
			}

			await scriptingApi
				.executeScript({ target: { tabId }, files: ["turndown.bundle.js"] })
				.catch(() => {});

			const results = await (scriptingApi as any).executeScript({
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
						turndown.remove(["script", "style", "noscript", "nav", "footer", "iframe"]);
						const parser = new DOMParser();
						const doc = parser.parseFromString(text, "text/html");
						let md = text;
						try {
							md = turndown.turndown(doc.body.innerHTML).trim();
						} catch (e) {
							return { text: "[markdown-converter] Turndown conversion error:" + String(e) + "\n md=="+ doc.body.innerText, error: String(e) };
						}
						return { text: md };
					} catch (e) {
						return { text: "htmlToMarkdown() error:" + String(e) + "\n text=="+ text, error: String(e) };
					}
				},
				args: [normalized],
			});

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
