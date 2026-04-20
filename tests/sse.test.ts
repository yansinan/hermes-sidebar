import { describe, it, expect } from "vitest";
import { SseParser } from "../src/api/sse";

describe("SseParser", () => {
  it("parses a single default-event frame", () => {
    const p = new SseParser();
    const frames = p.push('data: {"hello":"world"}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ event: "message", data: '{"hello":"world"}' });
  });

  it("concatenates multiple data: lines with \\n", () => {
    const p = new SseParser();
    const frames = p.push("data: line1\ndata: line2\n\n");
    expect(frames[0]!.data).toBe("line1\nline2");
  });

  it("recognizes an explicit event: name", () => {
    const p = new SseParser();
    const frames = p.push(
      "event: hermes.tool.progress\ndata: {}\n\n",
    );
    expect(frames[0]!.event).toBe("hermes.tool.progress");
  });

  it("handles split chunks across writes", () => {
    const p = new SseParser();
    expect(p.push("data: pa")).toHaveLength(0);
    expect(p.push("rtial")).toHaveLength(0);
    const frames = p.push("\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe("partial");
  });

  it("ignores comment lines and retry:", () => {
    const p = new SseParser();
    const frames = p.push(": comment\nretry: 1000\ndata: hi\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toBe("hi");
  });

  it("supports CRLF line endings", () => {
    const p = new SseParser();
    const frames = p.push("data: one\r\n\r\ndata: two\r\n\r\n");
    expect(frames).toHaveLength(2);
    expect(frames[0]!.data).toBe("one");
    expect(frames[1]!.data).toBe("two");
  });

  it("flushes a trailing frame without a blank separator", () => {
    const p = new SseParser();
    expect(p.push("data: last")).toHaveLength(0);
    const flushed = p.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.data).toBe("last");
  });
});
