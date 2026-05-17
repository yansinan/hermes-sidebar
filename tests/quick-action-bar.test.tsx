import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickActionBar } from "../src/sidepanel/components/composer/QuickActionBar";

describe("QuickActionBar", () => {
  it("renders both summary actions and invokes the correct handler", () => {
    const onSummarizeSelection = vi.fn();
    const onSummarizePageBody = vi.fn();

    render(
      <QuickActionBar
        onSummarizeSelection={onSummarizeSelection}
        onSummarizePageBody={onSummarizePageBody}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /总结选区/i }));
    fireEvent.click(screen.getByRole("button", { name: /总结正文/i }));

    expect(onSummarizeSelection).toHaveBeenCalledTimes(1);
    expect(onSummarizePageBody).toHaveBeenCalledTimes(1);
  });
});
