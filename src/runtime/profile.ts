// Profile normalization (docs/product-design.md §9.6; docs/architecture.md §3.5).
//
// Two raw API base URLs that normalize to the same key refer to the same
// profile; sessions, last active session id, last selected model id, and draft
// input are scoped per profile. v1 performs no DNS canonicalization: `127.0.0.1`
// and `localhost` are intentionally different profiles.

import type { ConnectionProfile, ProfileKey } from "../shared/profile";

export interface ParsedBaseUrl {
  baseUrl: string;
  hostShort: string;
  key: ProfileKey;
}

/**
 * Normalize a user-entered base URL. Returns `null` if the input is not a
 * parseable http(s) URL. The profile key is the normalized base URL itself:
 * scheme + host + port + optional path prefix, with any trailing slash removed.
 */
export function normalizeBaseUrl(raw: string): ParsedBaseUrl | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  // Canonicalize: drop search, drop hash, trim trailing slash from the path.
  u.search = "";
  u.hash = "";
  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "/") path = "";

  const isDefaultPort =
    (u.protocol === "http:" && (u.port === "" || u.port === "80")) ||
    (u.protocol === "https:" && (u.port === "" || u.port === "443"));

  const portSegment = u.port && !isDefaultPort ? `:${u.port}` : "";
  const baseUrl = `${u.protocol}//${u.hostname}${portSegment}${path}`;
  const hostShort = u.port && !isDefaultPort
    ? `${u.hostname}:${u.port}`
    : u.hostname;

  return {
    baseUrl,
    hostShort,
    key: baseUrl as ProfileKey,
  };
}

/**
 * Normalize a base URL into a `ConnectionProfile`. Falls back to a best-effort
 * profile when the URL is unparseable, so we can still render something when a
 * user has typed a partial value.
 */
export function toProfile(raw: string): ConnectionProfile {
  const parsed = normalizeBaseUrl(raw);
  if (parsed) {
    return {
      key: parsed.key,
      baseUrl: parsed.baseUrl,
      hostShort: parsed.hostShort,
    };
  }
  const fallback = raw.trim();
  return {
    key: fallback as ProfileKey,
    baseUrl: fallback,
    hostShort: fallback || "—",
  };
}

/** Same-profile predicate used by the connection-change rules in §9.6. */
export function sameProfile(a: string, b: string): boolean {
  const na = normalizeBaseUrl(a);
  const nb = normalizeBaseUrl(b);
  if (!na || !nb) return a.trim() === b.trim();
  return na.key === nb.key;
}
