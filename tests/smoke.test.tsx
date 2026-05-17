import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/sidepanel/App";
import { createStubController } from "../src/sidepanel/controller-stub";
import { DEFAULT_SETTINGS } from "../src/shared/types/settings";

describe("side panel scaffold", () => {
  it("renders top, middle, and bottom regions with the empty state", () => {
    const controller = createStubController();
    render(<App controller={controller} />);

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main", { name: /conversation/i })).toBeInTheDocument();
    expect(
      screen.getByRole("contentinfo", { name: /compose message/i }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: /welcome to hermes-sidebar/i }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/ask hermes anything/i)).toBeInTheDocument();
  });

  it("has an initial connection profile derived from the default API base URL", () => {
    const controller = createStubController();
    const state = controller.getState();
    expect(state.activeProfile.baseUrl).toBe(DEFAULT_SETTINGS.apiBaseUrl);
    expect(state.activeProfile.hostShort).toMatch(/127\.0\.0\.1:8642/);
    expect(state.connectionStatus.kind).toBe("unknown");
  });

  it("exposes a subscribe/getState seam controllers will share with the runtime", () => {
    const controller = createStubController();
    let calls = 0;
    const unsubscribe = controller.subscribe(() => {
      calls += 1;
    });
    controller.setDraftInput("hello");
    expect(controller.getState().draftInput).toBe("hello");
    expect(calls).toBe(1);
    unsubscribe();
    controller.setDraftInput("world");
    expect(calls).toBe(1);
  });
});
