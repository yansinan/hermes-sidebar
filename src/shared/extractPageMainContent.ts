
// Canonical extractPageMainContent implementation.
export interface PageExtractionResult {
	text: string;
	markdown?: string;
	html?: string;
	title?: string;
	byline?: string;
	dir?: string;
	length?: number;
	lang?: string;
	error?: string;
}

export interface ExtractOptions {
	useReadability?: boolean;
	debugTrace?: boolean;
}

export async function extractPageMainContent(
	tabId?: number,
	opts: ExtractOptions = {},
): Promise<PageExtractionResult> {
	const { useReadability = true, debugTrace = false } = opts;
	const scriptingApi = typeof chrome === "undefined" ? undefined : (chrome as any).scripting;

	if (!scriptingApi?.executeScript || typeof tabId !== "number") {
		return { text: "" };
	}

	if (!useReadability) {
		try {
			const fallback = await scriptingApi.executeScript({
				target: { tabId },
				func: () => ({
					html: document.documentElement.outerHTML || "",
					text: document.body.innerText || "",
					title: document.title,
				}),
			}) as Promise<any[] | null>;
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

	if (useReadability) {
		try {
			await scriptingApi
				.executeScript({ target: { tabId }, files: ["readability.bundle.js"] })
				.then(() => true)
				.catch(() => false);

			const results = await scriptingApi.executeScript({
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
						const wrap = document.createElement("div");
						wrap.appendChild(document.body.cloneNode(true));
						const snapshotHtml = wrap.innerHTML;
						const readDoc = document.implementation.createHTMLDocument(document.title || "");
						if (document.documentElement.lang) readDoc.documentElement.lang = document.documentElement.lang;
						if (document.documentElement.dir) readDoc.documentElement.dir = document.documentElement.dir;
						readDoc.body.innerHTML = snapshotHtml;
						const article = new ReadabilityCtor(readDoc, {
							debug: trace,
							maxElemsToParse: 12000,
							charThreshold: 140,
							keepClasses: false,
						}).parse();
						const sourceHtml = article?.content || readDoc.body || "";
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
					} catch (e) {
						return {
							text: document.body.innerText,
							html: document.body.innerHTML,
							title: document.title,
							error: "readability-exception: " + String(e),
						};
					}
				},
				args: [debugTrace],
			});

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

	try {
		const fallback = await scriptingApi.executeScript({
			target: { tabId },
			func: () => ({
				text: document.body.innerText || "",
				title: document.title,
				html: document.documentElement.outerHTML,
			}),
		}) as Promise<any[] | null>;
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
