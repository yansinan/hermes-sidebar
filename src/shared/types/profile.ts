// Connection profile shapes.
//
// A "connection profile" is a normalized identity for a Hermes endpoint, per
// docs/product-design.md §9.6 and docs/architecture.md §3.5. Two raw API base
// URLs that normalize to the same key refer to the same profile; sessions,
// last active session id, last selected model id, and draft input are all
// scoped per profile.
//
// The API key is a credential, not part of profile identity.

export type ProfileKey = string & { readonly __brand: "ProfileKey" };

export interface ConnectionProfile {
  /** Stable key derived from the normalized API base URL. */
  key: ProfileKey;
  /** The normalized base URL (scheme + host + port + optional path prefix). */
  baseUrl: string;
  /** Short display form, e.g. `127.0.0.1:8642` or `hermes.example.com`. */
  hostShort: string;
}

export type ConnectionStatus =
  | { kind: "unknown" }
  | { kind: "connecting" }
  | { kind: "healthy"; lastCheckedAt: number }
  | {
      kind: "failed";
      lastCheckedAt: number;
      reason:
        | "network"
        | "timeout"
        | "cors"
        | "permission-denied"
        | "http-error"
        | "unknown";
      message?: string;
    };
