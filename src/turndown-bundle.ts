// @ts-ignore
import TurndownService from "turndown";
// @ts-ignore
import { gfm } from "turndown-plugin-gfm";

// Expose a factory function that creates a TurndownService instance
// with the GFM plugin (tables, strikethrough, task lists) already applied.
// Calling TurndownService.use() directly would fail — `use` is an instance method.
(globalThis as any).createTurndownService = (options?: object) => {
  const instance = new TurndownService(options ?? {});
  instance.use(gfm);
  return instance;
};

// Also expose the class itself for callers that need instanceof checks.
(globalThis as any).TurndownService = TurndownService;

export {};
