import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/sidepanel/App";
import { createStubController } from "../src/sidepanel/controller-stub";
import * as selectionSummaryAction from "../src/runtime/selection-summary-action";
import * as pageBodySummaryAction from "../src/runtime/page-body-summary-action";

vi.mock("../src/runtime/selection-summary-action", async () => {
  const actual = await vi.importActual<typeof import("../src/runtime/selection-summary-action")>(
    "../src/runtime/selection-summary-action",
  );
  return {
    ...actual,
    buildSelectionSummaryDraft: vi.fn(async () => "总结占位：来自选区的内容"),
  };
});

vi.mock("../src/runtime/page-body-summary-action", async () => {
  const actual = await vi.importActual<typeof import("../src/runtime/page-body-summary-action")>(
    "../src/runtime/page-body-summary-action",
  );
  return {
    ...actual,
    buildPageBodySummaryDraft: vi.fn(async () => "总结占位：来自页面正文的内容"),
  };
});

describe("summary quick action flow", () => {
  it("fills the composer with a selection-aware summary prompt", async () => {
    const controller = createStubController();
    render(<App controller={controller} />);

    fireEvent.click(screen.getByRole("button", { name: /总结选区/i }));

    await waitFor(() => {
      expect(controller.getState().draftInput).toBe("总结占位：来自选区的内容");
    });
    expect(selectionSummaryAction.buildSelectionSummaryDraft).toHaveBeenCalledTimes(1);
  });

  it("fills the composer with a page-body-aware summary prompt", async () => {
    const controller = createStubController();
    render(<App controller={controller} />);

    fireEvent.click(screen.getByRole("button", { name: /总结正文/i }));

    await waitFor(() => {
      expect(controller.getState().draftInput).toBe("总结占位：来自页面正文的内容");
    });
    expect(pageBodySummaryAction.buildPageBodySummaryDraft).toHaveBeenCalledTimes(1);
  });
});
