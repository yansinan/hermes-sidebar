import { describe, it, expect } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../src/sidepanel/App";
import { createStubController } from "../src/sidepanel/controller-stub";

describe("session drawer", () => {
  it("creates a new draft, sends, and lists the session in the drawer", async () => {
    const controller = createStubController();
    render(<App controller={controller} />);
    await act(async () => {
      await controller.recheckHealth();
    });

    // Promote draft via send.
    const ta = screen.getByPlaceholderText(/ask hermes anything/i);
    fireEvent.change(ta, { target: { value: "first message" } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter" });
    });

    // Open Sessions drawer (the icon-only button labelled "Sessions (1)").
    const sessionsButton = screen.getByRole("button", { name: /^sessions \(\d+\)$/i });
    fireEvent.click(sessionsButton);

    // Drawer rendered as dialog with the session title.
    const dialog = screen.getByRole("dialog", { name: /sessions/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/first message/i)).toBeInTheDocument();
  });

  it("renames a session inline", async () => {
    const controller = createStubController();
    render(<App controller={controller} />);
    await act(async () => {
      await controller.recheckHealth();
    });
    const ta = screen.getByPlaceholderText(/ask hermes anything/i);
    fireEvent.change(ta, { target: { value: "hi" } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter" });
    });

    fireEvent.click(screen.getByRole("button", { name: /^sessions \(1\)$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^rename/i }));

    const editInput = screen.getByLabelText(/rename session/i) as HTMLInputElement;
    fireEvent.change(editInput, { target: { value: "Renamed" } });
    fireEvent.keyDown(editInput, { key: "Enter" });

    expect(controller.getState().sessions[0].title).toBe("Renamed");
  });

  it("deletes a session via the two-step inline confirmation", async () => {
    const controller = createStubController();
    render(<App controller={controller} />);
    await act(async () => {
      await controller.recheckHealth();
    });
    const ta = screen.getByPlaceholderText(/ask hermes anything/i);
    fireEvent.change(ta, { target: { value: "to delete" } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter" });
    });

    fireEvent.click(screen.getByRole("button", { name: /^sessions \(1\)$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete to delete$/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm delete to delete/i }));

    expect(controller.getState().sessions).toHaveLength(0);
    expect(controller.getState().activeSessionId).toBeNull();
  });
});

