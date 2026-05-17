import { describe, expect, it } from "vitest";
import { buildSummaryPrompt } from "../src/shared/domain/prompt-templates";

describe("prompt templates", () => {
  it("builds a concise Chinese summary prompt", () => {
    expect(buildSummaryPrompt()).toBe("请用中文总结下面内容，给出 3 个要点：\n\n");
  });
});
