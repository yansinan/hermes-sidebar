// Small id utilities used across the runtime.
//
// v1 does not ship a uuid dependency; these helpers lean on the platform's
// `crypto.randomUUID` when available and fall back to a simple random id for
// non-browser test environments.

export function uuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === "function") {
    return g.crypto.randomUUID();
  }
  const rand = () => Math.random().toString(16).slice(2, 10);
  return `${rand()}-${rand()}-${rand()}-${rand()}`;
}

export function shortId(prefix: string): string {
  return `${prefix}-${uuid().slice(0, 8)}`;
}
