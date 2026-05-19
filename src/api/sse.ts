// SSE frame parser (docs/api-contract.md §6.1).
//
// A small pure state machine that converts `text/event-stream` bytes into
// frames. The implementation does not use `EventSource` — the v1 client uses
// `fetch` + a ReadableStream reader per §6.1 so that auto-reconnect is
// explicitly disabled and `AbortController` governs cancellation.

export interface SseFrame {
  event: string; // "message" when no explicit `event:` line
  data: string; // concatenated payload with `\n` between `data:` lines
  id?: string;
}

/**
 * Incremental SSE parser. Feed it chunks; it yields complete frames as soon as
 * a blank line separator is seen. Comment lines (`:`) and `retry:` are
 * ignored. CRLF and LF line endings are both supported.
 */
export class SseParser {
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];
  private lastId: string | undefined = undefined;

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];

    for (;;) {
      const idx = this.findLineEnd(this.buffer);
      if (idx === null) break;
      const line = this.buffer.slice(0, idx.lineEnd);
      this.buffer = this.buffer.slice(idx.next);

      if (line.length === 0) {
        // Blank line — dispatch the in-progress frame if any.
        if (this.dataLines.length > 0 || this.eventName.length > 0) {
          const frame: SseFrame = {
            event: this.eventName || "message",
            data: this.dataLines.join("\n"),
          };
          if (this.lastId !== undefined) frame.id = this.lastId;
          frames.push(frame);
        }
        this.eventName = "";
        this.dataLines = [];
        continue;
      }

      if (line.startsWith(":")) {
        const comment = line.slice(1).replace(/^ /, "");
        frames.push({ event: "comment", data: comment });
        continue;
      }

      const colon = line.indexOf(":");
      let field: string;
      let value: string;
      if (colon === -1) {
        field = line;
        value = "";
      } else {
        field = line.slice(0, colon);
        value = line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
      }

      switch (field) {
        case "event":
          this.eventName = value;
          break;
        case "data":
          this.dataLines.push(value);
          break;
        case "id":
          this.lastId = value;
          break;
        case "retry":
          // v1 does not use retry intervals (no auto-reconnect); ignored.
          break;
        default:
          // Unknown fields are ignored per the SSE spec.
          break;
      }
    }

    return frames;
  }

  /** Returns any trailing complete frame if the stream ended without a blank
   * separator. Callers should invoke this once when the reader signals EOF. */
  flush(): SseFrame[] {
    if (this.buffer.length > 0) {
      // Fabricate a trailing newline to drain the last line.
      const tail = this.buffer;
      this.buffer = "";
      return this.push(tail + "\n\n");
    }
    if (this.dataLines.length > 0) {
      const frame: SseFrame = {
        event: this.eventName || "message",
        data: this.dataLines.join("\n"),
      };
      this.eventName = "";
      this.dataLines = [];
      return [frame];
    }
    return [];
  }

  private findLineEnd(s: string): { lineEnd: number; next: number } | null {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0x0a /* \n */) return { lineEnd: i, next: i + 1 };
      if (c === 0x0d /* \r */) {
        if (i + 1 < s.length && s.charCodeAt(i + 1) === 0x0a) {
          return { lineEnd: i, next: i + 2 };
        }
        return { lineEnd: i, next: i + 1 };
      }
    }
    return null;
  }
}
