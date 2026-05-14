import { describe, it, expect } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../src/sidepanel/App";
import { createStubController } from "../src/sidepanel/controller-stub";

async function flushHealth() {
  // The stub's recheckHealth resolves on a 30ms setTimeout; let it settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

describe("composer flow", () => {
  it("disables Send when input is empty and enables it once non-empty", async () => {
    const controller = createStubController();
    render(<App controller={controller} />);
    await act(async () => {
      await controller.recheckHealth();
    });

    const send = screen.getByRole("button", { name: /^send$/i });
    expect(send).toBeDisabled();

    const ta = screen.getByPlaceholderText(/ask hermes anything/i);
    fireEvent.change(ta, { target: { value: "hello" } });

    expect(screen.getByRole("button", { name: /^send$/i })).toBeEnabled();
  });

  it("Enter sends; Shift+Enter inserts a newline", async () => {
    const controller = createStubController();
    render(<App controller={controller} />);
    await act(async () => {
      await controller.recheckHealth();
    });

    const ta = screen.getByPlaceholderText(
      /ask hermes anything/i,
    ) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hi" } });

    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    // Shift+Enter shouldn't trigger a send — draft remains.
    expect(controller.getState().draftInput).toBe("hi");
    expect(controller.getState().sessions).toHaveLength(0);

    fireEvent.keyDown(ta, { key: "Enter" });
    // After send, the session has been promoted and the draft cleared.
    expect(controller.getState().sessions).toHaveLength(1);
    expect(controller.getState().draftInput).toBe("");
  });

  it("disables input when no models are available", () => {
    const controller = createStubController({ seededModels: [] });
    render(<App controller={controller} />);
    const ta = screen.getByPlaceholderText(/ask hermes anything/i);
    expect(ta).toBeDisabled();
  });

  it("shows the model and char count caption", async () => {
    const controller = createStubController();
    render(<App controller={controller} />);
    await flushHealth();
    const ta = screen.getByPlaceholderText(/ask hermes anything/i);
    fireEvent.change(ta, { target: { value: "abcd" } });
    expect(screen.getByText(/4 chars/)).toBeInTheDocument();
    expect(screen.getByText(/Model:/)).toBeInTheDocument();
  });

  it("inserts {{markdown}} at current caret position", async () => {
    const controller = createStubController();
    render(<App controller={controller} />);
    await flushHealth();

    controller.setDraftInput("abcd");
    controller.setComposerSelection(2, 2);
    controller.insertMarkdownTokenAtCaret();

    expect(controller.getState().draftInput).toBe("ab{{markdown}}cd");
  });
});
