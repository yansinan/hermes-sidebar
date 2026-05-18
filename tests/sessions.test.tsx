import { describe, it, expect } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../src/sidepanel/App";
import { createStubController, initialStubState } from "../src/sidepanel/controller-stub";
import { DEFAULT_SETTINGS } from "../src/shared/types/settings";

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
      fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
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
      fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
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
      fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    });

    fireEvent.click(screen.getByRole("button", { name: /^sessions \(1\)$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete to delete$/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm delete to delete/i }));

    expect(controller.getState().sessions).toHaveLength(0);
    expect(controller.getState().activeSessionId).toBeNull();
  });

  it("shows queued/running phase labels in the session list", () => {
    const seeded = initialStubState({
      ...DEFAULT_SETTINGS,
      defaultModelId: "m1",
    });
    const now = Date.now();
    seeded.connectionStatus = { kind: "healthy", lastCheckedAt: now };
    seeded.models = [{ id: "m1" }];
    seeded.sessions = [
      {
        id: "s-running",
        profileKey: seeded.activeProfile.key,
        title: "running session",
        createdAt: now - 10_000,
        updatedAt: now,
        modelId: "m1",
        messages: [],
      },
      {
        id: "s-queued",
        profileKey: seeded.activeProfile.key,
        title: "queued session",
        createdAt: now - 20_000,
        updatedAt: now - 1_000,
        modelId: "m1",
        messages: [],
      },
    ];
    seeded.activeSessionId = "s-running";
    seeded.sessionPhases = {
      "s-running": "running",
      "s-queued": "queued",
    };

    const controller = createStubController({ initial: seeded });
    render(<App controller={controller} />);

    fireEvent.click(screen.getByRole("button", { name: /^sessions \(2\)$/i }));
    const dialog = screen.getByRole("dialog", { name: /sessions/i });
    expect(within(dialog).getByText("Running")).toBeInTheDocument();
    expect(within(dialog).getByText("Queued")).toBeInTheDocument();
  });
});

