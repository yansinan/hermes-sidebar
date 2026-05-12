import { describe, expect, it, beforeEach, vi } from "vitest";
import { buildPageBodySummaryDraft } from "../src/runtime/page-body-summary-action";

describe("buildPageBodySummaryDraft", () => {
  beforeEach(() => {
    // Mock chrome.scripting for testing
    (globalThis as any).chrome = {
      scripting: {
        executeScript: vi.fn(async () => [
          {
            result: {
              text: "A sentence from the page body.",
              html: "<p>A sentence from the page body.</p>",
              title: "Article title",
            },
          },
        ]),
      },
      tabs: {
        query: vi.fn(async () => [
          {
            id: 11,
            title: "Article title",
            url: "https://example.com/article",
          },
        ]),
      },
    };
  });

  it("reads the page body and builds a body-aware prompt with HTML structure", async () => {
    const prompt = await buildPageBodySummaryDraft("", {
      queryActiveTab: async () => ({
        tabId: 11,
        title: "Article title",
        url: "https://example.com/article",
      }),
    });

    expect(prompt).toContain("页面正文");
    expect(prompt).toContain("A sentence from the page body.");
    expect(prompt).toContain("HTML 结构");
  });
});
