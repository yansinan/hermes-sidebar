import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickActionBar } from "../src/sidepanel/components/QuickActionBar";

describe("QuickActionBar", () => {
  it("renders a summary action button and invokes the handler", () => {
    const onSummarize = vi.fn();

    render(<QuickActionBar onSummarize={onSummarize} />);

    const button = screen.getByRole("button", { name: /总结/i });
    fireEvent.click(button);

    expect(onSummarize).toHaveBeenCalledTimes(1);
  });
});
