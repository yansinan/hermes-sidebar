/**
 * Small id utilities used across the runtime.
 * Uses platform crypto.randomUUID if available, otherwise falls back to Math.random.
 */
export function uuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === "function") {
    return g.crypto.randomUUID();
  }
  const rand = () => Math.random().toString(16).slice(2, 10);
  return `${rand()}-${rand()}-${rand()}-${rand()}`;
}

/**
 * Generates a short id with a prefix, e.g. "msg-xxxxxxx".
 */
export function shortId(prefix: string): string {
  return `${prefix}-${uuid().slice(0, 8)}`;
}
