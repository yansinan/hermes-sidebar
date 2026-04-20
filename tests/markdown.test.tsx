import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "../src/sidepanel/components/Markdown";

describe("Markdown", () => {
  it("renders headings, lists, code blocks, and inline emphasis", () => {
    const text =
      "# Title\n\n" +
      "Some **bold** and *italic* and `inline`.\n\n" +
      "- one\n- two\n- three\n\n" +
      "1. first\n2. second\n\n" +
      "> a quote\n\n" +
      "```ts\nconst x: number = 1;\n```\n";
    render(<Markdown text={text} />);

    expect(screen.getByRole("heading", { level: 1, name: /title/i })).toBeInTheDocument();
    expect(screen.getByText(/bold/).tagName).toBe("STRONG");
    expect(screen.getByText(/italic/).tagName).toBe("EM");
    expect(screen.getByText(/inline/).tagName).toBe("CODE");
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(5);
    expect(screen.getByRole("button", { name: /copy code/i })).toBeInTheDocument();
  });

  it("renders links with safe rel and target attributes", () => {
    render(<Markdown text="see [docs](https://example.com/docs)" />);
    const link = screen.getByRole("link", { name: /docs/i }) as HTMLAnchorElement;
    expect(link.href).toBe("https://example.com/docs");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(link.rel).toContain("noreferrer");
  });
});
