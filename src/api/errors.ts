// Error vocabulary the controllers and UI speak (docs/api-contract.md §9.1).
//
// Mapping from HTTP/network outcomes to this small set lives in the API
// client. Keeping it here lets tests assert classifications independently of
// UI copy.

export type ApiErrorClass =
  | "bad-request"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "timeout"
  | "conflict"
  | "too-large"
  | "rate-limited"
  | "client-error"
  | "server-error"
  | "network"
  | "cors"
  | "permission-denied"
  | "stopped"
  | "stream-interrupted";

export interface ApiError {
  kind: ApiErrorClass;
  status?: number;
  /** Short message extracted from the server (if small) or derived locally. */
  message?: string;
}

export function classifyHttpStatus(status: number): ApiErrorClass {
  if (status === 400) return "bad-request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 409) return "conflict";
  if (status === 413) return "too-large";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server-error";
  if (status >= 400) return "client-error";
  // 2xx should not reach this function; treat anything else as server-error.
  return "server-error";
}

export async function extractShortMessage(
  res: Response,
): Promise<string | undefined> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return undefined;
  try {
    const body = (await res.clone().json()) as unknown;
    if (body && typeof body === "object") {
      const o = body as Record<string, unknown>;
      const err = o["error"];
      if (err && typeof err === "object") {
        const m = (err as Record<string, unknown>)["message"];
        if (typeof m === "string" && m.length <= 200) return m;
      }
      const m = o["message"];
      if (typeof m === "string" && m.length <= 200) return m;
    }
  } catch {
    // ignore
  }
  return undefined;
}
