// Settings shape (docs/product-design.md §6.4, §9.1; docs/architecture.md §3.6).
//
// The API key is a credential: it is passed to the API client as a `Bearer`
// token and is never logged. Where it is stored (`chrome.storage.local` vs
// `chrome.storage.session`) is product-design open question 7.

export type EnterBehavior = "send" | "newline";

export interface Settings {
  /** Raw user-entered base URL. Normalization into a ProfileKey happens elsewhere. */
  apiBaseUrl: string;
  /** Empty string means "no key configured" — omit Authorization header. */
  apiKey: string;
  /** Default model id used when creating a new draft session. */
  defaultModelId: string;
  enterBehavior: EnterBehavior;
  streamingEnabled: boolean;
  /** When on, attach `X-Hermes-Session-Id` if a `serverSessionRef` is recorded. */
  reuseServerSession: boolean;
  /** When on, include `Idempotency-Key` on sends (always on in v1 defaults). */
  sendIdempotencyKey: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBaseUrl: "http://127.0.0.1:8642",
  apiKey: "",
  defaultModelId: "",
  enterBehavior: "send",
  streamingEnabled: true,
  reuseServerSession: false,
  sendIdempotencyKey: true,
};
