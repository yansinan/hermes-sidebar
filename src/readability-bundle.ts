import { Readability, isProbablyReaderable } from "@mozilla/readability";

// Expose Readability to the page context as `globalThis.Readability` so
// subsequent injected functions can access it via `window.Readability`.
;(globalThis as any).Readability = Readability;
;(globalThis as any).isProbablyReaderable = isProbablyReaderable;

export {};
