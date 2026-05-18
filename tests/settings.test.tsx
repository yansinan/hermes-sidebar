import { describe, it, expect } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../src/sidepanel/App";
import { createStubController } from "../src/sidepanel/controller-stub";

describe("settings drawer", () => {
  it("persists Use Runs API toggle", async () => {
    const controller = createStubController();
    render(<App controller={controller} />);

    const openSettings = screen.getAllByRole("button", { name: /settings/i })[0];
    fireEvent.click(openSettings!);

    const dialog = screen.getByRole("dialog", { name: /settings/i });
    const checkbox = within(dialog).getByRole("checkbox", {
      name: /Use Runs API for streaming/i,
    }) as HTMLInputElement;

    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    });

    expect(controller.getState().settings.useRunsApi).toBe(false);
  });
});
