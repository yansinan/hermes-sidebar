import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/sidepanel/App";
import { createStubController } from "../src/sidepanel/controller-stub";

vi.mock("../src/shared/build-info", () => ({
  BUILD_INFO: {
    sha: "abc1234",
    builtAt: "2026-05-12T08:30:00.000Z",
    label: "dist abc1234",
  },
}));

describe("top bar build hint", () => {
  it("shows the current dist build label so we can confirm a fresh bundle is loaded", () => {
    render(<App controller={createStubController()} />);

    expect(screen.getByText(/dist abc1234/i)).toBeInTheDocument();
    expect(screen.getByTitle(/2026-05-12T08:30:00.000Z/)).toBeInTheDocument();
  });
});
