/**
 * The typed API client.
 *
 * The access token lives in a module variable - in memory only, never in localStorage or a
 * readable cookie, so an injected script cannot steal a usable credential. Persistence
 * comes from the httpOnly refresh cookie instead, which JavaScript cannot read at all.
 *
 * A 401 triggers one refresh attempt and one replay. Concurrent 401s share a single refresh
 * promise, so ten requests failing at once produce one refresh rather than ten - which
 * matters because refresh tokens rotate, and ten parallel rotations would look exactly like
 * token theft and burn the whole family.
 */
import type { ApiErrorBody } from "@luck-cays/shared";

const BASE = "/api";

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

/** Called when a refresh fails, so the auth store can clear itself and redirect. */
let onSessionLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function onSessionExpired(handler: () => void): void {
  onSessionLost = handler;
}

/** An error carrying the API's machine-readable code, so callers can branch on it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Field-level validation messages, when the failure was a validation failure. */
  get fieldErrors(): Record<string, string> {
    return this.code === "VALIDATION_FAILED" && this.details && typeof this.details === "object"
      ? (this.details as Record<string, string>)
      : {};
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Set for the refresh call itself, so a failed refresh cannot recurse. */
  skipRefresh?: boolean;
  signal?: AbortSignal;
}

async function parse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A non-JSON body means something upstream failed before reaching the app.
    throw new ApiError(
      response.status,
      "BAD_RESPONSE",
      "The server returned an unreadable response",
    );
  }
}

async function refreshSession(): Promise<boolean> {
  // One refresh at a time: rotation means parallel refreshes would revoke each other.
  refreshing ??= (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) return false;

      const data = (await response.json()) as { accessToken?: string };
      if (typeof data.accessToken !== "string") return false;

      accessToken = data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Release the gate before the next caller checks it.
      queueMicrotask(() => {
        refreshing = null;
      });
    }
  })();

  return refreshing;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> =>
    fetch(BASE + path, {
      method: options.method ?? "GET",
      // Always include credentials: the refresh cookie is needed on the auth routes and
      // harmless elsewhere, since it is scoped to /api/auth.
      credentials: "include",
      headers: {
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });

  let response = await send();

  // One refresh, one replay. Never a loop.
  if (response.status === 401 && !options.skipRefresh) {
    if (await refreshSession()) {
      response = await send();
    } else {
      accessToken = null;
      onSessionLost?.();
    }
  }

  const payload = await parse(response);

  if (!response.ok) {
    const error = (payload as ApiErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/**
 * A fresh idempotency key for anything that moves chips.
 *
 * The key belongs to the ATTEMPT, not the retry: a caller generates one key and reuses it
 * across retries of the same logical bet, which is what makes a dropped response safe.
 */
export function idempotencyKey(prefix = "web"): string {
  const random =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2).padEnd(16, "0");
  return `${prefix}-${Date.now().toString(36)}-${random}`.slice(0, 100);
}
