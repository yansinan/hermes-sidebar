import { describe, expect, it } from "vitest";
import { buildPageBodySummaryDraft } from "../src/runtime/page-body-summary-action";

describe("buildPageBodySummaryDraft", () => {
  it("reads the page body through injected deps and builds a body-aware prompt", async () => {
    const prompt = await buildPageBodySummaryDraft("", {
      queryActiveTab: async () => ({
        tabId: 11,
        title: "Article title",
        url: "https://example.com/article",
      }),
      readPageBody: async () => "A sentence from the page body.",
    });

    expect(prompt).toContain("页面正文：");
    expect(prompt).toContain("A sentence from the page body.");
  });
});
